const vscode = require('vscode');
const net = require('net');
const fs = require('fs');
const path = require('path');
const log = require('./log');
const { controlDir } = require('./externalControlDir');

const MAX_REQUEST = 4 * 1024 * 1024;


/**
 * Lets programs outside VS Code hand this window text to read — agentmux's
 * "read aloud" key, for one. Each window listens on its own Unix socket,
 * `$XDG_RUNTIME_DIR/audio-cursor/<pid>.sock`, and describes itself beside it
 * in `<pid>.json` (its folders and when it last had the focus), so a client
 * can pick the window of the project the text came from.
 *
 * A request is one JSON line: `{"action": "read", "text": "…"}` reads the
 * text, `{"action": "toggle"}` pauses, resumes or replays. The reply is one
 * JSON line, `{"ok": true}` or `{"ok": false, "error": "…"}`. Nothing listens
 * on Windows; everything VS Code does on its own is unaffected.
 */
class ExternalControl {
  constructor() {
    this._listeners = new Set();
    this._server = null;
    this._focusedAt = 0;
    this._disposables = [];
    const id = `${process.pid}`;
    this._socketPath = path.join(controlDir(), `${id}.sock`);
    this._infoPath = path.join(controlDir(), `${id}.json`);

    if (ExternalControl.isSupported()) {
      this._start();
    }
  }

  static isSupported() {
    return process.platform !== 'win32';
  }

  /**
   * @param {(request: { action: string, text?: string }) => Promise<void> | void} listener
   * @returns {vscode.Disposable}
   */
  onRequest(listener) {
    this._listeners.add(listener);
    return { dispose: () => this._listeners.delete(listener) };
  }

  _start() {
    try {
      fs.mkdirSync(controlDir(), { recursive: true, mode: 0o700 });
      fs.rmSync(this._socketPath, { force: true });
    } catch (err) {
      log.warn('External control unavailable:', err.message);
      return;
    }

    const server = net.createServer(socket => this._handle(socket));
    server.on('error', err => log.warn('External control socket error:', err.message));
    // Never what keeps a process alive.
    server.unref();
    server.listen(this._socketPath, () => {
      try { fs.chmodSync(this._socketPath, 0o600); } catch (_) { /* best effort */ }
      this._writeInfo();
    });
    this._server = server;

    if (vscode.window.state.focused) this._focusedAt = Date.now();
    this._disposables.push(
      vscode.window.onDidChangeWindowState(state => {
        if (state.focused) {
          this._focusedAt = Date.now();
          this._writeInfo();
        }
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this._writeInfo())
    );
  }

  _writeInfo() {
    if (!this._server) return;
    const info = {
      pid: process.pid,
      socket: this._socketPath,
      folders: (vscode.workspace.workspaceFolders || [])
        .filter(f => f.uri.scheme === 'file')
        .map(f => f.uri.fsPath),
      focusedAt: this._focusedAt
    };
    try {
      fs.writeFileSync(this._infoPath, JSON.stringify(info), { mode: 0o600 });
    } catch (err) {
      log.warn('External control: could not describe this window:', err.message);
    }
  }

  /** @param {net.Socket} socket */
  _handle(socket) {
    let buffer = '';
    let done = false;
    let started = false;
    socket.setEncoding('utf8');
    const reply = (obj) => {
      if (done) return;
      done = true;
      socket.end(JSON.stringify(obj) + '\n');
    };
    const handleLine = async (line) => {
      let request;
      try {
        request = JSON.parse(line);
      } catch (_) {
        return reply({ ok: false, error: 'not JSON' });
      }
      if (!request || (request.action !== 'read' && request.action !== 'toggle')) {
        return reply({ ok: false, error: 'unknown action' });
      }
      if (request.action === 'read' && (typeof request.text !== 'string' || !request.text.trim())) {
        return reply({ ok: false, error: 'no text' });
      }
      try {
        for (const listener of this._listeners) await listener(request);
        reply({ ok: true });
      } catch (err) {
        log.error('External control request failed:', err);
        reply({ ok: false, error: String(err && err.message || err) });
      }
    };
    socket.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > MAX_REQUEST) {
        reply({ ok: false, error: 'too large' });
        return;
      }
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

  dispose() {
    for (const d of this._disposables) d.dispose();
    this._disposables = [];
    this._listeners.clear();
    if (this._server) {
      this._server.close();
      this._server = null;
      for (const p of [this._socketPath, this._infoPath]) {
        try { fs.rmSync(p, { force: true }); } catch (_) { /* gone already */ }
      }
    }
  }
}

module.exports = {
  ExternalControl,
  controlDir
};
