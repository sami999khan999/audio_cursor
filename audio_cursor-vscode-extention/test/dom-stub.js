/**
 * A minimal DOM/Web-Audio stub, just wide enough to load `src/view/player.js`
 * outside a webview and drive its message protocol.
 *
 * The player is the half of the extension that cannot be reached from the
 * extension host's own tests — it runs in a webview whose console is invisible
 * from outside — so this exists to make its queue behaviour testable at all.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

function makeElement(id) {
  const listeners = new Map();
  const el = {
    id,
    style: { setProperty() {}, display: '', width: '', left: '', background: '' },
    dataset: {},
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      toggle(c, on) { if (on === undefined) { this._set.has(c) ? this._set.delete(c) : this._set.add(c); } else if (on) { this._set.add(c); } else { this._set.delete(c); } },
      contains(c) { return this._set.has(c); }
    },
    className: '',
    innerHTML: '',
    textContent: '',
    title: '',
    value: '',
    min: '0',
    max: '1',
    checked: false,
    disabled: false,
    hidden: false,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(fn);
    },
    dispatch(type, event) {
      for (const fn of listeners.get(type) || []) fn(event || {});
    },
    appendChild() {},
    removeChild() {},
    closest() { return null; },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    getBoundingClientRect() { return { left: 0, width: 100 }; },
    focus() {},
    scrollIntoView() {}
  };
  return el;
}

/**
 * Load player.js into a stubbed browser context.
 *
 * @returns {{ send: (msg: object) => void, posted: object[], onPost: (fn: (msg: object) => void) => void, clock: object }}
 */
function loadPlayer(options = {}) {
  const posted = [];
  const postHandlers = [];
  const elements = new Map();
  const getEl = (id) => {
    if (!elements.has(id)) elements.set(id, makeElement(id));
    return elements.get(id);
  };

  const messageListeners = [];
  const windowListeners = new Map();

  const timers = [];
  let timerSeq = 1;

  const ctx = {
    console,
    JSON,
    Math,
    Date,
    Map,
    Set,
    Promise,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Error,
    parseFloat,
    parseInt,
    isNaN,
    Uint8Array,
    atob: (b64) => Buffer.from(b64, 'base64').toString('binary'),
    setTimeout: (fn, ms) => {
      const id = timerSeq++;
      timers.push({ id, fn, at: Date.now() + (ms || 0) });
      return id;
    },
    clearTimeout: (id) => {
      const i = timers.findIndex(t => t.id === id);
      if (i >= 0) timers.splice(i, 1);
    },
    setInterval: () => timerSeq++,
    clearInterval: () => {}
  };

  ctx.acquireVsCodeApi = () => ({
    postMessage: (msg) => {
      posted.push(msg);
      for (const fn of postHandlers) fn(msg);
    },
    setState() {},
    getState() { return null; }
  });

  ctx.document = {
    visibilityState: 'visible',
    getElementById: getEl,
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => makeElement('created'),
    createTextNode: () => ({}),
    createDocumentFragment: () => ({ appendChild() {} }),
    addEventListener() {}
  };

  ctx.navigator = { clipboard: { writeText: () => Promise.resolve() } };

  // --- Web Audio -----------------------------------------------------------
  const startedChunks = [];
  ctx.AudioContext = function AudioContextStub() {
    this.state = options.contextState || 'running';
    this.currentTime = 0;
    this.sampleRate = 48000;
    this.destination = {};
    this.resume = () => {
      // `refuseResume` models Chromium with no user activation: the promise
      // never settles and the state never changes.
      if (options.refuseResume) return new Promise(() => {});
      this.state = 'running';
      return Promise.resolve();
    };
    this.suspend = () => { this.state = 'suspended'; return Promise.resolve(); };
    this.createBuffer = () => ({ duration: 0.01 });
    // Real decoding is genuine async work that settles on a macrotask, not a
    // microtask. That distinction is the whole chunk-boundary window the queue
    // latch exists to protect, so the stub has to reproduce it.
    this.decodeAudioData = () => new Promise(resolve => setImmediate(() => resolve({ duration: 0.01 })));
    this.createBufferSource = () => {
      const source = {
        buffer: null,
        onended: null,
        connect() {},
        disconnect() {},
        stop() {},
        start() {
          // Finish on the next tick so the chunk-boundary window — the one the
          // in-flight latch protects — is actually exercised.
          ctx.setTimeout(() => { if (source.onended) source.onended(); }, 0);
        }
      };
      return source;
    };
  };

  // --- Web Speech ----------------------------------------------------------
  ctx.SpeechSynthesisUtterance = function (text) { this.text = text; };
  ctx.speechSynthesis = {
    speaking: false,
    getVoices: () => options.localVoices || [],
    speak(utterance) {
      this.speaking = true;
      ctx.setTimeout(() => {
        if (utterance.onstart) utterance.onstart();
        ctx.setTimeout(() => {
          this.speaking = false;
          if (utterance.onend) utterance.onend();
        }, 0);
      }, 0);
    },
    cancel() { this.speaking = false; },
    pause() {},
    resume() {}
  };

  ctx.window = {
    addEventListener(type, fn) {
      if (type === 'message') messageListeners.push(fn);
      if (!windowListeners.has(type)) windowListeners.set(type, []);
      windowListeners.get(type).push(fn);
    },
    speechSynthesis: ctx.speechSynthesis,
    AudioContext: ctx.AudioContext
  };
  ctx.globalThis = ctx;

  vm.createContext(ctx);
  const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'view', 'player.js'), 'utf8');
  vm.runInContext(src, ctx, { filename: 'player.js' });

  /** Run every timer that is due, repeatedly, until the queue settles. */
  const flush = async (rounds = 200) => {
    for (let i = 0; i < rounds; i++) {
      await Promise.resolve();
      if (timers.length === 0) continue;
      const due = timers.splice(0, timers.length);
      for (const t of due) t.fn();
    }
    await Promise.resolve();
  };

  return {
    posted,
    startedChunks,
    onPost: (fn) => postHandlers.push(fn),
    send: (msg) => { for (const fn of messageListeners) fn({ data: msg }); },
    dispatchWindow: (type, ev) => { for (const fn of windowListeners.get(type) || []) fn(ev || {}); },
    element: getEl,
    flush
  };
}

module.exports = { loadPlayer };
