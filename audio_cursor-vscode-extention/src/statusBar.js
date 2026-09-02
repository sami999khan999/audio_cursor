const vscode = require('vscode');
const { formatEstimatedDuration } = require('./selection');

class StatusBarController {
  /**
   * @param {import('./config').config} config
   */
  constructor(config) {
    this._config = config;
    this._item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this._item.command = 'audioCursor.togglePlayback';

    this._state = {
      status: 'idle', // 'idle' | 'starting' | 'playing' | 'paused' | 'stopped'
      percent: 0,
      snapshot: null
    };

    this._lastUpdate = 0;
    this._pendingUpdateTimer = null;

    this.update();
  }

  /**
   * Update the status bar item with current state
   * @param {Partial<{ status: string, percent: number, snapshot: Object | null }>} [partialState]
   */
  update(partialState = {}) {
    Object.assign(this._state, partialState);

    const now = Date.now();
    if (now - this._lastUpdate < 200) {
      if (!this._pendingUpdateTimer) {
        this._pendingUpdateTimer = setTimeout(() => {
          this._pendingUpdateTimer = null;
          this._render();
        }, 200 - (now - this._lastUpdate));
      }
      return;
    }

    this._lastUpdate = now;
    this._render();
  }

  _render() {
    const mode = this._config.get('statusBar');
    if (mode === 'never') {
      this._item.hide();
      return;
    }

    const { status, percent, snapshot } = this._state;
    const rate = this._config.get('rate');

    switch (status) {
      case 'starting':
        this._item.text = '$(loading~spin) Audio Cursor';
        this._item.tooltip = 'Audio Cursor: Initializing playback...';
        this._item.show();
        break;

      case 'playing': {
        const rounded = Math.round(percent);
        this._item.text = `$(debug-pause) ${rounded}%`;
        this._item.tooltip = `Audio Cursor: Playing (${rounded}%) · Alt+P to pause`;
        this._item.show();
        break;
      }

      case 'paused': {
        const rounded = Math.round(percent);
        this._item.text = `$(play) Paused ${rounded}%`;
        this._item.tooltip = `Audio Cursor: Paused (${rounded}%) · Alt+P to resume`;
        this._item.show();
        break;
      }

      case 'idle':
      case 'stopped':
      default: {
        if (snapshot && snapshot.text && snapshot.text.trim()) {
          const words = snapshot.wordCount || 0;
          const duration = formatEstimatedDuration(words, rate);
          this._item.text = '$(play) Read';
          this._item.tooltip = `${words} words · ~${duration} · Alt+P to read`;
          this._item.show();
        } else if (mode === 'always') {
          this._item.text = '$(play) Audio Cursor';
          this._item.tooltip = 'Audio Cursor: Select text to read aloud · Alt+P';
          this._item.show();
        } else {
          this._item.hide();
        }
        break;
      }
    }
  }

  dispose() {
    if (this._pendingUpdateTimer) {
      clearTimeout(this._pendingUpdateTimer);
    }
    this._item.dispose();
  }
}

module.exports = {
  StatusBarController
};
