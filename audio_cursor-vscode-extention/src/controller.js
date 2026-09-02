const vscode = require('vscode');
const log = require('./log');
const { Session } = require('./session');
const { ProgressTracker } = require('./progress');
const { getSnapshot, createTextSnapshot } = require('./selection');
const { neuralEngine } = require('./neuralEngine');

class AudioCursorController {
  /**
   * @param {Object} params
   * @param {import('./config').config} params.config
   * @param {import('./selection').SelectionTracker} params.selectionTracker
   * @param {import('./statusBar').StatusBarController} params.statusBar
   * @param {import('./decorations').DecorationController} params.decorations
   * @param {import('./view/provider').AudioCursorViewProvider} params.viewProvider
   * @param {vscode.Memento} [params.memento]
   */
  constructor({ config, selectionTracker, statusBar, decorations, viewProvider, memento }) {
    this._config = config;
    this._memento = memento || null;
    this._selectionTracker = selectionTracker;
    this._statusBar = statusBar;
    this._decorations = decorations;
    this._viewProvider = viewProvider;

    /** @type {Session | null} */
    this._session = null;
    this._gesturePromptedSession = null;
    this._status = 'idle'; // 'idle' | 'starting' | 'playing' | 'paused' | 'stopped'
    this._progressTracker = new ProgressTracker();
    this._neuralVoices = neuralEngine.getVoicesSync();
    this._localVoices = [];
    this._availableVoices = [...this._neuralVoices];
    this._disposables = [];

    this._initNeuralVoices();
    this._setupListeners();
    this._updateContextKeys();
  }

  async _initNeuralVoices() {
    try {
      this._neuralVoices = await neuralEngine.getVoices();
      this._mergeAndPublishVoices();
    } catch (err) {
      log.warn('Could not refresh neural voices:', err);
    }
  }

  _mergeAndPublishVoices() {
    const combined = [...this._neuralVoices, ...this._localVoices];
    this._availableVoices = combined;
    if (combined.length > 0) {
      this._viewProvider.postMessage({
        type: 'allVoices',
        voices: combined
      });
    }
  }

  _setupListeners() {
    // 1. Selection change listener
    this._disposables.push(
      this._selectionTracker.onSelectionChanged((snapshot, cause) => {
        // A new selection never starts playback on its own; it only ever
        // replaces what the player is pointed at. If something is playing,
        // it stops first so the old text does not keep reading.
        const isActive = this._status === 'playing' || this._status === 'paused' || this._status === 'starting';

        if (isActive) {
          if (cause === 'selection' && this._isDifferentSelection(snapshot)) {
            log.info('Selection changed during playback; stopping playback.');
            this.stop();
            this._statusBar.update({ snapshot });
            this._publishSnapshot(snapshot, 'selectionChanged');
          }
          // Otherwise (tab switch, edit) keep the player pinned to the text
          // that is actually being read, so highlighting stays in sync.
          return;
        }

        this._statusBar.update({ snapshot });
        this._publishSnapshot(snapshot);
      })
    );

    // 2. Config change listener
    this._disposables.push(
      this._config.onDidChange((settings) => {
        this._viewProvider.postMessage({
          type: 'settings',
          settings
        });
        this._statusBar.update();
      })
    );

    // 3. Webview message listener
    this._disposables.push(
      this._viewProvider.onMessage((msg) => this._handleWebviewMessage(msg))
    );

    // 4. Terminal availability (there is no terminal-selection event in the
    //    VS Code API, so the view offers an explicit capture button instead).
    this._disposables.push(
      vscode.window.onDidOpenTerminal(() => this._publishTerminalState()),
      vscode.window.onDidCloseTerminal(() => this._publishTerminalState()),
      vscode.window.onDidChangeActiveTerminal(() => this._publishTerminalState())
    );

    // 5. Webview ready listener
    this._disposables.push(
      this._viewProvider.onReady(() => {
        const snapshot = this._selectionTracker.getSnapshot(false);
        this._viewProvider.postMessage({
          type: 'init',
          settings: this._config.getAll(),
          snapshot,
          voices: this._availableVoices
        });
        this._publishTerminalState();
        if (this._session) {
          this._viewProvider.postMessage({
            type: 'state',
            status: this._status,
            percent: this._session.percent()
          });
        }
      })
    );
  }

  _handleWebviewMessage(msg) {
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'voices':
        this._localVoices = msg.voices || [];
        this._mergeAndPublishVoices();
        log.info(`Loaded ${this._localVoices.length} local system voices from webview`);
        break;

      case 'requestNeuralAudio':
        (async () => {
          try {
            const { audioBase64 } = await neuralEngine.synthesize(
              msg.text,
              msg.voice,
              msg.rate,
              msg.pitch
            );
            this._viewProvider.postMessage({
              type: 'neuralAudio',
              sessionId: msg.sessionId,
              chunkIndex: msg.chunkIndex,
              audioBase64
            });
          } catch (err) {
            log.error('Neural synthesis failed for chunk ' + msg.chunkIndex, err);
            this._viewProvider.postMessage({
              type: 'neuralAudioError',
              sessionId: msg.sessionId,
              chunkIndex: msg.chunkIndex,
              message: err.message || 'Synthesis failed'
            });
          }
        })();
        break;

      case 'started':
        if (this._session && !this._session.isStale(msg.sessionId)) {
          this._setStatus('playing');
        }
        break;

      case 'progress':
        if (this._session && !this._session.isStale(msg.sessionId)) {
          this._session.cursorChar = msg.charIndex;
          this._session.cursorChunk = msg.chunkIndex;
          this._progressTracker.onEvent(msg.charIndex);

          const editor = vscode.window.activeTextEditor;
          const { docChanged } = this._decorations.highlight(
            editor,
            this._session.snapshot,
            msg.charIndex,
            msg.charLength
          );

          if (docChanged && this._config.get('stopOnDocumentChange')) {
            log.warn('Document changed during playback; stopping playback as per configuration');
            this.stop();
            vscode.window.showInformationMessage('Audio Cursor: Playback stopped because document was edited.');
            return;
          }

          this._statusBar.update({
            status: 'playing',
            percent: this._session.percent()
          });
        }
        break;

      case 'chunkEnded':
        if (this._session && !this._session.isStale(msg.sessionId)) {
          const queueAhead = this._config.get('queueAhead') || 12;
          const nextChunks = this._session.nextWindow(queueAhead);
          if (nextChunks.length > 0) {
            this._viewProvider.postMessage({
              type: 'enqueue',
              sessionId: this._session.id,
              chunks: nextChunks
            });
          }
        }
        break;

      case 'ended':
        if (this._session && !this._session.isStale(msg.sessionId)) {
          log.info('Playback completed successfully');
          this._finishSession();
        }
        break;

      case 'requireGesture':
        if (this._session && !this._session.isStale(msg.sessionId)) {
          log.info('Audio playback ready. Waiting for user activation on sidebar player.');
          vscode.commands.executeCommand('audioCursor.player.focus');
          // Only prompt once per session; the webview may re-request per chunk.
          if (this._gesturePromptedSession === msg.sessionId) return;
          this._gesturePromptedSession = msg.sessionId;
          vscode.window.showInformationMessage(
            'Audio Cursor: Click the sidebar player panel once to allow audio playback.',
            'Focus Player'
          ).then(choice => {
            if (choice === 'Focus Player') {
              this.openPanel();
            }
          });
        }
        break;

      case 'error':
        if (this._session && !this._session.isStale(msg.sessionId)) {
          const text = msg.message || msg.code || '';
          const isGesture = text.includes('user gesture') ||
            text.includes('NotAllowedError') ||
            text.includes('not-allowed');
          if (isGesture) {
            log.info('Audio playback waiting for user gesture.');
            vscode.commands.executeCommand('audioCursor.player.focus');
            return;
          }
          log.error('Webview speech engine error:', text);
          this._finishSession();
          vscode.window.showErrorMessage(
            `Audio Cursor TTS error: ${text || 'Unknown error'}`,
            'Show Logs'
          ).then(choice => {
            if (choice === 'Show Logs') {
              this.showLogs();
            }
          });
        }
        break;

      case 'command':
        this._handleCommandAction(msg.action, msg);
        break;

      case 'setSetting':
        if (msg.key && msg.value !== undefined) {
          this._config.set(msg.key, msg.value);
        }
        break;
    }
  }

  _handleCommandAction(action, payload = {}) {
    switch (action) {
      case 'play':
        // The player is showing terminal output: re-read the live terminal
        // selection rather than whatever the editor is pointed at.
        if (payload.source === 'terminal' && vscode.window.activeTerminal) {
          this.readTerminalSelection();
        } else {
          this.play();
        }
        break;
      case 'pause':
        this.pause();
        break;
      case 'resume':
        this.resume();
        break;
      case 'stop':
        this.stop();
        break;
      case 'seek':
        if (typeof payload.charIndex === 'number') {
          this.seek(payload.charIndex);
        }
        break;
      case 'nextSentence':
        this.nextSentence();
        break;
      case 'previousSentence':
        this.previousSentence();
        break;
      case 'readTerminal':
        this.readTerminalSelection();
        break;
      case 'openSettings':
        vscode.commands.executeCommand('workbench.action.openSettings', 'audioCursor');
        break;
    }
  }

  /**
   * True when the incoming snapshot points at different text than the one
   * currently being read.
   * @param {Object | null} snapshot
   * @returns {boolean}
   */
  _isDifferentSelection(snapshot) {
    const current = this._session && this._session.snapshot;
    if (!current) return false;
    if (!snapshot) return true;

    const sameDoc = String(current.uri || '') === String(snapshot.uri || '');
    if (sameDoc && current.version !== snapshot.version) {
      // The document was edited rather than re-selected; that case belongs to
      // the `stopOnDocumentChange` setting, not to selection tracking.
      return false;
    }

    return !sameDoc ||
      current.startOffset !== snapshot.startOffset ||
      current.endOffset !== snapshot.endOffset ||
      current.text !== snapshot.text;
  }

  /**
   * Push a snapshot to the player view so the preview always matches the
   * current selection, playing or not.
   * @param {Object | null} snapshot
   * @param {string} [reason]
   */
  _publishSnapshot(snapshot, reason) {
    this._viewProvider.postMessage({
      type: 'selection',
      reason,
      ...(snapshot || {}),
      uri: snapshot && snapshot.uri ? snapshot.uri.toString() : null
    });
  }

  _publishTerminalState() {
    this._viewProvider.postMessage({
      type: 'terminalState',
      hasTerminal: vscode.window.terminals.length > 0
    });
  }

  _setStatus(status) {
    this._status = status;
    if (this._session) {
      this._session.status = status;
    }
    this._updateContextKeys();
    this._statusBar.update({
      status,
      percent: this._session ? this._session.percent() : 0,
      snapshot: this._session ? this._session.snapshot : this._selectionTracker.getSnapshot(false)
    });
  }

  _updateContextKeys() {
    vscode.commands.executeCommand('setContext', 'audioCursor.playing', this._status === 'playing');
    vscode.commands.executeCommand('setContext', 'audioCursor.paused', this._status === 'paused');
  }

  _finishSession() {
    this._setStatus('idle');
    this._decorations.clear();
    this._session = null;
    this._gesturePromptedSession = null;
    this._progressTracker.reset();
  }

  async _ensureWebviewReady() {
    if (this._viewProvider.isReady()) {
      return true;
    }

    if (this._config.get('autoRevealPanel')) {
      try {
        await vscode.commands.executeCommand('audioCursor.player.focus');
        // Give up to 1.5 seconds for webview to load
        for (let i = 0; i < 15; i++) {
          if (this._viewProvider.isReady()) return true;
          await new Promise(resolve => setTimeout(resolve, 100));
        }
      } catch (err) {
        log.warn('Could not focus audio cursor webview:', err);
      }
    }

    return this._viewProvider.isReady();
  }

  // --- Public Command Methods ---

  async togglePlayback() {
    if (this._status === 'playing') {
      this.pause();
    } else if (this._status === 'paused') {
      this.resume();
    } else {
      await this.play();
    }
  }

  async play(customSnapshot = null) {
    let snapshot = customSnapshot || this._selectionTracker.getSnapshot(false);

    // Nothing in any editor: fall back to whatever is selected in the terminal.
    if (!snapshot && !customSnapshot && vscode.window.activeTerminal) {
      snapshot = await this._captureTerminalSelection();
    }

    if (!snapshot || !snapshot.text || !snapshot.text.trim()) {
      vscode.window.showInformationMessage('Audio Cursor: No text selected to read.');
      return;
    }

    const isReady = await this._ensureWebviewReady();
    if (!isReady) {
      vscode.window.showWarningMessage(
        'Audio Cursor player view is not initialized. Please open the Audio Cursor sidebar tab to begin.',
        'Open Player'
      ).then(choice => {
        if (choice === 'Open Player') {
          this.openPanel();
        }
      });
      return;
    }

    // Stop current session if any
    if (this._session) {
      this._viewProvider.postMessage({ type: 'stop', sessionId: this._session.id });
    }

    const chunkSize = this._config.get('chunkSize');
    const queueAhead = this._config.get('queueAhead');
    const sanitizeCode = this._config.get('sanitizeCode');

    this._session = new Session(snapshot, { chunkSize, sanitizeCode });
    this._progressTracker.reset();
    this._setStatus('starting');

    // Keep the player preview in sync with what is actually being read
    // (terminal text and cursor-to-end reads never come from a selection event).
    this._publishSnapshot(snapshot);

    const firstBatch = this._session.nextWindow(queueAhead);

    log.info(`Starting speech session ${this._session.id} (${snapshot.wordCount} words, ${this._session.chunks.length} chunks)`);

    this._viewProvider.postMessage({
      type: 'speak',
      sessionId: this._session.id,
      chunks: firstBatch,
      startIndex: 0,
      voice: this._config.get('voice'),
      rate: this._config.get('rate'),
      pitch: this._config.get('pitch')
    });
  }

  pause() {
    if (this._status !== 'playing' || !this._session) return;
    this._setStatus('paused');
    this._progressTracker.pause();
    this._viewProvider.postMessage({
      type: 'pause',
      sessionId: this._session.id
    });
  }

  resume() {
    if (this._status !== 'paused' || !this._session) return;
    this._setStatus('playing');
    this._progressTracker.resume();
    this._viewProvider.postMessage({
      type: 'resume',
      sessionId: this._session.id
    });
  }

  stop() {
    if (this._session) {
      this._viewProvider.postMessage({
        type: 'stop',
        sessionId: this._session.id
      });
    }
    this._finishSession();
  }

  seek(charIndex) {
    if (!this._session) {
      const snap = this._selectionTracker.getSnapshot(false);
      if (snap) {
        this.play(snap);
      }
      return;
    }

    const { chunkIndex, newSessionId } = this._session.seekTo(charIndex);
    const queueAhead = this._config.get('queueAhead');
    const chunks = this._session.nextWindow(queueAhead);

    this._setStatus('playing');
    this._viewProvider.postMessage({
      type: 'speak',
      sessionId: newSessionId,
      chunks,
      startIndex: chunkIndex,
      voice: this._config.get('voice'),
      rate: this._config.get('rate'),
      pitch: this._config.get('pitch')
    });
  }

  /**
   * Read the active terminal's selection. VS Code has no stable API for
   * terminal selections, so the text is lifted via the terminal's own copy
   * command with the user's clipboard saved and restored around it.
   * @returns {Promise<Object | null>}
   */
  async _captureTerminalSelection() {
    const terminal = vscode.window.activeTerminal;
    if (!terminal) return null;

    const previousClipboard = await vscode.env.clipboard.readText();
    const sentinel = `__audioCursor__${Date.now()}__`;
    let copied = '';

    try {
      await vscode.env.clipboard.writeText(sentinel);
      await vscode.commands.executeCommand('workbench.action.terminal.copySelection');

      // The copy lands asynchronously in the renderer; poll briefly for it.
      for (let i = 0; i < 12; i++) {
        copied = await vscode.env.clipboard.readText();
        if (copied !== sentinel) break;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    } catch (err) {
      log.warn('Could not read terminal selection:', err);
      copied = sentinel;
    } finally {
      await vscode.env.clipboard.writeText(previousClipboard);
    }

    if (!copied || copied === sentinel || !copied.trim()) {
      return null;
    }

    return createTextSnapshot(copied, {
      label: terminal.name ? `Terminal: ${terminal.name}` : 'Terminal',
      source: 'terminal'
    });
  }

  async readTerminalSelection() {
    if (!vscode.window.activeTerminal) {
      const hint = vscode.window.terminals.length > 0
        ? 'Audio Cursor: Click into a terminal first, then select the text to read.'
        : 'Audio Cursor: No terminal is open.';
      vscode.window.showInformationMessage(hint);
      return;
    }

    const snapshot = await this._captureTerminalSelection();
    if (!snapshot) {
      log.info('Terminal read requested but the terminal had no selection.');
      vscode.window.showInformationMessage(
        'Audio Cursor: Select some text in the terminal first, then read it again.'
      );
      return;
    }

    log.info(`Read terminal selection (${snapshot.wordCount} words) from "${snapshot.fileName}".`);
    await this.play(snapshot);
    this._offerTerminalKeybinding();
  }

  /**
   * The extension contributes `audioCursor.readTerminalSelection` to
   * `terminal.integrated.commandsToSkipShell` so Alt+P is handled by VS Code
   * instead of the shell. A user-defined value for that setting replaces our
   * contributed default, so offer to add it back — once.
   */
  async _offerTerminalKeybinding() {
    const COMMAND = 'audioCursor.readTerminalSelection';
    if (!this._memento || this._memento.get('skipShellPrompted')) return;

    const cfg = vscode.workspace.getConfiguration('terminal.integrated');
    const info = cfg.inspect('commandsToSkipShell');
    const userValue = (info && (info.workspaceValue || info.globalValue)) || null;
    if (!Array.isArray(userValue)) return;
    if (userValue.includes(COMMAND) || userValue.includes(`-${COMMAND}`)) return;

    await this._memento.update('skipShellPrompted', true);
    const choice = await vscode.window.showInformationMessage(
      'Audio Cursor: enable Alt+P inside the terminal? Your own `terminal.integrated.commandsToSkipShell` setting currently sends that key to the shell instead.',
      'Enable',
      'Not now'
    );

    if (choice === 'Enable') {
      await cfg.update('commandsToSkipShell', [...userValue, COMMAND], vscode.ConfigurationTarget.Global);
      log.info('Added audioCursor.readTerminalSelection to terminal.integrated.commandsToSkipShell.');
    }
  }

  async readSelection() {
    const editor = vscode.window.activeTextEditor;
    const snap = getSnapshot(editor, { readFromCursorWhenNoSelection: false });
    if (!snap) {
      vscode.window.showInformationMessage('Audio Cursor: No active selection found.');
      return;
    }
    await this.play(snap);
  }

  async readFromCursor() {
    const editor = vscode.window.activeTextEditor;
    const snap = getSnapshot(editor, { readFromCursorWhenNoSelection: true });
    if (!snap) {
      vscode.window.showInformationMessage('Audio Cursor: No text found to read from cursor.');
      return;
    }
    await this.play(snap);
  }

  nextSentence() {
    if (!this._session) return;
    const nextChar = this._session.findNextSentence();
    this.seek(nextChar);
  }

  previousSentence() {
    if (!this._session) return;
    const prevChar = this._session.findPreviousSentence();
    this.seek(prevChar);
  }

  async selectVoice() {
    if (!this._availableVoices || this._availableVoices.length === 0) {
      this._availableVoices = neuralEngine.getVoicesSync();
    }

    const currentVoice = this._config.get('voice');
    const items = [
      {
        label: '$(device-desktop) System Default Voice',
        description: 'Use the operating system default voice',
        value: '',
        picked: currentVoice === ''
      }
    ];

    const neuralEnglish = [];
    const neuralOther = [];
    const localVoices = [];

    for (const v of this._availableVoices) {
      if (v.isNeural) {
        if (v.lang && v.lang.startsWith('en-')) {
          neuralEnglish.push(v);
        } else {
          neuralOther.push(v);
        }
      } else {
        localVoices.push(v);
      }
    }

    if (neuralEnglish.length > 0) {
      items.push({
        label: 'Natural Neural AI Voices (English)',
        kind: vscode.QuickPickItemKind.Separator
      });
      for (const v of neuralEnglish) {
        items.push({
          label: `$(sparkle) ${v.name.replace(/^en-[A-Z]{2}-/, '').replace(/Neural$/, '')}`,
          description: `${v.lang.replace('en-', '').toUpperCase()}${v.gender ? ` · ${v.gender}` : ''} · Natural AI`,
          detail: v.friendlyName || v.name,
          value: v.name,
          picked: v.name === currentVoice || v.voiceURI === currentVoice
        });
      }
    }

    if (neuralOther.length > 0) {
      items.push({
        label: 'Natural Neural AI Voices (International)',
        kind: vscode.QuickPickItemKind.Separator
      });
      for (const v of neuralOther) {
        items.push({
          label: `$(sparkle) ${v.name.replace(/Neural$/, '')}`,
          description: `${v.lang} · Natural AI`,
          detail: v.friendlyName || v.name,
          value: v.name,
          picked: v.name === currentVoice || v.voiceURI === currentVoice
        });
      }
    }

    if (localVoices.length > 0) {
      items.push({
        label: 'Offline System Voices',
        kind: vscode.QuickPickItemKind.Separator
      });
      for (const v of localVoices) {
        items.push({
          label: `$(sound) ${v.name}`,
          description: `${v.lang || 'Local'} · Offline`,
          detail: v.voiceURI !== v.name ? v.voiceURI : undefined,
          value: v.name,
          picked: v.name === currentVoice || v.voiceURI === currentVoice
        });
      }
    }

    const selected = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a Text-to-Speech voice (300+ Natural AI & Local Voices)',
      matchOnDescription: true,
      matchOnDetail: true
    });

    if (selected && selected.value !== undefined) {
      await this._config.set('voice', selected.value);
      vscode.window.showInformationMessage(`Audio Cursor: Voice set to ${selected.label}`);
    }
  }

  async increaseRate() {
    const current = this._config.get('rate');
    const updated = Math.min(2.0, Math.round((current + 0.1) * 10) / 10);
    await this._config.set('rate', updated);
    vscode.window.setStatusBarMessage(`Audio Cursor Speed: ${updated.toFixed(1)}x`, 2500);
  }

  async decreaseRate() {
    const current = this._config.get('rate');
    const updated = Math.max(0.5, Math.round((current - 0.1) * 10) / 10);
    await this._config.set('rate', updated);
    vscode.window.setStatusBarMessage(`Audio Cursor Speed: ${updated.toFixed(1)}x`, 2500);
  }

  openPanel() {
    vscode.commands.executeCommand('audioCursor.player.focus');
  }

  showLogs() {
    log.show();
  }

  dispose() {
    this.stop();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
  }
}

module.exports = {
  AudioCursorController
};
