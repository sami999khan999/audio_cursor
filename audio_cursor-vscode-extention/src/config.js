const vscode = require('vscode');

const CONFIG_SECTION = 'audioCursor';

const DEFAULTS = {
  voice: '',
  rate: 1.0,
  pitch: 1.0,
  highlightWord: true,
  followCursor: true,
  readFromCursorWhenNoSelection: true,
  statusBar: 'auto',
  autoRevealPanel: true,
  stopOnDocumentChange: false,
  chunkSize: 300,
  queueAhead: 12,
  sanitizeCode: false,
  watchTerminalSelection: true,
  watchPreviewSelection: true,
  readMarkdownAsProse: true
};

function clamp(val, min, max) {
  if (typeof val !== 'number' || isNaN(val)) return min;
  return Math.min(Math.max(val, min), max);
}

class ConfigManager {
  constructor() {
    this._listeners = new Set();
    this._disposable = vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(CONFIG_SECTION)) {
        const settings = this.getAll();
        for (const listener of this._listeners) {
          try {
            listener(settings, e);
          } catch (err) {
            console.error('Error in audioCursor config listener', err);
          }
        }
      }
    });
  }

  get(key) {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    switch (key) {
      case 'voice': {
        const val = config.get('voice', DEFAULTS.voice);
        return typeof val === 'string' ? val : DEFAULTS.voice;
      }
      case 'rate': {
        const val = config.get('rate', DEFAULTS.rate);
        return clamp(typeof val === 'number' ? val : DEFAULTS.rate, 0.5, 2.0);
      }
      case 'pitch': {
        const val = config.get('pitch', DEFAULTS.pitch);
        return clamp(typeof val === 'number' ? val : DEFAULTS.pitch, 0.0, 2.0);
      }
      case 'highlightWord': {
        const val = config.get('highlightWord', DEFAULTS.highlightWord);
        return Boolean(val);
      }
      case 'followCursor': {
        const val = config.get('followCursor', DEFAULTS.followCursor);
        return Boolean(val);
      }
      case 'readFromCursorWhenNoSelection': {
        const val = config.get('readFromCursorWhenNoSelection', DEFAULTS.readFromCursorWhenNoSelection);
        return Boolean(val);
      }
      case 'statusBar': {
        const val = config.get('statusBar', DEFAULTS.statusBar);
        return ['auto', 'always', 'never'].includes(val) ? val : DEFAULTS.statusBar;
      }
      case 'autoRevealPanel': {
        const val = config.get('autoRevealPanel', DEFAULTS.autoRevealPanel);
        return Boolean(val);
      }
      case 'stopOnDocumentChange': {
        const val = config.get('stopOnDocumentChange', DEFAULTS.stopOnDocumentChange);
        return Boolean(val);
      }
      case 'chunkSize': {
        const val = config.get('chunkSize', DEFAULTS.chunkSize);
        return Math.round(clamp(typeof val === 'number' ? val : DEFAULTS.chunkSize, 100, 1000));
      }
      case 'queueAhead': {
        const val = config.get('queueAhead', DEFAULTS.queueAhead);
        return Math.round(clamp(typeof val === 'number' ? val : DEFAULTS.queueAhead, 1, 50));
      }
      case 'sanitizeCode': {
        const val = config.get('sanitizeCode', DEFAULTS.sanitizeCode);
        return Boolean(val);
      }
      default:
        return config.get(key);
    }
  }

  getAll() {
    return {
      voice: this.get('voice'),
      rate: this.get('rate'),
      pitch: this.get('pitch'),
      highlightWord: this.get('highlightWord'),
      followCursor: this.get('followCursor'),
      readFromCursorWhenNoSelection: this.get('readFromCursorWhenNoSelection'),
      statusBar: this.get('statusBar'),
      autoRevealPanel: this.get('autoRevealPanel'),
      stopOnDocumentChange: this.get('stopOnDocumentChange'),
      chunkSize: this.get('chunkSize'),
      queueAhead: this.get('queueAhead'),
      sanitizeCode: this.get('sanitizeCode')
    };
  }

  async set(key, value) {
    const config = vscode.workspace.getConfiguration(CONFIG_SECTION);
    await config.update(key, value, vscode.ConfigurationTarget.Global);
  }

  onDidChange(listener) {
    this._listeners.add(listener);
    return {
      dispose: () => {
        this._listeners.delete(listener);
      }
    };
  }

  dispose() {
    this._listeners.clear();
    if (this._disposable) {
      this._disposable.dispose();
    }
  }
}

const configManager = new ConfigManager();

module.exports = {
  config: configManager,
  DEFAULTS
};
