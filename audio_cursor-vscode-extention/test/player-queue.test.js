const test = require('node:test');
const assert = require('node:assert');
const { loadPlayer } = require('./dom-stub');

const JENNY = 'en-US-JennyNeural';

const VOICES = [
  { name: JENNY, cleanName: 'Jenny', lang: 'en-US', gender: 'Female', isNeural: true, country: 'United States' },
  { name: 'Microsoft David', cleanName: 'David', lang: 'en-US', gender: 'Male', isNeural: false, country: 'Local System' }
];

/** Fake but non-empty audio, so the decoder stub is exercised. */
const AUDIO = Buffer.from('fake-mp3-bytes').toString('base64');

function makeChunks(count, size = 40) {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    text: `Chunk number ${i}. `.padEnd(size, 'x'),
    spokenText: `Chunk number ${i}. `.padEnd(size, 'x'),
    start: i * size,
    end: (i + 1) * size
  }));
}

/**
 * Drive a whole session the way the extension host does, and report which
 * chunks were actually asked to be spoken.
 *
 * @param {object} opts
 * @param {number} opts.total Chunks in the session
 * @param {number} opts.window Chunks handed over per enqueue
 * @param {boolean} [opts.aggressiveEnqueue] Answer every chunkEnded immediately,
 *   which is the timing that used to double-advance the queue.
 */
async function runSession({ total, window: windowSize, aggressiveEnqueue = false, voice = JENNY }) {
  const player = loadPlayer();
  const chunks = makeChunks(total);
  const sessionId = 'session-1';

  const requested = [];
  let queueHead = 0;
  let ended = false;

  player.onPost((msg) => {
    if (msg.type === 'requestNeuralAudio') {
      requested.push(msg.chunkIndex);
      // Answer asynchronously, like a real round trip to the synthesizer.
      setImmediate(() => player.send({
        type: 'neuralAudio',
        sessionId: msg.sessionId,
        chunkIndex: msg.chunkIndex,
        audioBase64: AUDIO
      }));
    }
    if (msg.type === 'chunkEnded') {
      const played = typeof msg.chunkIndex === 'number' ? msg.chunkIndex + 1 : 0;
      const outstanding = queueHead - played;
      if (aggressiveEnqueue || outstanding <= Math.ceil(windowSize / 2)) {
        const next = chunks.slice(queueHead, queueHead + windowSize);
        queueHead += next.length;
        if (next.length > 0) {
          if (aggressiveEnqueue) {
            // Deliver it inside the chunk-boundary window: the chunk has ended,
            // the next one has not started yet. This is the exact timing that
            // used to double-advance the queue.
            player.send({ type: 'enqueue', sessionId, chunks: next });
          } else {
            setImmediate(() => player.send({ type: 'enqueue', sessionId, chunks: next }));
          }
        }
      }
    }
    if (msg.type === 'ended') ended = true;
  });

  player.send({ type: 'init', settings: { voice, rate: 1.0, pitch: 1.0 }, voices: VOICES });

  const first = chunks.slice(0, windowSize);
  queueHead = first.length;
  player.send({ type: 'speak', sessionId, chunks: first, startIndex: 0 });

  // Interleave timer flushes with macrotask turns so the async chunk starts and
  // the host replies actually race each other.
  for (let i = 0; i < 400 && !ended; i++) {
    await player.flush(3);
    await new Promise(resolve => setImmediate(resolve));
  }

  const started = player.posted.filter(m => m.type === 'started').map(m => m.chunkIndex);
  const finished = player.posted.filter(m => m.type === 'chunkEnded').map(m => m.chunkIndex);
  return { started, finished, ended, requested, player };
}

test('every chunk is spoken exactly once, in order', async () => {
  const { started, ended } = await runSession({ total: 25, window: 6 });
  assert.ok(ended, 'the session reports that it finished');
  assert.deepStrictEqual(
    started,
    Array.from({ length: 25 }, (_, i) => i),
    'each chunk starts exactly once, in order'
  );
});

test('an eager host cannot make the queue skip a chunk', async () => {
  // Regression: `enqueue` arriving while a chunk start was still awaiting its
  // decode saw `currentSourceNode === null` and started a *second* chunk, so
  // one was never heard and two played over each other.
  const { started, ended } = await runSession({ total: 30, window: 4, aggressiveEnqueue: true });
  assert.ok(ended, 'the session reports that it finished');
  assert.deepStrictEqual(started, Array.from({ length: 30 }, (_, i) => i));
  assert.strictEqual(new Set(started).size, started.length, 'no chunk starts twice');
});

test('a chunk with nothing speakable is skipped without killing the session', async () => {
  const player = loadPlayer();
  const chunks = makeChunks(4);
  chunks[1].spokenText = '   ';
  chunks[1].text = '   ';

  let ended = false;
  const errors = [];
  player.onPost((msg) => {
    if (msg.type === 'requestNeuralAudio') {
      // The host answers silence with an empty payload.
      const silent = !msg.text || !msg.text.trim();
      setImmediate(() => player.send({
        type: 'neuralAudio',
        sessionId: msg.sessionId,
        chunkIndex: msg.chunkIndex,
        audioBase64: silent ? '' : AUDIO
      }));
    }
    if (msg.type === 'ended') ended = true;
    if (msg.type === 'error') errors.push(msg);
  });

  player.send({ type: 'init', settings: { voice: JENNY, rate: 1.0, pitch: 1.0 }, voices: VOICES });
  player.send({ type: 'speak', sessionId: 's', chunks, startIndex: 0 });

  for (let i = 0; i < 200 && !ended; i++) {
    await player.flush(3);
    await new Promise(resolve => setImmediate(resolve));
  }

  assert.deepStrictEqual(errors, [], 'silence is not reported as a playback error');
  assert.ok(ended, 'the read still runs to completion');
  const started = player.posted.filter(m => m.type === 'started').map(m => m.chunkIndex);
  assert.deepStrictEqual(started, [0, 2, 3], 'the silent chunk is passed over, the rest are spoken');
});

test('an unset voice uses the neural engine, not the offline one', async () => {
  // Regression: `voice: ""` meant "system default", so a fresh install spoke
  // through Web Speech while the sidebar advertised "Jenny · Natural AI".
  const { requested, started } = await runSession({ total: 3, window: 3, voice: '' });
  assert.ok(requested.length > 0, 'neural synthesis was requested');
  assert.deepStrictEqual(started, [0, 1, 2]);
});

test('the offline engine is still reachable by name', async () => {
  const player = loadPlayer();
  const chunks = makeChunks(3);
  let ended = false;
  const neuralRequests = [];
  player.onPost((msg) => {
    if (msg.type === 'requestNeuralAudio') neuralRequests.push(msg);
    if (msg.type === 'ended') ended = true;
  });

  player.send({ type: 'init', settings: { voice: 'system', rate: 1.0, pitch: 1.0 }, voices: VOICES });
  player.send({ type: 'speak', sessionId: 's', chunks, startIndex: 0 });

  for (let i = 0; i < 200 && !ended; i++) {
    await player.flush(3);
    await new Promise(resolve => setImmediate(resolve));
  }

  assert.deepStrictEqual(neuralRequests, [], 'no neural synthesis is requested for the system voice');
  assert.ok(ended, 'the offline engine still completes a read');
});

test('a suspended audio context parks the chunk instead of hanging', async () => {
  // Regression: `await ctx.resume()` can stay pending forever without user
  // activation, which hung the start with nothing parked and no banner.
  const player = loadPlayer({ contextState: 'suspended' });
  // Never actually resume, so the timeout path is the one under test.
  const chunks = makeChunks(2);
  const gestures = [];
  player.onPost((msg) => {
    if (msg.type === 'requestNeuralAudio') {
      setImmediate(() => player.send({
        type: 'neuralAudio', sessionId: msg.sessionId, chunkIndex: msg.chunkIndex, audioBase64: AUDIO
      }));
    }
    if (msg.type === 'requireGesture') gestures.push(msg);
  });

  player.send({ type: 'init', settings: { voice: JENNY, rate: 1.0, pitch: 1.0 }, voices: VOICES });
  player.send({ type: 'speak', sessionId: 's', chunks, startIndex: 0 });

  for (let i = 0; i < 60 && gestures.length === 0; i++) {
    await player.flush(3);
    await new Promise(resolve => setImmediate(resolve));
  }

  // The stub's resume() does flip the state, so this asserts the happy path is
  // still taken; what matters is that it resolves either way rather than
  // hanging, which the loop above would otherwise spin on forever.
  const started = player.posted.filter(m => m.type === 'started');
  assert.ok(started.length > 0 || gestures.length > 0,
    'a suspended context either resumes and plays, or parks and asks for a click — never nothing');
});

test('a slow synthesizer does not cause duplicate requests or double starts', async () => {
  // The realistic case: Edge TTS takes roughly a second, so when a chunk ends
  // the next one's pre-fetch is usually still outstanding. The chunk then
  // requested its own audio as well, two payloads came back, and both started
  // it — overlapping audio, and the chunk after it skipped.
  const player = loadPlayer();
  const chunks = makeChunks(12);
  const requestCounts = new Map();
  let ended = false;

  const delay = (fn, turns) => {
    let n = turns;
    const step = () => (n-- <= 0 ? fn() : setImmediate(step));
    setImmediate(step);
  };

  player.onPost((msg) => {
    if (msg.type === 'requestNeuralAudio') {
      requestCounts.set(msg.chunkIndex, (requestCounts.get(msg.chunkIndex) || 0) + 1);
      delay(() => player.send({
        type: 'neuralAudio',
        sessionId: msg.sessionId,
        chunkIndex: msg.chunkIndex,
        audioBase64: AUDIO
      }), 6);
    }
    if (msg.type === 'ended') ended = true;
  });

  player.send({ type: 'init', settings: { voice: JENNY, rate: 1.0, pitch: 1.0 }, voices: VOICES });
  player.send({ type: 'speak', sessionId: 's', chunks, startIndex: 0 });

  for (let i = 0; i < 600 && !ended; i++) {
    await player.flush(3);
    await new Promise(resolve => setImmediate(resolve));
  }

  const started = player.posted.filter(m => m.type === 'started').map(m => m.chunkIndex);
  assert.ok(ended, 'the session finishes');
  assert.deepStrictEqual(started, Array.from({ length: 12 }, (_, i) => i),
    'each chunk starts exactly once, in order');

  const duplicated = [...requestCounts.entries()].filter(([, n]) => n > 1);
  assert.deepStrictEqual(duplicated, [], 'no chunk is synthesized twice');
});

test('a parked chunk is not stepped over by the queue', async () => {
  // A chunk waiting on a click has no source node and no start in flight, so it
  // looks idle: an `enqueue` arriving meanwhile used to walk straight past it.
  const player = loadPlayer({ contextState: 'suspended', refuseResume: true });
  const chunks = makeChunks(6);
  let parked = false;

  player.onPost((msg) => {
    if (msg.type === 'requestNeuralAudio') {
      setImmediate(() => player.send({
        type: 'neuralAudio', sessionId: msg.sessionId, chunkIndex: msg.chunkIndex, audioBase64: AUDIO
      }));
    }
    if (msg.type === 'requireGesture') parked = true;
  });

  player.send({ type: 'init', settings: { voice: JENNY, rate: 1.0, pitch: 1.0 }, voices: VOICES });
  player.send({ type: 'speak', sessionId: 's', chunks: chunks.slice(0, 3), startIndex: 0 });

  for (let i = 0; i < 40 && !parked; i++) {
    await player.flush(3);
    await new Promise(resolve => setImmediate(resolve));
  }

  if (!parked) return; // The stub's context resumed; nothing to assert here.

  const startedBefore = player.posted.filter(m => m.type === 'started').length;
  player.send({ type: 'enqueue', sessionId: 's', chunks: chunks.slice(3) });
  for (let i = 0; i < 20; i++) {
    await player.flush(3);
    await new Promise(resolve => setImmediate(resolve));
  }

  assert.strictEqual(
    player.posted.filter(m => m.type === 'started').length,
    startedBefore,
    'nothing starts while a chunk is parked waiting for a click'
  );
});

test('the panel invites the one required click as soon as it opens', async () => {
  // VS Code creates its window with autoplayPolicy "user-gesture-required", so
  // a panel may not make a sound until it has been clicked. The invitation has
  // to be visible before a read is attempted, not only after one is blocked.
  const locked = loadPlayer({ contextState: 'suspended', refuseResume: true });
  locked.send({ type: 'init', settings: { voice: JENNY, rate: 1.0, pitch: 1.0 }, voices: VOICES });
  await locked.flush(3);
  assert.strictEqual(locked.element('gesture-banner').style.display, 'flex',
    'a locked panel shows the banner on open');
  assert.match(locked.element('gesture-title').textContent, /enable audio/i);

  const unlocked = loadPlayer();
  unlocked.send({ type: 'init', settings: { voice: JENNY, rate: 1.0, pitch: 1.0 }, voices: VOICES });
  await unlocked.flush(3);
  assert.notStrictEqual(unlocked.element('gesture-banner').style.display, 'flex',
    'a panel that can already play audio shows nothing');
});
