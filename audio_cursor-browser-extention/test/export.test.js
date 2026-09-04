// node --test test/export.test.js
//
// The export pipeline is pure JS (no DOM, no extension APIs), so it is tested
// here with fake connections. The shared chunkers register themselves on
// globalThis when required, exactly as the bundle does.

const test = require('node:test');
const assert = require('node:assert/strict');

require('../src/shared/chunk.js');
require('../src/shared/cloudTts.js');
const Pipeline = require('../src/shared/exportPipeline.js');

const {
    segmentText, synthesizeSegments, concatBytes,
    CancelledError, EXPORT_CHUNK_CHARS, RETRY_SPLIT_CHARS
} = Pipeline;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const bytesOf = (text) => new TextEncoder().encode(text);
const decode = (r) => new TextDecoder().decode(concatBytes(r.parts));

function longText(sentences) {
    let s = '';
    for (let i = 0; i < sentences; i++) {
        s += `Sentence number ${i} says something moderately interesting about the topic. `;
    }
    return s;
}

/**
 * A fake connection factory. `speak` consults `behaviour(text, callNumber)`:
 * return 'ok' to answer, or a string to throw as an error message.
 */
function fakeLanes(behaviour = () => 'ok', { speakMs = 0 } = {}) {
    const stats = { opened: 0, closed: 0, open: 0, peakOpen: 0, calls: 0, perLane: [] };
    const openLane = async () => {
        stats.opened++;
        stats.open++;
        stats.peakOpen = Math.max(stats.peakOpen, stats.open);
        const lane = { id: stats.opened, spoken: 0, closed: false };
        stats.perLane.push(lane);
        return {
            speak: async (text) => {
                if (lane.closed) throw new Error('spoke on a closed connection');
                const n = ++stats.calls;
                if (speakMs) await wait(speakMs);
                const verdict = behaviour(text, n);
                if (verdict !== 'ok') throw new Error(verdict);
                lane.spoken++;
                return bytesOf(text);
            },
            close: () => {
                if (lane.closed) return;
                lane.closed = true;
                stats.closed++;
                stats.open--;
            }
        };
    };
    return { openLane, stats };
}

// ── segmentText ──────────────────────────────────────────────────────────────

test('neural segments cover the whole text, in order, within the size cap', () => {
    const text = longText(400); // ~30 KB
    const segments = segmentText(text, 'neural');
    assert.ok(segments.length > 30, `expected many segments, got ${segments.length}`);
    for (const s of segments) {
        assert.ok(s.length <= EXPORT_CHUNK_CHARS, `segment too long: ${s.length}`);
        assert.ok(s.trim().length > 0, 'whitespace-only segment');
    }
    assert.equal(segments.join(''), text, 'segments must reassemble to the original text');
});

test('cloud segments stay under the endpoint limit and keep every word', () => {
    const text = longText(120);
    const segments = segmentText(text, 'cloud');
    for (const s of segments) {
        assert.ok(s.length <= globalThis.CloudTTS.CLOUD_MAX_CHARS, `segment too long: ${s.length}`);
    }
    const words = (str) => str.split(/\s+/).filter(Boolean);
    assert.deepEqual(words(segments.join(' ')), words(text));
});

test('empty or whitespace text yields no segments', () => {
    assert.deepEqual(segmentText('', 'neural'), []);
    assert.deepEqual(segmentText('   \n\t ', 'neural'), []);
    assert.deepEqual(segmentText(null, 'cloud'), []);
});

// ── lanes ────────────────────────────────────────────────────────────────────

test('audio comes back in document order however the lanes interleave', async () => {
    const segments = Array.from({ length: 25 }, (_, i) => `seg${i}.`);
    const { openLane } = fakeLanes(() => 'ok', { speakMs: 1 });
    const result = await synthesizeSegments({ segments, openLane, lanes: 3, split: null });
    assert.equal(decode(result), segments.join(''));
    assert.deepEqual(result.skipped, []);
});

test('each lane reuses one connection for every segment it speaks', async () => {
    const segments = Array.from({ length: 30 }, (_, i) => `seg${i}.`);
    const { openLane, stats } = fakeLanes(() => 'ok', { speakMs: 1 });
    await synthesizeSegments({ segments, openLane, lanes: 2, split: null });
    assert.equal(stats.opened, 2, 'one connection per lane, not one per segment');
    assert.ok(stats.peakOpen <= 2, `peak open connections ${stats.peakOpen}`);
    assert.equal(stats.open, 0, 'every connection is closed at the end');
    assert.equal(stats.perLane.reduce((n, l) => n + l.spoken, 0), 30);
});

test('lanes never exceed the requested width, and one lane is used for one segment', async () => {
    const { openLane, stats } = fakeLanes(() => 'ok', { speakMs: 2 });
    await synthesizeSegments({ segments: ['only.'], openLane, lanes: 4, split: null });
    assert.equal(stats.opened, 1);
    assert.equal(stats.open, 0);
});

// ── failure and recovery ─────────────────────────────────────────────────────

test('a failed request throws its connection away and the retry gets a fresh one', async () => {
    let failed = false;
    const { openLane, stats } = fakeLanes((text) => {
        if (text === 'b.' && !failed) { failed = true; return 'Edge TTS closed unexpectedly (code 1006)'; }
        return 'ok';
    });
    const result = await synthesizeSegments({
        segments: ['a.', 'b.', 'c.'],
        openLane, lanes: 1, backoff: [1], split: null
    });
    assert.equal(decode(result), 'a.b.c.');
    assert.equal(stats.opened, 2, 'the poisoned connection was replaced, not reused');
    assert.equal(stats.open, 0);
});

test('retries are reported and give up after the configured number of attempts', async () => {
    const notes = [];
    const { openLane } = fakeLanes(() => 'service unavailable');
    await assert.rejects(
        synthesizeSegments({
            segments: ['short.'],
            openLane, lanes: 1, attempts: 3, backoff: [1, 1], split: null,
            allowSkips: false, waitingNoticeMs: 0,
            onNotice: (n) => notes.push(n)
        }),
        /service unavailable/
    );
    assert.equal(notes.length, 2, 'two retries reported before the third attempt failed');
    assert.deepEqual(notes.map((n) => n.attempt), [2, 3]);
    assert.equal(notes[0].kind, 'retry');
    assert.equal(notes[0].segment, 1);
});

test('a long segment the service refuses is split, and the pieces are kept in order', async () => {
    const big = longText(20).trim();
    assert.ok(big.length > RETRY_SPLIT_CHARS);
    const notes = [];
    const { openLane } = fakeLanes((text) => (text.length > RETRY_SPLIT_CHARS ? 'SSML too long' : 'ok'));
    const result = await synthesizeSegments({
        segments: ['first.', big, 'last.'],
        openLane, lanes: 1, attempts: 2, backoff: [1],
        onNotice: (n) => notes.push(n)
    });
    assert.equal(decode(result), 'first.' + big + 'last.');
    assert.deepEqual(result.skipped, []);
    assert.ok(notes.some((n) => n.kind === 'split' && n.segment === 2));
});

test('progress counts each finished segment once', async () => {
    const segments = Array.from({ length: 12 }, (_, i) => `s${i}.`);
    const seen = [];
    const { openLane } = fakeLanes(() => 'ok', { speakMs: 1 });
    await synthesizeSegments({
        segments, openLane, lanes: 3, split: null,
        onProgress: (done, total) => seen.push([done, total])
    });
    assert.deepEqual(seen.map((p) => p[0]), segments.map((_, i) => i + 1));
    assert.ok(seen.every((p) => p[1] === 12));
});

// ── cancelling and stalling ──────────────────────────────────────────────────

test('cancelling stops promptly, rejects with CancelledError and closes connections', async () => {
    let cancelled = false;
    let spoken = 0;
    const { openLane, stats } = fakeLanes(() => { spoken++; if (spoken === 4) cancelled = true; return 'ok'; },
        { speakMs: 1 });
    await assert.rejects(
        synthesizeSegments({
            segments: Array.from({ length: 40 }, (_, i) => `s${i}.`),
            openLane, lanes: 2, split: null,
            isCancelled: () => cancelled
        }),
        (err) => err instanceof CancelledError && err.cancelled === true
    );
    assert.ok(spoken <= 8, `spoke ${spoken} segments after cancelling`);
    assert.equal(stats.open, 0, 'connections are closed on the way out');
});

test('a request that never answers fails the export instead of hanging', async () => {
    // A lane blocked forever: only the stall guard can end this.
    let stallAborted = false;
    const openLane = async () => ({
        speak: () => new Promise(() => {}),
        close: () => {}
    });
    await assert.rejects(
        synthesizeSegments({
            segments: Array.from({ length: 10 }, (_, i) => `s${i}.`),
            openLane, lanes: 2, split: null,
            hardStallMs: 300, waitingNoticeMs: 0, segmentBudgetMs: 60000,
            onStall: () => { stallAborted = true; }
        }),
        /stopped responding after 0 of 10 parts/
    );
    assert.equal(stallAborted, true, 'the caller is asked to abort what is in flight');
});

test('a slow but progressing export is not mistaken for a stall', async () => {
    const { openLane } = fakeLanes(() => 'ok', { speakMs: 40 });
    const segments = Array.from({ length: 8 }, (_, i) => `s${i}.`);
    const result = await synthesizeSegments({
        segments, openLane, lanes: 1, split: null, hardStallMs: 300, waitingNoticeMs: 0
    });
    assert.equal(decode(result), segments.join(''));
});

test('a connection that will not open fails the export with its reason', async () => {
    const openLane = async () => { throw new Error('Speech service did not answer within 15 s'); };
    await assert.rejects(
        synthesizeSegments({
            segments: ['a.', 'b.'], openLane, lanes: 1, attempts: 2, backoff: [1], split: null,
            allowSkips: false, waitingNoticeMs: 0
        }),
        /did not answer within 15 s/
    );
});

test('concatBytes joins arrays and skips holes', () => {
    const out = concatBytes([bytesOf('ab'), null, bytesOf('c'), new Uint8Array(0), bytesOf('de')]);
    assert.equal(new TextDecoder().decode(out), 'abcde');
});

// ── skipping and staying audible ─────────────────────────────────────────────

test('one unspeakable part is skipped and reported, and the rest still export', async () => {
    const notes = [];
    const { openLane } = fakeLanes((text) => (text === 'bad.' ? 'Edge TTS returned no audio' : 'ok'));
    const result = await synthesizeSegments({
        segments: ['a.', 'bad.', 'c.'],
        openLane, lanes: 1, attempts: 2, backoff: [1], split: null,
        waitingNoticeMs: 0,
        onNotice: (n) => notes.push(n)
    });
    assert.equal(decode(result), 'a.c.', 'the good parts are kept, in order');
    assert.equal(result.parts.length, 3);
    assert.equal(result.parts[1], null, 'the skipped part leaves a hole, not a shifted array');
    assert.deepEqual(result.skipped.map((s) => s.segment), [2]);
    assert.ok(notes.some((n) => n.kind === 'skip' && n.segment === 2));
});

test('a part that keeps timing out is abandoned once its budget runs out', async () => {
    const { openLane } = fakeLanes(() => 'Speech service timed out after 20 s', { speakMs: 20 });
    const started = Date.now();
    const result = await synthesizeSegments({
        segments: ['slow.'],
        openLane, lanes: 1, attempts: 5, backoff: [10], split: null,
        segmentBudgetMs: 120, waitingNoticeMs: 0
    });
    assert.equal(result.skipped.length, 1);
    assert.ok(Date.now() - started < 2000, 'it gives up on schedule rather than grinding');
});

test('a run that has gone quiet says so instead of showing nothing', async () => {
    const notes = [];
    let release;
    const gate = new Promise((r) => { release = r; });
    const openLane = async () => ({
        speak: async () => { await gate; return bytesOf('x'); },
        close: () => {}
    });
    const run = synthesizeSegments({
        segments: ['a.'], openLane, lanes: 1, split: null,
        waitingNoticeMs: 60, hardStallMs: 0,
        onNotice: (n) => notes.push(n)
    });
    await wait(260);
    release();
    await run;
    const waits = notes.filter((n) => n.kind === 'waiting');
    assert.ok(waits.length >= 1, 'the caller hears about the wait');
    assert.ok(typeof waits[0].seconds === 'number');
});

test('a lane retires its connection after a while, because the service slows a busy one', async () => {
    const segments = Array.from({ length: 20 }, (_, i) => `s${i}.`);
    const { openLane, stats } = fakeLanes();
    await synthesizeSegments({
        segments, openLane, lanes: 1, split: null, waitingNoticeMs: 0, recycleAfter: 5
    });
    assert.equal(stats.opened, 4, 'twenty parts over connections of five');
    assert.equal(stats.open, 0);
    assert.ok(stats.perLane.every((l) => l.spoken <= 5));
});

test('recycling can be switched off, and then one connection does the lot', async () => {
    const segments = Array.from({ length: 20 }, (_, i) => `s${i}.`);
    const { openLane, stats } = fakeLanes();
    await synthesizeSegments({
        segments, openLane, lanes: 1, split: null, waitingNoticeMs: 0, recycleAfter: 0
    });
    assert.equal(stats.opened, 1);
});

// ── resuming after the exporter is interrupted ───────────────────────────────

test('parts already made are not spoken again, and still count as progress', async () => {
    const segments = Array.from({ length: 6 }, (_, i) => `s${i}.`);
    const spoken = [];
    const { openLane } = fakeLanes((text) => { spoken.push(text); return 'ok'; });
    const seen = [];
    await synthesizeSegments({
        segments, openLane, lanes: 1, split: null, waitingNoticeMs: 0,
        hasPart: (i) => i % 2 === 0,
        onProgress: (done, total) => seen.push([done, total])
    });
    assert.deepEqual(spoken, ['s1.', 's3.', 's5.'], 'only the missing parts are spoken');
    assert.equal(seen.length, 6, 'every part still reports progress');
    assert.deepEqual(seen[5], [6, 6]);
});

test('when parts are handed off they are not also kept in the returned array', async () => {
    const kept = new Map();
    const segments = Array.from({ length: 5 }, (_, i) => `s${i}.`);
    const { openLane } = fakeLanes();
    const result = await synthesizeSegments({
        segments, openLane, lanes: 2, split: null, waitingNoticeMs: 0,
        onPart: (i, part) => { kept.set(i, part); }
    });
    assert.equal(kept.size, 5);
    assert.ok(result.parts.every((p) => p === null), 'nothing is held twice');
    const ordered = [...kept.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    assert.equal(new TextDecoder().decode(concatBytes(ordered)), segments.join(''));
});

test('an export interrupted half way resumes and produces the whole file', async () => {
    const segments = Array.from({ length: 12 }, (_, i) => `part${i}.`);
    const store = new Map();
    const onPart = (i, part) => { store.set(i, part); };

    // First attempt: the exporter is taken away after five parts.
    let madeThisRun = 0;
    const failing = fakeLanes(() => {
        if (madeThisRun >= 5) return 'exporter went away';
        madeThisRun++;
        return 'ok';
    });
    await assert.rejects(synthesizeSegments({
        segments, openLane: failing.openLane, lanes: 1, attempts: 1, split: null,
        waitingNoticeMs: 0, allowSkips: false, onPart,
        hasPart: (i) => store.has(i)
    }));
    assert.equal(store.size, 5, 'what it did finish was kept');

    // Second attempt: same text, so it picks up where the first stopped.
    const spoken = [];
    const healthy = fakeLanes((text) => { spoken.push(text); return 'ok'; });
    await synthesizeSegments({
        segments, openLane: healthy.openLane, lanes: 2, split: null,
        waitingNoticeMs: 0, onPart,
        hasPart: (i) => store.has(i)
    });

    assert.equal(spoken.length, 7, 'only the seven missing parts were spoken again');
    assert.equal(store.size, 12);
    const ordered = [...store.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    assert.equal(new TextDecoder().decode(concatBytes(ordered)), segments.join(''),
        'the assembled file is complete and in document order');
});
