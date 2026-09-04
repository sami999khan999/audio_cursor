const test = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('events');
const Module = require('module');

const stubPath = require.resolve('./vscode-stub.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return stubPath;
  return originalResolve.call(this, request, ...rest);
};

const { HostSpeechEngine } = require('../src/hostEngine');
const { Session } = require('../src/session');

/**
 * Stands in for the PowerShell daemon: opens are instant, each file "plays"
 * for a handful of ticks, and every event carries its token like the real one.
 */
class FakePlayer extends EventEmitter {
  constructor() {
    super();
    this.seq = 0;
    this.commands = [];
    this.current = null;
    this.paused = false;
    this.timer = null;
  }
  nextToken() { return 'tok' + (++this.seq); }
  preload(token, file) { this.commands.push(['preload', token, file]); }
  play(token, file) {
    this.commands.push(['play', token, file]);
    this._clear();
    this.current = { token, ticks: 0 };
    setImmediate(() => this.emit('started', { token, duration: 1 }));
    this.timer = setInterval(() => {
      if (!this.current || this.paused) return;
      this.current.ticks++;
      if (this.current.ticks < 4) {
        this.emit('progress', { token, position: this.current.ticks / 4, duration: 1 });
      } else {
        const t = this.current.token;
        this._clear();
        this.emit('ended', { token: t });
      }
    }, 2);
    return true;
  }
  pause() { this.commands.push(['pause']); this.paused = true; }
  resume() { this.commands.push(['resume']); this.paused = false; }
  stop() { this.commands.push(['stop']); this._clear(); }
  _clear() { if (this.timer) clearInterval(this.timer); this.timer = null; this.current = null; }
}

const fakeSynth = {
  calls: [],
  async synthesize(text, voice, rate, pitch) {
    this.calls.push({ text, voice, rate, pitch });
    await new Promise(r => setImmediate(r));
    return { audioBase64: text.trim() ? Buffer.from('audio:' + text).toString('base64') : '' };
  }
};

/** Exactly `count` chunks: two fixed-width 30-char sentences per 60-char chunk. */
function makeSession(count) {
  const text = Array.from({ length: count * 2 }, (_, i) => `Sentence ${String(i).padStart(2, '0')} is right here. `).join('');
  const session = new Session({ text, uri: null, version: 0, startOffset: 0, endOffset: text.length }, { chunkSize: 60 });
  assert.strictEqual(session.chunks.length, count, 'test fixture yields the requested chunk count');
  return session;
}

const waitFor = (emitter, event) => new Promise(resolve => emitter.once(event, resolve));

test('reads every chunk in order, preloading the next while one plays', async () => {
  const player = new FakePlayer();
  const engine = new HostSpeechEngine(player, fakeSynth);
  const session = makeSession(6);

  const started = [];
  const progressed = [];
  engine.on('started', e => started.push(e.chunkIndex));
  engine.on('progress', e => progressed.push(e.charIndex));

  engine.start(session, () => ({ voice: 'v', rate: 1, pitch: 1 }));
  await waitFor(engine, 'ended');

  assert.deepStrictEqual(started, session.chunks.map(c => c.index), 'every chunk started once, in order');
  assert.ok(progressed.length > session.chunks.length, 'progress was reported inside chunks');
  for (let i = 1; i < progressed.length; i++) {
    assert.ok(progressed[i] >= progressed[i - 1], 'progress only ever moves forward');
  }
  assert.strictEqual(progressed[progressed.length - 1] <= session.snapshot.text.length, true);

  const preloads = player.commands.filter(c => c[0] === 'preload').length;
  assert.ok(preloads >= session.chunks.length - 1, 'each following chunk was preloaded');
  engine.dispose();
});

test('a played chunk uses the token it was preloaded with', async () => {
  const player = new FakePlayer();
  const engine = new HostSpeechEngine(player, fakeSynth);
  engine.start(makeSession(3), () => ({ voice: 'v', rate: 1, pitch: 1 }));
  await waitFor(engine, 'ended');

  const preloaded = player.commands.filter(c => c[0] === 'preload').map(c => c[1]);
  const played = player.commands.filter(c => c[0] === 'play').map(c => c[1]);
  for (const token of preloaded) {
    assert.ok(played.includes(token), `preloaded ${token} was later played under the same token`);
  }
  engine.dispose();
});

test('pause and resume are passed through, stop tears everything down', async () => {
  const player = new FakePlayer();
  const engine = new HostSpeechEngine(player, fakeSynth);
  engine.start(makeSession(4), () => ({ voice: 'v', rate: 1, pitch: 1 }));
  await waitFor(engine, 'started');

  engine.pause();
  assert.ok(player.paused, 'the player is paused');
  engine.resume();
  assert.ok(!player.paused, 'and resumed');

  engine.stop();
  assert.ok(!engine.isActive, 'the engine has no session');
  assert.deepStrictEqual(player.commands[player.commands.length - 1], ['stop']);
  engine.dispose();
});

test('seek restarts from the chunk containing the offset', async () => {
  const player = new FakePlayer();
  const engine = new HostSpeechEngine(player, fakeSynth);
  const session = makeSession(6);
  engine.start(session, () => ({ voice: 'v', rate: 1, pitch: 1 }));
  await waitFor(engine, 'started');

  const target = session.chunks[4].start + 3;
  const started = [];
  engine.on('started', e => started.push(e.chunkIndex));
  engine.seek(target);
  await waitFor(engine, 'ended');

  assert.deepStrictEqual(started, [4, 5], 'playback continued from chunk 4');
  engine.dispose();
});

test('a silent chunk is passed over without touching the player', async () => {
  const player = new FakePlayer();
  const engine = new HostSpeechEngine(player, fakeSynth);
  const session = makeSession(3);
  session.chunks[1].spokenText = '   ';

  const started = [];
  const ended = [];
  engine.on('started', e => started.push(e.chunkIndex));
  engine.on('chunkEnded', e => ended.push(e.chunkIndex));
  engine.start(session, () => ({ voice: 'v', rate: 1, pitch: 1 }));
  await waitFor(engine, 'ended');

  assert.deepStrictEqual(started, [0, 2]);
  assert.deepStrictEqual(ended, [0, 1, 2], 'the silent chunk still reports as finished');
  engine.dispose();
});

test('a synthesis failure is reported, not swallowed', async () => {
  const player = new FakePlayer();
  const engine = new HostSpeechEngine(player, { synthesize: async () => { throw new Error('offline'); } });
  engine.start(makeSession(2), () => ({ voice: 'v', rate: 1, pitch: 1 }));
  const failure = await waitFor(engine, 'failure');
  assert.match(failure.message, /offline/);
  assert.ok(!engine.isActive);
  engine.dispose();
});

test('voice settings are read at synthesis time', async () => {
  const player = new FakePlayer();
  fakeSynth.calls.length = 0;
  const engine = new HostSpeechEngine(player, fakeSynth);
  let rate = 1.0;
  engine.start(makeSession(6), () => ({ voice: 'v', rate, pitch: 1 }));
  await waitFor(engine, 'started');
  rate = 1.5;
  await waitFor(engine, 'ended');
  assert.ok(fakeSynth.calls.some(c => c.rate === 1.5), 'a later chunk picked up the new rate');
  engine.dispose();
});
