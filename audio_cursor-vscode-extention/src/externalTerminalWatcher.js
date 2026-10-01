const vscode = require('vscode');
const { spawn, execFile } = require('child_process');
const net = require('net');
const path = require('path');
const log = require('./log');
const { createTextSnapshot } = require('./selection');

// The class kitty-pair gives the terminal beside a VS Code window on Hyprland:
// `code-term-<address of that VS Code window>`.
const PAIR_PREFIX = 'code-term-';
const CODE_CLASSES = new Set(['code', 'com.microsoft.VSCode', 'code-oss', 'Code']);
const APP_SUFFIX = ' - Visual Studio Code';
const DEBOUNCE_MS = 50;

function run(cmd, args) {
  return new Promise(resolve => {
    execFile(cmd, args, { timeout: 2000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

async function hyprJson(what) {
  const out = await run('hyprctl', [what, '-j']);
  try {
    return out ? JSON.parse(out) : null;
  } catch (_) {
    return null;
  }
}

/** The folder part of a VS Code title ("file - folder - Visual Studio Code"). */
function titleFolder(title) {
  if (!title || !title.endsWith(APP_SUFFIX)) return null;
  const parts = title.slice(0, -APP_SUFFIX.length).split(' - ');
  return parts[parts.length - 1].replace(/^●/, '').trim() || null;
}

/**
 * Watches the terminal that sits *outside* VS Code, beside this window — the
 * kitty that kitty-pair opens next to each VS Code window on Hyprland.
 *
 * Selecting text in kitty sets the Wayland primary selection. `wl-paste
 * --watch` reports every change to it; a change counts only when the window
 * focused at that moment is the kitty paired with this VS Code window (matched
 * through its class and this window's title), so selections in the editor, the
 * browser or another project's kitty never land here. The focus is followed
 * live through Hyprland's event socket rather than asked for afterwards: after a
 * drag-select the mouse is already on its way out, and with focus following the
 * mouse another window had the focus by the time a query ran. Read-only: nothing is ever written
 * to the primary selection or the clipboard.
 */
class ExternalTerminalWatcher {
  /**
   * @param {import('./config').config} config
   */
  constructor(config) {
    this._config = config;
    this._listeners = new Set();
    this._proc = null;
    this._socket = null;
    this._timer = null;
    /** Address of the focused window, kept current from Hyprland's events. */
    this._focused = null;
    /** Focused window when the pending selection change happened. */
    this._changedIn = null;
    this._seeded = false;
    this._disposed = false;

    if (ExternalTerminalWatcher.isSupported()) {
      this._start();
    }
  }

  static isSupported() {
    return process.platform === 'linux'
      && Boolean(process.env.WAYLAND_DISPLAY)
      && Boolean(process.env.HYPRLAND_INSTANCE_SIGNATURE);
  }

  /**
   * @param {(snapshot: Object) => void} listener
   * @returns {vscode.Disposable}
   */
  onDidChange(listener) {
    this._listeners.add(listener);
    return { dispose: () => this._listeners.delete(listener) };
  }

  _start() {
    this._followFocus();

    // `--watch` runs the command once per change (and once at start, which is
    // skipped); the selection itself is read afterwards, only when the paired
    // terminal had the focus as it changed.
    let proc;
    try {
      proc = spawn('wl-paste', ['--primary', '--watch', 'echo', 'change'], { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (err) {
      log.warn('External terminal watcher unavailable (wl-paste):', err);
      return;
    }
    this._proc = proc;
    proc.on('error', err => {
      log.warn('External terminal watcher unavailable (wl-paste):', err.message);
      this._proc = null;
    });
    proc.on('exit', () => {
      if (this._proc === proc) this._proc = null;
    });
    proc.stdout.on('data', () => {
      if (!this._seeded) {
        this._seeded = true;
        return;
      }
      this._changedIn = this._focused;
      clearTimeout(this._timer);
      this._timer = setTimeout(() => this._check(this._changedIn), DEBOUNCE_MS);
    });
  }

  /** Keep `_focused` on the focused window's address via Hyprland's socket2. */
  _followFocus() {
    hyprJson('activewindow').then(w => {
      if (this._focused === null && w && w.address) this._focused = w.address;
    });

    const dir = path.join(process.env.XDG_RUNTIME_DIR || '/tmp', 'hypr', process.env.HYPRLAND_INSTANCE_SIGNATURE);
    const socket = net.createConnection(path.join(dir, '.socket2.sock'));
    this._socket = socket;
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => {
      buffer += chunk;
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) {
        if (line.startsWith('activewindowv2>>')) {
          const addr = line.slice('activewindowv2>>'.length).trim();
          this._focused = addr ? `0x${addr.replace(/^0x/, '')}` : null;
        }
      }
    });
    socket.on('error', err => log.warn('Hyprland event socket unavailable:', err.message));
    socket.on('close', () => {
      // Hyprland restarted or the socket dropped: reconnect while still in use.
      if (!this._disposed && this._socket === socket) {
        setTimeout(() => { if (!this._disposed) this._followFocus(); }, 2000);
      }
    });
  }

  /** @param {string | null} focusedAddress window focused when the selection changed */
  async _check(focusedAddress) {
    if (this._disposed || !focusedAddress || !this._config.get('watchTerminalSelection')) return;

    const clients = await hyprJson('clients');
    if (!Array.isArray(clients)) return;
    const term = clients.find(c => c.address === focusedAddress);
    if (!term || typeof term.class !== 'string' || !term.class.startsWith(PAIR_PREFIX)) return;
    if (!this._isPairedWithThisWindow(clients, term.class.slice(PAIR_PREFIX.length))) return;

    // Selecting the same text again still counts: something else may have
    // been loaded into the player in between.
    const text = await run('wl-paste', ['--primary', '--no-newline']);
    if (text === null) return;

    const snapshot = createTextSnapshot(text, { label: 'Terminal: kitty', source: 'terminal' });
    if (!snapshot) return;
    snapshot.external = true;

    log.info(`External terminal selection detected (${snapshot.wordCount} words).`);
    for (const listener of this._listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        log.error('Error in external terminal selection listener:', err);
      }
    }
  }

  /**
   * Every VS Code window runs its own copy of this extension, so each one has
   * to recognise its own terminal: the window at `address` must be a VS Code
   * window showing this window's folder.
   * @param {Array<Object>} clients `hyprctl clients -j`
   * @param {string} address
   */
  _isPairedWithThisWindow(clients, address) {
    const name = vscode.workspace.name;
    if (!name) return false;
    const code = clients.find(c => c.address === address);
    if (!code || !CODE_CLASSES.has(code.class)) return false;
    // Titles name the workspace as "folder (Workspace)" for .code-workspace files.
    const folder = titleFolder(code.title);
    return folder === name || folder === `${name} (Workspace)`;
  }

  dispose() {
    this._disposed = true;
    clearTimeout(this._timer);
    if (this._proc) {
      this._proc.kill();
      this._proc = null;
    }
    if (this._socket) {
      this._socket.destroy();
      this._socket = null;
    }
    this._listeners.clear();
  }
}

module.exports = {
  ExternalTerminalWatcher
};
