// Audio Cursor — MP3 export pipeline
//
// The pure part of exporting a long text as one audio file: split it into
// segments the speech services accept, speak them over a small number of
// reused connections, keep the audio in document order, and report progress.
// Nothing in here touches the DOM or extension APIs, so it runs (and is
// tested) under plain node; the offscreen document supplies the connections.
//
// Four rules keep a long export from stalling:
//   * every attempt is bounded by exactly one timeout, owned by the thing that
//     can actually abort the work. Wrapping a timeout around an operation that
//     retries internally only abandons it — it keeps running, unwatched, and
//     holds its connection open;
//   * a failed attempt throws its connection away rather than reusing it, so a
//     retry starts from a clean socket;
//   * one segment gets a fixed budget. When it runs out the segment is skipped
//     and reported, because an export that finishes with a gap is worth more
//     than one that dies at 44% after several silent minutes;
//   * the run says something at least every few seconds. Silence is the one
//     state a caller cannot tell apart from a hang.

// Edge accepts several sentences per request; fewer, larger requests keep a
// long export quick without going near the service's per-message byte cap
// (comfortably under it even at three UTF-8 bytes per character).
const EXPORT_CHUNK_CHARS = 800;
// A segment the service refuses at that size is retried in pieces of the size
// playback uses, which is known to work for every voice.
const RETRY_SPLIT_CHARS = 300;
// Connections open at once, each reused for many parts. Measured end to end on
// a 99-part export: 2 lanes 81s, 4 lanes 18s, 6 lanes 14s. Four takes almost
// all of the win while keeping the number of sockets modest, which matters
// because the browser throttles concurrent handshakes to one address.
const EXPORT_LANES = 4;
// One request. A segment of this size normally answers in about a second, so
// twenty is already deep into "something is wrong" territory.
const SEGMENT_TIMEOUT_MS = 20000;
const CONNECT_TIMEOUT_MS = 12000;
// Tries per segment before it is split, and the waits between them.
const ATTEMPTS_PER_SEGMENT = 3;
const RETRY_BACKOFF_MS = [400, 1200, 3000];
// Parts one connection speaks before it is retired for a fresh one. The
// service slows a connection down the more audio it has produced: measured on
// a 247-part export, holding four connections open throughout took 112s and
// degraded from 5s per 25 parts to 18s once past part 100, while retiring each
// connection every 25 parts held 5s per 25 the whole way and finished in 51s.
// A handshake costs about half a second, so this is nearly free.
const RECYCLE_AFTER_PARTS = 25;
// Total effort for one segment, retries and splits included. Past this it is
// skipped, so a single unspeakable passage cannot hold up the whole export.
const SEGMENT_BUDGET_MS = 75000;
// Say something if nothing has finished for this long.
const WAITING_NOTICE_MS = 8000;
// Nothing finished at all for this long: stop and explain.
const HARD_STALL_MS = 120000;

class CancelledError extends Error {
    constructor() {
        super('Export cancelled');
        this.name = 'CancelledError';
        this.cancelled = true;
    }
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Split text into the segments to synthesize for `engine`.
 * @param {string} text
 * @param {'neural'|'cloud'} engine
 * @param {{ neural?: Function, cloud?: Function }} [splitters]
 *   Defaults to the shared chunkers (`ChunkText`, `CloudTTS`) on globalThis.
 * @returns {string[]}
 */
function segmentText(text, engine, splitters = {}) {
    if (!text || typeof text !== 'string' || !text.trim()) return [];
    let pieces;
    if (engine === 'neural') {
        const split = splitters.neural || globalThis.ChunkText.chunkText;
        pieces = split(text, EXPORT_CHUNK_CHARS).map((c) => c.text);
    } else {
        const split = splitters.cloud || globalThis.CloudTTS.chunkSpeechText;
        pieces = split(text);
    }
    return pieces.filter((p) => p && p.trim());
}

/** Join byte arrays into one, ignoring gaps left by skipped segments. */
function concatBytes(arrays) {
    const list = arrays.filter(Boolean);
    const total = list.reduce((n, a) => n + a.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const a of list) {
        out.set(a instanceof Uint8Array ? a : new Uint8Array(a), offset);
        offset += a.byteLength;
    }
    return out;
}

/**
 * Speak every segment and return their audio, in order.
 *
 * @param {object} params
 * @param {string[]} params.segments
 * @param {() => Promise<{ speak: (text: string) => Promise<Uint8Array>, close: () => void }>} params.openLane
 *   Opens one connection. Called again whenever a lane's connection is thrown
 *   away, so it must be safe to call many times.
 * @param {number} [params.lanes]
 * @param {number} [params.attempts]
 * @param {number[]} [params.backoff]
 * @param {number} [params.recycleAfter]  Parts before a lane retires its
 *   connection; 0 keeps one connection for the whole run.
 * @param {number} [params.segmentBudgetMs]
 * @param {number} [params.waitingNoticeMs]  0 disables the "still waiting" notices.
 * @param {number} [params.hardStallMs]      0 disables the stall guard.
 * @param {boolean} [params.allowSkips]      Skip a segment that exhausts its budget.
 * @param {(done: number, total: number) => void} [params.onProgress]
 * @param {(note: object) => void} [params.onNotice]
 * @param {() => boolean} [params.isCancelled]
 * @param {() => void} [params.onStall]  Called once when the stall guard trips,
 *   so the caller can abort whatever is in flight (a socket waiting forever
 *   cannot be unwound from here).
 * @param {(index: number) => boolean} [params.hasPart]  True for a part that
 *   was made by an earlier run and does not need speaking again.
 * @param {(index: number, part: any) => any} [params.onPart]  Handed each new
 *   part as it is finished, so a caller can put it somewhere that outlives this
 *   run. When given, finished parts are not also kept in the returned array.
 * @param {Function|null} [params.split]  Re-splitter for a refused segment; null disables.
 * @param {(parts: any[]) => any} [params.combine]  Joins the pieces of a split
 *   segment. Defaults to joining byte arrays; a caller holding its audio as
 *   Blobs passes its own, so nothing has to be a typed array.
 * @returns {Promise<{ parts: Array<Uint8Array|null>, skipped: Array<{segment: number, error: string}> }>}
 */
async function synthesizeSegments({
    segments,
    openLane,
    lanes = EXPORT_LANES,
    attempts = ATTEMPTS_PER_SEGMENT,
    backoff = RETRY_BACKOFF_MS,
    recycleAfter = RECYCLE_AFTER_PARTS,
    segmentBudgetMs = SEGMENT_BUDGET_MS,
    waitingNoticeMs = WAITING_NOTICE_MS,
    hardStallMs = HARD_STALL_MS,
    allowSkips = true,
    onProgress = () => {},
    onNotice = () => {},
    isCancelled = () => false,
    onStall = () => {},
    hasPart = null,
    onPart = null,
    split = (text, max) => globalThis.ChunkText.chunkText(text, max),
    combine = concatBytes
}) {
    const total = segments.length;
    const results = new Array(total).fill(null);
    const skipped = [];
    let next = 0;
    let done = 0;
    let failure = null;
    let stallError = null;
    let lastCompletedAt = Date.now();

    // Something to throw at a lane that is between attempts. A lane already
    // waiting on a request cannot be interrupted from here, which is why the
    // guard also races the whole run below.
    const stopReason = () => {
        if (stallError) return stallError;
        if (failure) return failure;
        if (isCancelled()) return new CancelledError();
        return null;
    };

    async function runLane() {
        let lane = null;
        let spokenOnLane = 0;

        function dropLane() {
            if (!lane) return;
            try { lane.close(); } catch (_) {}
            lane = null;
            spokenOnLane = 0;
        }

        // One attempt: open a connection if this lane has none, speak, and on
        // any failure throw the connection away so the retry starts clean.
        async function attempt(text) {
            // A connection that has already produced a lot of audio is served
            // progressively more slowly, so retire it rather than let the
            // export grind to a halt half way through.
            if (lane && recycleAfter > 0 && spokenOnLane >= recycleAfter) dropLane();
            if (!lane) lane = await openLane();
            try {
                const spoken = await lane.speak(text);
                spokenOnLane++;
                return spoken;
            } catch (err) {
                dropLane();
                throw err;
            }
        }

        async function speakWithRetries(text, segmentNumber, deadline) {
            let lastErr;
            for (let n = 1; n <= attempts; n++) {
                const reason = stopReason();
                if (reason) throw reason;
                if (Date.now() >= deadline) {
                    throw lastErr || new Error('ran out of time for this part');
                }
                try {
                    return await attempt(text);
                } catch (err) {
                    const why = stopReason();
                    if (why) throw why;
                    if (err && err.cancelled) throw new CancelledError();
                    lastErr = err;
                    dropLane();
                    const pause = backoff[Math.min(n - 1, backoff.length - 1)];
                    if (n < attempts && Date.now() + pause < deadline) {
                        onNotice({
                            kind: 'retry',
                            segment: segmentNumber,
                            attempt: n + 1,
                            of: attempts,
                            error: err && err.message
                        });
                        await delay(pause);
                    }
                }
            }
            throw lastErr;
        }

        // A segment the service will not take at full size is retried in
        // smaller pieces before it is given up on.
        async function speakSegment(text, segmentNumber, deadline) {
            try {
                return await speakWithRetries(text, segmentNumber, deadline);
            } catch (err) {
                const why = stopReason();
                if (why) throw why;
                if (err && err.cancelled) throw new CancelledError();
                if (!split || text.length <= RETRY_SPLIT_CHARS || Date.now() >= deadline) throw err;
                onNotice({ kind: 'split', segment: segmentNumber, error: err && err.message });
                const pieces = split(text, RETRY_SPLIT_CHARS)
                    .map((c) => c.text)
                    .filter((p) => p && p.trim());
                const parts = [];
                for (const piece of pieces) {
                    parts.push(await speakWithRetries(piece, segmentNumber, deadline));
                }
                return combine(parts);
            }
        }

        try {
            for (;;) {
                if (stopReason()) return;
                const i = next++;
                if (i >= total) return;
                // Already made by an earlier attempt at this same export.
                if (hasPart && hasPart(i)) {
                    lastCompletedAt = Date.now();
                    onProgress(++done, total);
                    continue;
                }
                const deadline = Date.now() + segmentBudgetMs;
                try {
                    const part = await speakSegment(segments[i], i + 1, deadline);
                    if (onPart) await onPart(i, part);
                    else results[i] = part;
                } catch (err) {
                    if (err && (err.cancelled || err === stallError || err === failure)) return;
                    if (!allowSkips) {
                        if (!failure) failure = err;
                        return;
                    }
                    // Leave a hole rather than throwing the whole export away.
                    skipped.push({ segment: i + 1, error: (err && err.message) || String(err) });
                    onNotice({ kind: 'skip', segment: i + 1, error: err && err.message });
                }
                if (isCancelled()) return;
                lastCompletedAt = Date.now();
                onProgress(++done, total);
            }
        } finally {
            dropLane();
        }
    }

    const width = Math.max(1, Math.min(lanes, total));
    const work = Promise.all(Array.from({ length: width }, () => runLane()));

    // A run that says nothing is indistinguishable from a run that has died,
    // so speak up while waiting, and give up if the wait becomes absurd.
    let ticker = null;
    const watched = (hardStallMs > 0 || waitingNoticeMs > 0)
        ? new Promise((_, rejectStall) => {
            let lastNotice = 0;
            const period = waitingNoticeMs || hardStallMs || 4000;
            const tick = Math.max(100, Math.min(2000, Math.floor(period / 2)));
            const repeatEvery = Math.max(tick, Math.min(4000, period));
            ticker = setInterval(() => {
                const idle = Date.now() - lastCompletedAt;
                if (hardStallMs > 0 && idle > hardStallMs) {
                    clearInterval(ticker);
                    stallError = new Error(
                        `the speech service stopped responding after ${done} of ${total} parts`
                    );
                    try { onStall(); } catch (_) {}
                    rejectStall(stallError);
                    return;
                }
                if (waitingNoticeMs > 0 && idle > waitingNoticeMs && Date.now() - lastNotice > repeatEvery) {
                    lastNotice = Date.now();
                    onNotice({ kind: 'waiting', seconds: Math.round(idle / 1000) });
                }
            }, tick);
        })
        : null;

    try {
        await (watched ? Promise.race([work, watched]) : work);
    } finally {
        clearInterval(ticker);
        // Whatever happens, the lanes must not be left running unwatched.
        work.catch(() => {});
        if (watched) watched.catch(() => {});
    }

    if (stallError) throw stallError;
    if (isCancelled()) throw new CancelledError();
    if (failure) throw failure;
    return { parts: results, skipped };
}

const ExportPipeline = {
    EXPORT_CHUNK_CHARS,
    RETRY_SPLIT_CHARS,
    EXPORT_LANES,
    SEGMENT_TIMEOUT_MS,
    CONNECT_TIMEOUT_MS,
    ATTEMPTS_PER_SEGMENT,
    RETRY_BACKOFF_MS,
    RECYCLE_AFTER_PARTS,
    SEGMENT_BUDGET_MS,
    WAITING_NOTICE_MS,
    HARD_STALL_MS,
    CancelledError,
    segmentText,
    synthesizeSegments,
    concatBytes
};

globalThis.ExportPipeline = ExportPipeline;
if (typeof module !== 'undefined' && module.exports) module.exports = ExportPipeline;
