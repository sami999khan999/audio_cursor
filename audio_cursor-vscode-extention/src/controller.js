const vscode = require('vscode');
const log = require('./log');
const { Session } = require('./session');
const { ProgressTracker } = require('./progress');
const { getSnapshot, createTextSnapshot, getActivePreviewTarget, resolvePreviewSnapshot } = require('./selection');
const { ClipboardSelectionWatcher } = require('./clipboardWatcher');
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

    // Which surface the player is currently pointed at, and the last snapshot
    // captured from a terminal (terminals have no snapshot provider).
    this._lastSource = 'editor';
    /** @type {Object | null} */
    this._lastTerminalSnapshot = null;
    /** @type {{ key: string, snapshot: Object } | null} */
    this._lastPreviewSelection = null;
    this._clipboardWatcher = new ClipboardSelectionWatcher(config);
    this._status = 'idle'; // 'idle' | 'starting' | 'playing' | 'paused' | 'stopped'
    this._progressTracker = new ProgressTracker();
    this._neuralVoices = neuralEngine.getVoicesSync();
    this._localVoices = [];
    this._availableVoices = [...this._neuralVoices];
    this._disposables = [];

    this._initNeuralVoices();
    this._checkTerminalKeybinding();
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
            this._lastSource = 'editor';
            this._statusBar.update({ snapshot });
            this._publishSnapshot(snapshot, 'selectionChanged');
          }
          // Otherwise (tab switch, edit) keep the player pinned to the text
          // that is actually being read, so highlighting stays in sync.
          return;
        }

        if (cause === 'selection' || (snapshot && snapshot.source === 'preview')) {
          this._lastSource = 'editor';
        }
        // Activating a preview tab drops any selection copied out of it, and
        // says how to read part of the document rather than all of it — a
        // preview's own selection is invisible to extensions.
        if (snapshot && snapshot.source === 'preview' && !snapshot.rendered) {
          this._lastPreviewSelection = null;
          this._statusBar.update({ snapshot });
          this._publishSnapshot(snapshot, 'previewDocument');
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

    // 5. Terminal selection listener — same contract as the editor one:
    //    update the preview, stop anything playing, never start playback.
    this._disposables.push(
      this._clipboardWatcher.onDidChange((snapshot) => {
        const isActive = this._status === 'playing' || this._status === 'paused' || this._status === 'starting';
        if (isActive && !this._isDifferentSelection(snapshot)) return;

        if (isActive) {
          log.info(`${snapshot.source === 'preview' ? 'Preview' : 'Terminal'} selection changed during playback; stopping playback.`);
          this.stop();
        }

        if (snapshot.source === 'preview') {
          // A selection inside a preview replaces the whole-document snapshot
          // for that preview until the tab is re-activated.
          this._lastSource = 'editor';
          this._lastPreviewSelection = { key: snapshot.previewKey, snapshot };
        } else {
          this._lastSource = 'terminal';
          this._lastTerminalSnapshot = snapshot;
        }

        this._statusBar.update({ snapshot });
        this._publishSnapshot(snapshot, isActive ? 'selectionChanged' : undefined);
      })
    );

    // 6. Webview ready listener
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
          // Show the player so it can be clicked, but leave the caret alone —
          // the notification below is what asks for the click.
          this._revealPlayer({ preserveFocus: true });
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
            this._revealPlayer({ preserveFocus: true });
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
          // Play exactly what the preview is showing; only re-capture if the
          // watcher never saw a selection.
          this.togglePlaybackTerminal();
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
      case 'openKeybindings':
        this.openKeybindings();
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

  _checkTerminalKeybinding() {
    const COMMAND = 'audioCursor.readTerminalSelection';
    const info = vscode.workspace.getConfiguration('terminal.integrated').inspect('commandsToSkipShell');
    const userValue = (info && (info.workspaceValue || info.globalValue)) || null;
    if (Array.isArray(userValue) && !userValue.includes(COMMAND) && !userValue.includes(`-${COMMAND}`)) {
      log.warn(
        'Alt+P inside a terminal is being sent to the shell: your own ' +
        `terminal.integrated.commandsToSkipShell setting replaces the extension default. Add "${COMMAND}" to it, ` +
        'or use the "Read terminal selection" button in the Audio Cursor sidebar.'
      );
    }
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

  /**
   * Remember where the user is working, so a reveal of the player can hand
   * focus straight back.
   */
  _captureFocusTarget() {
    const editor = vscode.window.activeTextEditor;
    if (editor) {
      return { kind: 'editor', editor };
    }
    if (this._lastSource === 'terminal' && vscode.window.activeTerminal) {
      return { kind: 'terminal', terminal: vscode.window.activeTerminal };
    }
    return null;
  }

  async _restoreFocus(target) {
    if (!target) return;
    try {
      if (target.kind === 'editor') {
        await vscode.window.showTextDocument(target.editor.document, {
          viewColumn: target.editor.viewColumn,
          // Re-assert the caret so revealing the sidebar cannot move it.
          selection: target.editor.selection,
          preserveFocus: false
        });
      } else if (target.kind === 'terminal') {
        target.terminal.show(false);
      }
    } catch (err) {
      log.warn('Could not restore focus after revealing the player:', err);
    }
  }

  /**
   * Make the player visible enough to run the audio engine.
   *
   * Audio can only play inside the sidebar webview, and VS Code does not
   * resolve a view provider until the view is shown at least once — so the
   * first playback of a window unavoidably opens the Audio Cursor container.
   * After that the webview is retained (see registerWebviewViewProvider in
   * extension.js) and `show()` can reveal it without touching focus, so
   * playback never steals the caret again.
   *
   * @param {{ preserveFocus?: boolean }} [options]
   */
  async _revealPlayer({ preserveFocus = true } = {}) {
    if (this._viewProvider.show(preserveFocus)) {
      return;
    }

    // No resolved view yet: the generated focus command is the only way to make
    // VS Code create one, and it always takes keyboard focus with it.
    const focusTarget = preserveFocus ? this._captureFocusTarget() : null;
    try {
      await vscode.commands.executeCommand('audioCursor.player.focus');
    } catch (err) {
      log.warn('Could not focus audio cursor webview:', err);
      return;
    }
    await this._restoreFocus(focusTarget);
  }

  async _ensureWebviewReady() {
    if (this._viewProvider.isReady()) {
      return true;
    }

    if (this._config.get('autoRevealPanel')) {
      await this._revealPlayer({ preserveFocus: true });
      // Give up to 1.5 seconds for webview to load
      for (let i = 0; i < 15; i++) {
        if (this._viewProvider.isReady()) return true;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return this._viewProvider.isReady();
  }

  // --- Public Command Methods ---

  /**
   * Alt+P while a terminal is focused. Mirrors the editor behaviour: toggle
   * what is already playing, and only capture a new selection when idle.
   */
  async togglePlaybackTerminal() {
    this._offerCopyOnSelection();

    if (this._status === 'playing') {
      this.pause();
      return;
    }
    if (this._status === 'paused') {
      this.resume();
      return;
    }

    // Idle: read what is selected in the terminal *right now*. This is the
    // same path as the sidebar's capture button — the watcher's snapshot can
    // be a selection behind, which used to replay the previous text.
    await this.readTerminalSelection();
  }

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
    let snapshot = customSnapshot;

    // A focused preview tab is an explicit, current surface, so it outranks
    // the remembered one (`activeTextEditor` cannot be trusted here — it still
    // points at the last text editor used).
    if (!snapshot) {
      const previewTarget = getActivePreviewTarget();
      if (previewTarget) {
        const key = previewTarget.uri ? previewTarget.uri.toString() : previewTarget.label;

        // 1. Whatever is selected in the preview right now, if it can be had.
        snapshot = await this._capturePreviewSelection(previewTarget);
        if (snapshot) {
          this._lastPreviewSelection = { key, snapshot };
          log.info(`Reading the live preview selection (${snapshot.wordCount} words).`);
        }

        if (!snapshot && this._lastPreviewSelection && this._lastPreviewSelection.key === key) {
          snapshot = this._lastPreviewSelection.snapshot;
          log.info(`Reading the selection copied from the preview (${snapshot.wordCount} words).`);
        } else if (!snapshot) {
          snapshot = await resolvePreviewSnapshot(previewTarget);
          if (snapshot) {
            log.info(`Reading the document behind the preview tab: ${snapshot.fileName}.`);
          }
        }
        if (snapshot) this._lastSource = 'editor';
      }
    }

    // Otherwise the player follows whichever surface was selected on last.
    if (!snapshot && this._lastSource === 'terminal' && this._lastTerminalSnapshot) {
      snapshot = this._lastTerminalSnapshot;
    }
    if (!snapshot) {
      snapshot = await this._selectionTracker.getSnapshotAsync();
    }
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

    const markdownProse = this._config.get('readMarkdownAsProse') &&
      !snapshot.rendered &&
      (snapshot.languageId === 'markdown' || snapshot.source === 'preview');

    this._session = new Session(snapshot, { chunkSize, sanitizeCode, markdownProse });
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
    const terminal = vscode.window.activeTerminal || vscode.window.terminals[0];
    if (!terminal) {
      log.warn('Terminal capture skipped: no terminal is open.');
      return null;
    }

    const previousClipboard = await vscode.env.clipboard.readText();
    const sentinel = `__audioCursor__${Date.now()}__`;
    let copied = '';

    this._clipboardWatcher.suspend();
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
      this._clipboardWatcher.resume(previousClipboard);
    }

    if (!copied || copied === sentinel || !copied.trim()) {
      log.info('Terminal capture returned nothing — the terminal has no selection.');
      return null;
    }

    log.info(`Terminal capture succeeded (${copied.length} chars from "${terminal.name}").`);

    return createTextSnapshot(copied, {
      label: terminal.name ? `Terminal: ${terminal.name}` : 'Terminal',
      source: 'terminal'
    });
  }

  /**
   * Try to lift the selection out of the active preview.
   *
   * A webview's selection is not exposed by any API, and this VS Code build
   * registers no webview copy command, so the only lever left is the generic
   * copy action — which may or may not reach the focused webview. Anything it
   * returns is verified against the editor's own selection before use, so a
   * copy that came from the editor instead is rejected rather than read out.
   *
   * @param {{ uri: vscode.Uri | null, label: string }} previewTarget
   * @returns {Promise<Object | null>}
   */
  async _capturePreviewSelection(previewTarget) {
    const previousClipboard = await vscode.env.clipboard.readText();
    const sentinel = `__audioCursor__${Date.now()}__`;
    let copied = sentinel;

    this._clipboardWatcher.suspend();
    try {
      await vscode.env.clipboard.writeText(sentinel);
      await vscode.commands.executeCommand('editor.action.clipboardCopyAction');
      for (let i = 0; i < 8; i++) {
        copied = await vscode.env.clipboard.readText();
        if (copied !== sentinel) break;
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    } catch (err) {
      log.warn('Preview selection capture failed:', err);
      copied = sentinel;
    } finally {
      await vscode.env.clipboard.writeText(previousClipboard);
      this._clipboardWatcher.resume(previousClipboard);
    }

    if (!copied || copied === sentinel || !copied.trim()) return null;
    if (copied === previousClipboard) return null;
    if (this._clipboardWatcher.matchesEditorSelection(copied)) {
      log.info('Ignoring preview capture: the copy came from the editor, not the preview.');
      return null;
    }

    const label = previewTarget.uri
      ? (previewTarget.uri.path.split(/[\/]/).pop() || previewTarget.label)
      : previewTarget.label;
    const snapshot = createTextSnapshot(copied, { label, source: 'preview' });
    if (snapshot) snapshot.rendered = true;
    return snapshot;
  }

  async readTerminalSelection() {
    log.info('Read terminal selection requested.');
    this._offerTerminalKeybinding();
    this._offerCopyOnSelection();

    if (vscode.window.terminals.length === 0) {
      log.warn('Read terminal selection: no terminal is open.');
      vscode.window.showInformationMessage('Audio Cursor: No terminal is open.');
      return;
    }

    const snapshot = await this._captureTerminalSelection();
    if (!snapshot) {
      // Nothing selected right now: read whatever the preview is showing.
      if (this._lastTerminalSnapshot) {
        log.info('No live terminal selection; replaying the previewed terminal text.');
        this._lastSource = 'terminal';
        await this.play(this._lastTerminalSnapshot);
        return;
      }
      vscode.window.showInformationMessage(
        'Audio Cursor: Select some text in the terminal first, then read it again.'
      );
      return;
    }

    log.info(`Reading terminal selection (${snapshot.wordCount} words) from "${snapshot.fileName}".`);
    this._lastSource = 'terminal';
    this._lastTerminalSnapshot = snapshot;
    await this.play(snapshot);
  }

  /**
   * Live terminal-selection preview needs `terminal.integrated.copyOnSelection`,
   * because that is what puts a terminal selection somewhere an extension can
   * read it. Ask once, since it changes how the user's terminal behaves.
   */
  async _offerCopyOnSelection() {
    if (!this._config.get('watchTerminalSelection')) return;
    if (!this._memento || this._memento.get('copyOnSelectionPrompted')) return;

    const cfg = vscode.workspace.getConfiguration('terminal.integrated');
    if (cfg.get('copyOnSelection')) return;

    await this._memento.update('copyOnSelectionPrompted', true);
    const choice = await vscode.window.showInformationMessage(
      'Audio Cursor: show terminal selections in the player automatically? This turns on ' +
      '`terminal.integrated.copyOnSelection`, so selecting text in a terminal also copies it to your clipboard.',
      'Enable',
      'Not now'
    );

    if (choice === 'Enable') {
      await cfg.update('copyOnSelection', true, vscode.ConfigurationTarget.Global);
      log.info('Enabled terminal.integrated.copyOnSelection for live terminal previews.');
    } else {
      log.info('Live terminal preview declined; terminal text is read on demand only.');
    }
  }

  /**
   * The extension contributes `audioCursor.readTerminalSelection` to
   * `terminal.integrated.commandsToSkipShell` so Alt+P is handled by VS Code
   * instead of the shell. A user-defined value for that setting replaces our
   * contributed default, so offer to add it back — once.
   */
  async _offerTerminalKeybinding() {
    const COMMAND = 'audioCursor.readTerminalSelection';
    const cfg = vscode.workspace.getConfiguration('terminal.integrated');
    const info = cfg.inspect('commandsToSkipShell');
    const userValue = (info && (info.workspaceValue || info.globalValue)) || null;
    if (!Array.isArray(userValue)) return;
    if (userValue.includes(COMMAND) || userValue.includes(`-${COMMAND}`)) return;

    log.warn(
      'Alt+P will not reach Audio Cursor from a focused terminal: your ' +
      'terminal.integrated.commandsToSkipShell setting overrides the extension default. ' +
      `Add "${COMMAND}" to that list to fix it.`
    );

    if (!this._memento || this._memento.get('skipShellPrompted')) return;
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

  /**
   * VS Code owns the keymap, so remapping means opening its keybindings
   * editor filtered to this extension's commands.
   */
  openKeybindings() {
    vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', 'audioCursor');
  }

  /** Explicit user command, so this one is allowed to take focus. */
  openPanel() {
    vscode.commands.executeCommand('audioCursor.player.focus');
  }

  showLogs() {
    log.show();
  }

  dispose() {
    this._clipboardWatcher.dispose();
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
