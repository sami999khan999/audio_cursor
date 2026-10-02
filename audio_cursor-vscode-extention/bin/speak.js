#!/usr/bin/env node
/**
 * Audio Cursor without VS Code: reads text aloud with the extension's own
 * neural voices and host player (mpv), for when no VS Code window is open to
 * do it — agentmux's read-aloud key starts it then.
 *
 *   node bin/speak.js < text      read the text on stdin
 *
 * While it runs it is a reader like a VS Code window: it listens on
 * `<control dir>/<pid>.sock` and describes itself in `<pid>.json` (with
 * `"standalone": true`, so clients prefer a real window), and takes the same
 * requests — `read` replaces what is being read, `toggle` pauses, resumes or
 * reads again. It exits after a while with nothing to do.
 *
 * Voice, speed and pitch come from VS Code's user settings (audioCursor.*),
 * so it sounds the same as the extension.
 */
const fs = require('fs');
const os = require('os');
const net = require('net');
const path = require('path');

const src = path.join(__dirname, '..', 'src');
const log = require(path.join(src, 'log'));
const { controlDir } = require(path.join(src, 'externalControlDir'));
const { Session } = require(path.join(src, 'session'));
const { HostAudioPlayer } = require(path.join(src, 'hostPlayer'));
const { HostSpeechEngine } = require(path.join(src, 'hostEngine'));
const { neuralEngine } = require(path.join(src, 'neuralEngine'));

const IDLE_EXIT_MS = 10 * 60 * 1000;
const DEFAULT_VOICE = 'en-US-JennyNeural';
const SETTINGS_FILES = ['Code', 'Code - OSS', 'VSCodium', 'Code - Insiders'].map(app =>
  process.platform === 'darwin'
    ? path.join(os.homedir(), 'Library', 'Application Support', app, 'User', 'settings.json')
    : path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), app, 'User', 'settings.json'));

/** settings.json is JSONC: drop comments and trailing commas, leaving strings alone. */
function parseJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) break;
      i++;
    } else {
      out += c;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function settings() {
  const s = { voice: DEFAULT_VOICE, rate: 1, pitch: 1, chunkSize: 300, sanitizeCode: false, readMarkdownAsProse: true };
  for (const file of SETTINGS_FILES) {
    let user;
    try {
      user = parseJsonc(fs.readFileSync(file, 'utf8'));
    } catch (_) {
      continue;
    }
    for (const key of Object.keys(s)) {
      if (user[`audioCursor.${key}`] !== undefined) s[key] = user[`audioCursor.${key}`];
    }
    break;
  }
  // The offline system voice lives in VS Code's panel only.
  if (!s.voice || s.voice === 'system') s.voice = DEFAULT_VOICE;
  return s;
}

function looksLikeMarkdown(text) {
  return /^\s{0,3}(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)/m.test(text);
}

class StandaloneReader {
  constructor() {
    this._player = new HostAudioPlayer();
    this._engine = new HostSpeechEngine(this._player, neuralEngine);
    this._status = 'idle'; // 'idle' | 'playing' | 'paused'
    this._lastText = null;
    this._idleTimer = null;
    const id = `${process.pid}`;
    this._socketPath = path.join(controlDir(), `${id}.sock`);
    this._infoPath = path.join(controlDir(), `${id}.json`);

    this._engine.on('ended', () => this._finished('done'));
    this._engine.on('failure', ({ message }) => {
      log.error('Standalone read failed:', message);
      this._finished('failed');
    });
  }

  async listen() {
    fs.mkdirSync(controlDir(), { recursive: true, mode: 0o700 });
    const server = net.createServer(socket => this._handle(socket));
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(this._socketPath, resolve);
    });
    fs.chmodSync(this._socketPath, 0o600);
    fs.writeFileSync(this._infoPath, JSON.stringify({
      pid: process.pid, socket: this._socketPath, folders: [], focusedAt: 0, standalone: true
    }), { mode: 0o600 });
    this._server = server;
  }

  async read(text) {
    clearTimeout(this._idleTimer);
    if (this._status !== 'idle') this._engine.stop();
    if (!(await this._player.ensureStarted())) throw new Error('mpv could not be started');
    const s = settings();
    this._lastText = text;
    const snapshot = {
      text, uri: null, version: 0, startOffset: 0, endOffset: text.length,
      languageId: looksLikeMarkdown(text) ? 'markdown' : 'plaintext', fileName: 'agentmux',
      wordCount: text.split(/\s+/).filter(Boolean).length, charCount: text.length,
      fromCursor: false, source: 'terminal', external: true
    };
    const session = new Session(snapshot, {
      chunkSize: s.chunkSize,
      sanitizeCode: s.sanitizeCode,
      markdownProse: s.readMarkdownAsProse && snapshot.languageId === 'markdown'
    });
    log.info(`Standalone read: ${snapshot.wordCount} words, ${session.chunks.length} chunks, voice ${s.voice}.`);
    this._status = 'playing';
    this._engine.start(session, () => {
      const now = settings();
      return { voice: now.voice, rate: now.rate, pitch: now.pitch };
    });
  }

  async toggle() {
    if (this._status === 'playing') {
      this._engine.pause();
      this._status = 'paused';
    } else if (this._status === 'paused') {
      this._engine.resume();
      this._status = 'playing';
    } else if (this._lastText) {
      await this.read(this._lastText);
    }
  }

  _finished(why) {
    log.info(`Standalone read ${why}.`);
    this._status = 'idle';
    clearTimeout(this._idleTimer);
    this._idleTimer = setTimeout(() => this.exit(), IDLE_EXIT_MS);
  }

  /** @param {net.Socket} socket */
  _handle(socket) {
    let buffer = '';
    let started = false;
    socket.setEncoding('utf8');
    const reply = obj => socket.end(JSON.stringify(obj) + '\n');
    const handleLine = async line => {
      let request;
      try {
        request = JSON.parse(line);
      } catch (_) {
        return reply({ ok: false, error: 'not JSON' });
      }
      try {
        if (request && request.action === 'read' && typeof request.text === 'string' && request.text.trim()) {
          await this.read(request.text);
        } else if (request && request.action === 'toggle') {
          await this.toggle();
        } else {
          return reply({ ok: false, error: 'bad request' });
        }
        reply({ ok: true });
      } catch (err) {
        reply({ ok: false, error: String(err && err.message || err) });
      }
    };
    socket.on('data', chunk => {
      buffer += chunk;
      const nl = buffer.indexOf('\n');
      if (nl !== -1 && !started) {
        started = true;
        handleLine(buffer.slice(0, nl));
      }
    });
    socket.on('end', () => {
      if (!started && buffer.trim()) {
        started = true;
        handleLine(buffer);
      }
    });
    socket.on('error', () => {});
  }

  exit() {
    for (const p of [this._socketPath, this._infoPath]) {
      try { fs.rmSync(p, { force: true }); } catch (_) { /* gone already */ }
    }
    try { this._engine.stop(); } catch (_) { /* nothing playing */ }
    try { this._player.dispose(); } catch (_) { /* already down */ }
    process.exit(0);
  }
}

async function main() {
  if (!HostAudioPlayer.isSupported()) {
    process.stderr.write('Audio Cursor: reading without VS Code needs mpv on PATH.\n');
    process.exit(1);
  }
  const text = fs.readFileSync(0, 'utf8');
  if (!text.trim()) process.exit(0);

  const reader = new StandaloneReader();
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => reader.exit());
  await reader.listen();
  await reader.read(text);
}

main().catch(err => {
  process.stderr.write(`Audio Cursor: ${err && err.message || err}\n`);
  process.exit(1);
});
