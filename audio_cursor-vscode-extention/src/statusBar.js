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

  /**
   * Assign text and tooltip only when they change. VS Code redraws an open
   * hover whenever the tooltip is reassigned, so a tooltip carrying the
   * percentage made it vanish and reappear on every percent while hovered.
   */
  _set(text, tooltip) {
    if (this._item.text !== text) this._item.text = text;
    if (this._item.tooltip !== tooltip) this._item.tooltip = tooltip;
    this._item.show();
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
        this._set('$(loading~spin) Audio Cursor', 'Audio Cursor: Initializing playback...');
        break;

      // The percentage lives in the text only: see _set.
      case 'playing':
        this._set(`$(debug-pause) ${Math.round(percent)}%`, 'Audio Cursor: Playing · Alt+P to pause');
        break;

      case 'paused':
        this._set(`$(play) Paused ${Math.round(percent)}%`, 'Audio Cursor: Paused · Alt+P to resume');
        break;

      case 'idle':
      case 'stopped':
      default: {
        if (snapshot && snapshot.text && snapshot.text.trim()) {
          const words = snapshot.wordCount || 0;
          const duration = formatEstimatedDuration(words, rate);
          this._set('$(play) Read', `${words} words · ~${duration} · Alt+P to read`);
        } else if (mode === 'always') {
          this._set('$(play) Audio Cursor', 'Audio Cursor: Select text to read aloud · Alt+P');
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
