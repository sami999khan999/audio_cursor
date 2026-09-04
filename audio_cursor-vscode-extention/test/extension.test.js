const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const Module = require('module');

// Redirect `require('vscode')` to the stub before loading anything.
const stubPath = require.resolve('./vscode-stub.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'vscode') return stubPath;
  return originalResolve.call(this, request, ...rest);
};

const vscode = require('./vscode-stub.js');
const src = (name) => path.join(__dirname, '..', 'src', name);

test('every host module loads', () => {
  for (const name of ['log.js', 'config.js', 'chunk.js', 'session.js', 'progress.js',
    'selection.js', 'decorations.js', 'statusBar.js', 'clipboardWatcher.js',
    'controller.js', 'extension.js', 'view/provider.js']) {
    assert.doesNotThrow(() => require(src(name)), `${name} should load`);
  }
});

test('a controller can be built, run a session and be disposed', () => {
  const { config } = require(src('config.js'));
  const { SelectionTracker } = require(src('selection.js'));
  const { StatusBarController } = require(src('statusBar.js'));
  const { DecorationController } = require(src('decorations.js'));
  const { AudioCursorController } = require(src('controller.js'));

  const posted = [];
  const viewProvider = {
    postMessage: (m) => posted.push(m),
    onMessage: () => ({ dispose() {} }),
    onReady: () => ({ dispose() {} }),
    isReady: () => true,
    isResolved: () => true,
    isVisible: () => true,
    show: () => true
  };

  const memento = { get: () => true, update: async () => {} };
  const controller = new AudioCursorController({
    config,
    selectionTracker: new SelectionTracker(config),
    statusBar: new StatusBarController(config),
    decorations: new DecorationController(config),
    viewProvider,
    memento,
    hostPlayer: null
  });

  assert.doesNotThrow(() => controller.pause());
  assert.doesNotThrow(() => controller.resume());
  assert.doesNotThrow(() => controller.stop());
  assert.doesNotThrow(() => controller.nextSentence());
  assert.doesNotThrow(() => controller.previousSentence());
  assert.doesNotThrow(() => controller.dispose());
});

test('a session chunks and seeks over real text', () => {
  const { Session } = require(src('session.js'));
  const text = 'First sentence here. Second sentence here. Third sentence here. '.repeat(20);
  const session = new Session(
    { text, uri: null, version: 0, startOffset: 0, endOffset: text.length },
    { chunkSize: 300, sanitizeCode: false, markdownProse: false }
  );

  assert.ok(session.chunks.length > 1);
  assert.strictEqual(session.chunks[0].start, 0);
  assert.strictEqual(session.chunks[session.chunks.length - 1].end, text.length);

  const first = session.nextWindow(4);
  assert.strictEqual(first.length, 4);
  assert.strictEqual(session.queueHead, 4);

  const { chunkIndex } = session.seekTo(Math.floor(text.length / 2));
  assert.ok(chunkIndex > 0, 'seeking lands in a later chunk');
  assert.strictEqual(session.queueHead, chunkIndex, 'the queue restarts from there');
});

test('config exposes every declared setting to the player', () => {
  const { config } = require(src('config.js'));
  const pkg = require(path.join(__dirname, '..', 'package.json'));
  const declared = Object.keys(pkg.contributes.configuration.properties)
    .map(k => k.replace(/^audioCursor\./, ''));

  const all = config.getAll();
  for (const key of declared) {
    assert.ok(key in all, `${key} is missing from config.getAll()`);
  }
});

test('the default voice is a neural one, matching what the player advertises', () => {
  const pkg = require(path.join(__dirname, '..', 'package.json'));
  const fs = require('fs');
  const playerSrc = fs.readFileSync(path.join(__dirname, '..', 'src', 'view', 'player.js'), 'utf8');
  const declared = pkg.contributes.configuration.properties['audioCursor.voice'].default;

  assert.match(declared, /Neural$/, 'the packaged default is a neural voice');
  assert.ok(
    playerSrc.includes(`DEFAULT_NEURAL_VOICE = '${declared}'`),
    'the player falls back to the same voice the package declares'
  );
});

test('the terminal copy command only runs where the terminal has focus', async () => {
  // VS Code raises "The terminal has no selection to copy" itself, and it
  // cannot be suppressed — so the command must never run from a path where it
  // is bound to fail, i.e. anything the user reached by clicking in the panel.
  const { AudioCursorController } = require(src('controller.js'));
  const { config } = require(src('config.js'));
  const { SelectionTracker } = require(src('selection.js'));
  const { StatusBarController } = require(src('statusBar.js'));
  const { DecorationController } = require(src('decorations.js'));

  const controller = new AudioCursorController({
    config,
    selectionTracker: new SelectionTracker(config),
    statusBar: new StatusBarController(config),
    decorations: new DecorationController(config),
    viewProvider: {
      postMessage() {}, onMessage: () => ({ dispose() {} }), onReady: () => ({ dispose() {} }),
      isReady: () => true, isResolved: () => true, isVisible: () => true, show: () => true
    },
    memento: { get: () => true, update: async () => {} },
    hostPlayer: null
  });

  vscode.window.activeTerminal = { name: 'bash', show() {} };
  vscode.window.terminals = [vscode.window.activeTerminal];
  vscode.__state.commands.length = 0;

  const clicked = await controller._captureTerminalSelection({ live: false });
  assert.strictEqual(clicked, null, 'with nothing captured, a click-driven read gives up');
  assert.ok(
    !vscode.__state.commands.some(([c]) => c === 'workbench.action.terminal.copySelection'),
    'the copy command is not run from a click-driven path'
  );

  await controller._captureTerminalSelection({ live: true });
  assert.ok(
    vscode.__state.commands.some(([c]) => c === 'workbench.action.terminal.copySelection'),
    'it is still run when the terminal really has focus'
  );

  vscode.window.activeTerminal = undefined;
  vscode.window.terminals = [];
  controller.dispose();
});

test('with a host player, a read is spoken by the host and needs no click in the panel', async () => {
  // Regression for the first-play click gate: VS Code will not let a panel
  // make a sound until it has been clicked, so the sound must not come from
  // the panel at all.
  const { EventEmitter } = require('events');
  const { AudioCursorController } = require(src('controller.js'));
  const { config } = require(src('config.js'));
  const { SelectionTracker } = require(src('selection.js'));
  const { StatusBarController } = require(src('statusBar.js'));
  const { DecorationController } = require(src('decorations.js'));

  class FakeHostPlayer extends EventEmitter {
    constructor() { super(); this.seq = 0; this.played = []; }
    ensureStarted() { return Promise.resolve(true); }
    isReady() { return true; }
    nextToken() { return 't' + (++this.seq); }
    preload() {}
    play(token) {
      this.played.push(token);
      setImmediate(() => this.emit('started', { token, duration: 1 }));
      setImmediate(() => this.emit('progress', { token, position: 0.5, duration: 1 }));
      setImmediate(() => this.emit('ended', { token }));
      return true;
    }
    pause() {} resume() {} stop() {} dispose() {}
  }

  // The engine synthesizes through the real neural module; stub that out.
  const neural = require(src('neuralEngine.js')).neuralEngine;
  const realSynth = neural.synthesize;
  neural.synthesize = async () => ({ audioBase64: Buffer.from('mp3').toString('base64') });

  const posted = [];
  const player = new FakeHostPlayer();
  const controller = new AudioCursorController({
    config,
    selectionTracker: new SelectionTracker(config),
    statusBar: new StatusBarController(config),
    decorations: new DecorationController(config),
    viewProvider: {
      postMessage: (m) => posted.push(m), onMessage: () => ({ dispose() {} }), onReady: () => ({ dispose() {} }),
      // The panel is deliberately NOT ready: host audio must not depend on it.
      isReady: () => false, isResolved: () => false, isVisible: () => false, show: () => false
    },
    memento: { get: () => true, update: async () => {} },
    hostPlayer: player
  });

  try {
    const text = 'One sentence to read. And another one after it.';
    await controller.play({
      text, uri: null, version: 0, startOffset: 0, endOffset: text.length,
      languageId: 'plaintext', fileName: 'x', wordCount: 9, charCount: text.length, fromCursor: false, source: 'editor'
    });

    assert.strictEqual(controller._engine, 'host', 'the host engine was chosen');
    assert.ok(!vscode.__state.posted.some(([kind, m]) => /not initialized/.test(m)),
      'no "open the sidebar first" warning, even though the panel is not ready');

    for (let i = 0; i < 50 && controller._status !== 'idle'; i++) {
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.ok(player.played.length > 0, 'audio went to the host player');
    const types = posted.map(m => m.type);
    assert.ok(types.includes('hostSession'), 'the panel was told to mirror, not play');
    assert.ok(!types.includes('speak'), 'the panel engine was never started');
    // The panel is closed, so ~25 position ticks a second must not pile up
    // in its queue waiting for it to open; the editor highlight needs no panel.
    assert.ok(!types.includes('hostProgress'), 'no progress ticks are queued for a panel that is not open');
    assert.strictEqual(controller._status, 'idle', 'the session finished');
  } finally {
    neural.synthesize = realSynth;
    controller.dispose();
  }
});

test('host reads: a redrawing terminal does not stop playback, the sidebar stays shut, pause sticks', async () => {
  const { EventEmitter } = require('events');
  const { AudioCursorController } = require(src('controller.js'));
  const { config } = require(src('config.js'));
  const { SelectionTracker } = require(src('selection.js'));
  const { StatusBarController } = require(src('statusBar.js'));
  const { DecorationController } = require(src('decorations.js'));
  const { createTextSnapshot } = require(src('selection.js'));

  // A player under manual control: nothing ends until the test says so.
  class ManualHostPlayer extends EventEmitter {
    constructor() { super(); this.seq = 0; this.token = null; this.paused = false; }
    ensureStarted() { return Promise.resolve(true); }
    isReady() { return true; }
    nextToken() { return 't' + (++this.seq); }
    preload() {}
    play(token) { this.token = token; setImmediate(() => this.emit('started', { token, duration: 10 })); return true; }
    tick(position) { this.emit('progress', { token: this.token, position, duration: 10 }); }
    pause() { this.paused = true; }
    resume() { this.paused = false; }
    stop() { this.token = null; }
    dispose() {}
  }

  const neural = require(src('neuralEngine.js')).neuralEngine;
  const realSynth = neural.synthesize;
  neural.synthesize = async () => ({ audioBase64: Buffer.from('mp3').toString('base64') });

  const player = new ManualHostPlayer();
  const statusBar = new StatusBarController(config);
  const controller = new AudioCursorController({
    config,
    selectionTracker: new SelectionTracker(config),
    statusBar,
    decorations: new DecorationController(config),
    viewProvider: {
      postMessage() {}, onMessage: () => ({ dispose() {} }), onReady: () => ({ dispose() {} }),
      isReady: () => false, isResolved: () => false, isVisible: () => false, show: () => false
    },
    memento: { get: () => true, update: async () => {} },
    hostPlayer: player
  });

  const settle = () => new Promise(resolve => setImmediate(() => setImmediate(resolve)));

  try {
    vscode.__state.commands.length = 0;
    const text = 'Terminal output being read aloud. Second sentence of it.';
    const snap = createTextSnapshot(text, { label: 'Terminal: x', source: 'terminal' });
    controller._lastSource = 'terminal';
    controller._lastTerminalSnapshot = snap;
    await controller.play(snap);
    // Synthesis writes a file before the player is handed anything.
    for (let i = 0; i < 200 && controller._status !== 'playing'; i++) await settle();
    assert.strictEqual(controller._status, 'playing');

    // 1. The host engine must not yank the sidebar open.
    assert.ok(
      !vscode.__state.commands.some(([c]) => c === 'audioCursor.player.focus'),
      'the panel focus command was not run for a host read'
    );

    // 2. The terminal redraws and copyOnSelection re-copies slightly different
    //    text; the watcher reports a "new" terminal selection.
    const redrawn = createTextSnapshot(text + ' ', { label: 'Terminal: x', source: 'terminal' });
    for (const listener of controller._clipboardWatcher._listeners) listener(redrawn);
    assert.strictEqual(controller._status, 'playing', 'a terminal re-copy does not stop the read');
    assert.strictEqual(controller._lastTerminalSnapshot, redrawn, 'but it is remembered for the next Alt+P');

    // 3. Pause, then a position tick that was already on its way arrives.
    player.tick(2.0);
    controller.pause();
    assert.strictEqual(controller._status, 'paused');
    player.tick(2.1);
    await settle();
    assert.strictEqual(controller._status, 'paused', 'a late tick does not un-pause');
    assert.strictEqual(statusBar._state.status, 'paused', 'and the status bar still says paused');
  } finally {
    neural.synthesize = realSynth;
    controller.dispose();
  }
});
