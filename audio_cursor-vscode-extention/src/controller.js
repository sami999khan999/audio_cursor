const vscode = require('vscode');
const path = require('path');
const log = require('./log');
const { Session } = require('./session');
const { ProgressTracker } = require('./progress');
const { getSnapshot, createTextSnapshot, getActivePreviewTarget, resolvePreviewSnapshot } = require('./selection');
const { ClipboardSelectionWatcher } = require('./clipboardWatcher');
const { neuralEngine } = require('./neuralEngine');
const { HostAudioPlayer } = require('./hostPlayer');
const { HostSpeechEngine } = require('./hostEngine');
const {
  userKeybindingsPath, parseUserKeybindings, panelKeybindingRows, contributedKeybindings
} = require('./keybindings');

// How long a session may sit in `starting` before the host gives up on it.
// Longer than the player's own 6s watchdog, so the player gets to explain
// itself first.
const START_TIMEOUT_MS = 12000;
// The host engine's first sound waits on a network synthesis with retries, so
// it gets longer before being declared stuck.
const HOST_START_TIMEOUT_MS = 30000;
// The offline Web Speech engine is opt-in and has to be named, because an unset
// voice means "not configured" and resolves to the neural default. Kept in step
// with SYSTEM_VOICE in view/player.js.
const SYSTEM_VOICE = 'system';

// Keys pressed while a terminal is focused go to the shell unless the command
// they resolve to is listed in `terminal.integrated.commandsToSkipShell`. The
// extension contributes these through `configurationDefaults`, but a user value
// for that setting replaces the contribution, so they are checked at runtime
// too. Keep in step with the contributed list in package.json.
const TERMINAL_SKIP_SHELL_COMMANDS = [
  'audioCursor.togglePlaybackTerminal',
  'audioCursor.readTerminalSelection',
  'audioCursor.stop'
];

const SKIP_SHELL_PROMPTED_KEY = 'skipShellPrompted';

// What each command is called in the prompt, so it names the keys the user is
// actually pressing rather than command ids.
const SKIP_SHELL_COMMAND_LABELS = {
  'audioCursor.togglePlaybackTerminal': 'Alt+P (play/pause)',
  'audioCursor.readTerminalSelection': 'Alt+P (read the selection)',
  'audioCursor.stop': 'Alt+Shift+P (stop)'
};

function labelForCommand(command) {
  return SKIP_SHELL_COMMAND_LABELS[command] || command;
}

/**
 * The contributed commands a user-defined `commandsToSkipShell` list is
 * missing. An explicit `-command` entry counts as a deliberate opt-out.
 * @param {unknown} userValue
 * @returns {string[]}
 */
function missingSkipShellCommands(userValue) {
  if (!Array.isArray(userValue)) return [];
  return TERMINAL_SKIP_SHELL_COMMANDS.filter(
    command => !userValue.includes(command) && !userValue.includes(`-${command}`)
  );
}

class AudioCursorController {
  /**
   * @param {Object} params
   * @param {import('./config').config} params.config
   * @param {import('./selection').SelectionTracker} params.selectionTracker
   * @param {import('./statusBar').StatusBarController} params.statusBar
   * @param {import('./decorations').DecorationController} params.decorations
   * @param {import('./view/provider').AudioCursorViewProvider} params.viewProvider
   * @param {vscode.Memento} [params.memento]
   * @param {{ fsPath: string } | null} [params.globalStorageUri] Locates the
   *   user's keybindings.json, which is the only way to know what key actually
   *   runs a command — VS Code exposes no API for it.
   * @param {import('./hostPlayer').HostAudioPlayer | null} [params.hostPlayer]
   *   Override for tests; by default one is created where the platform supports it.
   */
  constructor({ config, selectionTracker, statusBar, decorations, viewProvider, memento, globalStorageUri, hostPlayer }) {
    this._config = config;
    this._memento = memento || null;
    this._globalStorageUri = globalStorageUri || null;
    /** @type {vscode.FileSystemWatcher | null} */
    this._keybindingWatcher = null;
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
    /** Guards against a session that never reports back from the webview. */
    this._startWatchdog = null;
    /** @type {{ key: string, snapshot: Object } | null} */
    this._lastPreviewSelection = null;
    this._clipboardWatcher = new ClipboardSelectionWatcher(config);
    this._status = 'idle'; // 'idle' | 'starting' | 'playing' | 'paused' | 'stopped'
    this._progressTracker = new ProgressTracker();
    this._neuralVoices = neuralEngine.getVoicesSync();
    this._localVoices = [];
    this._availableVoices = [...this._neuralVoices];
    this._disposables = [];

    // Where the sound comes out. The host engine plays through a process the
    // extension owns, so it needs no click in the panel — the panel stays the
    // UI. Where the platform has no host player, the panel's own engine is used
    // and the one click VS Code demands stays.
    /** @type {'panel' | 'host'} */
    this._engine = 'panel';
    this._hostPlayer = hostPlayer !== undefined
      ? hostPlayer
      : (HostAudioPlayer.isSupported() ? new HostAudioPlayer() : null);
    this._hostEngine = this._hostPlayer ? new HostSpeechEngine(this._hostPlayer, neuralEngine) : null;
    if (this._hostEngine) {
      this._hostEngine.sweepStale();
      this._wireHostEngine();
      // Bring the player process up now rather than on the first Alt+P: it
      // takes about a second to start, and that second used to sit between
      // the keypress and the first sound.
      if (this._config.get('hostAudio')) {
        this._hostPlayer.ensureStarted().catch(() => {});
      }
    }

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

        if (isActive && snapshot.source === 'terminal') {
          // A terminal running a full-screen program redraws constantly, and
          // with `copyOnSelection` on every redraw re-copies the (slightly
          // changed) selection. Treating each of those as a new selection
          // stopped the first read within a second of it starting. So a
          // terminal change only updates what the *next* Alt+P will read.
          log.info('Terminal selection changed during playback; remembered for the next read, playback continues.');
          this._lastTerminalSnapshot = snapshot;
          return;
        }

        if (isActive) {
          log.info('Preview selection changed during playback; stopping playback.');
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
          voices: this._availableVoices,
          capabilities: { hostAudio: this._hostAudioEnabled() }
        });
        this._publishTerminalState();
        this._publishKeybindings();
        this._watchKeybindings();
        if (this._session) {
          if (this._engine === 'host') {
            // Opened during a host read: show the text being read and mirror.
            this._publishSnapshot(this._session.snapshot);
            this._viewProvider.postMessage({ type: 'hostSession', sessionId: this._session.id });
          }
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
        if (this._engine === 'panel' && this._session && !this._session.isStale(msg.sessionId)) {
          this._clearStartWatchdog();
          this._setStatus('playing');
        }
        break;

      case 'progress':
        if (this._engine === 'panel' && this._session && !this._session.isStale(msg.sessionId)) {
          this._onProgress(msg.charIndex, msg.chunkIndex, msg.charLength);
        }
        break;

      case 'chunkEnded':
        if (this._session && !this._session.isStale(msg.sessionId)) {
          // Top the queue up only when it is actually running low. Pulling a
          // whole fresh window on *every* chunk end raced the player far ahead
          // of playback and made `queueAhead` meaningless after the first
          // window; each of those messages was also a chance to double-start a
          // chunk in the player.
          const queueAhead = this._config.get('queueAhead') || 12;
          const played = typeof msg.chunkIndex === 'number' ? msg.chunkIndex + 1 : 0;
          const outstanding = this._session.queueHead - played;
          if (outstanding <= Math.ceil(queueAhead / 2)) {
            const nextChunks = this._session.nextWindow(queueAhead);
            if (nextChunks.length > 0) {
              this._viewProvider.postMessage({
                type: 'enqueue',
                sessionId: this._session.id,
                chunks: nextChunks
              });
            }
          }
        }
        break;

      case 'ended':
        if (this._engine === 'panel' && this._session && !this._session.isStale(msg.sessionId)) {
          log.info('Playback completed successfully');
          this._finishSession();
        }
        break;

      case 'clientLog':
        if (!this._session || !this._session.isStale(msg.sessionId)) {
          log.info('Player: ' + (msg.message || ''));
        }
        break;

      case 'clientError':
        log.error('Webview player: ' + (msg.message || 'unknown') +
          (msg.stack ? '\n' + msg.stack : ''));
        break;

      case 'requireGesture':
        if (this._session && !this._session.isStale(msg.sessionId)) {
          log.info('Audio playback ready. Waiting for user activation on sidebar player.');
          // Show the player: its own banner is the thing to click, and it is
          // right there. A modal notification on top of it was pure noise —
          // it interrupted, it had to be dismissed, and it said nothing the
          // panel was not already saying.
          this._revealPlayer({ preserveFocus: true });
          // Only nudge once per session; the webview may re-request per chunk.
          if (this._gesturePromptedSession === msg.sessionId) return;
          this._gesturePromptedSession = msg.sessionId;
          vscode.window.setStatusBarMessage(
            '$(unmute) Audio Cursor: click the player panel once to allow audio',
            6000
          );
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
        // The player is showing terminal output. Play exactly what the preview
        // is showing — do NOT re-capture. Re-capturing from here ran VS Code's
        // terminal copy command with focus already in the sidebar, so VS Code
        // announced "The terminal has no selection to copy" and the extension
        // then replayed the remembered text anyway: a wrong message over
        // correct audio.
        if (payload.source === 'terminal' && this._lastTerminalSnapshot) {
          this._lastSource = 'terminal';
          this.play(this._lastTerminalSnapshot);
        } else if (payload.source === 'terminal' && vscode.window.activeTerminal) {
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
        // Clicked in the sidebar, so the terminal no longer has focus.
        this.readTerminalSelection({ live: false });
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
    const info = vscode.workspace.getConfiguration('terminal.integrated').inspect('commandsToSkipShell');
    const userValue = (info && (info.workspaceValue || info.globalValue)) || null;
    const missing = missingSkipShellCommands(userValue);
    if (missing.length) {
      log.warn(
        'Audio Cursor shortcuts inside a terminal are being sent to the shell: your own ' +
        'terminal.integrated.commandsToSkipShell setting replaces the extension default. Add ' +
        `${missing.map(c => `"${c}"`).join(', ')} to it, or use the buttons in the Audio Cursor sidebar.`
      );
    }
  }

  /**
   * Tell the panel what its shortcut list should say. The list was static
   * markup, so remapping a command in the Keyboard Shortcuts editor left the
   * sidebar advertising the old chord indefinitely.
   */
  async _publishKeybindings() {
    const contributed = contributedKeybindings();
    let userEntries = [];

    if (this._globalStorageUri) {
      try {
        const uri = vscode.Uri.file(userKeybindingsPath(this._globalStorageUri));
        const bytes = await vscode.workspace.fs.readFile(uri);
        userEntries = parseUserKeybindings(Buffer.from(bytes).toString('utf8'));
      } catch (err) {
        // No keybindings.json at all is the default state of a fresh install,
        // and means exactly "no overrides".
        log.info('No user keybindings.json to read; showing the contributed defaults.');
      }
    }

    this._viewProvider.postMessage({
      type: 'keybindings',
      rows: panelKeybindingRows(contributed, userEntries)
    });
  }

  /**
   * Re-read keybindings.json when it changes, so a remap shows up in the panel
   * without reopening the window.
   */
  _watchKeybindings() {
    // onReady fires again every time the view is rebuilt, and a watcher per
    // rebuild would multiply the reads.
    if (this._keybindingWatcher || !this._globalStorageUri) return;
    try {
      const file = userKeybindingsPath(this._globalStorageUri);
      const pattern = new vscode.RelativePattern(vscode.Uri.file(path.dirname(file)), path.basename(file));
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);
      const refresh = () => this._publishKeybindings();
      watcher.onDidChange(refresh);
      watcher.onDidCreate(refresh);
      watcher.onDidDelete(refresh);
      this._keybindingWatcher = watcher;
      this._disposables.push(watcher);
    } catch (err) {
      log.warn('Could not watch keybindings.json; the shortcut list updates when the panel reopens.', err);
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

  _hostAudioEnabled() {
    return Boolean(this._hostEngine) && this._config.get('hostAudio');
  }

  /**
   * Whether this read should be spoken by the host engine. The offline system
   * voice only exists inside the panel, so it always goes there.
   * @returns {Promise<boolean>}
   */
  async _shouldUseHostEngine() {
    if (!this._hostAudioEnabled()) return false;
    if (this._config.get('voice') === SYSTEM_VOICE) return false;
    const ok = await this._hostPlayer.ensureStarted();
    if (!ok) log.warn('Host audio player unavailable; falling back to the panel engine for this read.');
    return ok;
  }

  _wireHostEngine() {
    const engine = this._hostEngine;
    const live = () => this._engine === 'host' && this._session;

    engine.on('started', () => {
      if (!live()) return;
      this._clearStartWatchdog();
      this._setStatus('playing');
      this._viewProvider.postMessage({ type: 'state', status: 'playing', percent: this._session.percent() });
    });

    engine.on('progress', ({ charIndex, chunkIndex }) => {
      if (!live()) return;
      this._onProgress(charIndex, chunkIndex);
      if (!this._session) return; // stopOnDocumentChange may have ended it
      // ~25 ticks a second: never queue these for a panel that is not open.
      if (this._viewProvider.isReady()) {
        this._viewProvider.postMessage({ type: 'hostProgress', charIndex, percent: this._session.percent() });
      }
    });

    engine.on('ended', () => {
      if (!live()) return;
      log.info('Playback completed successfully (host engine).');
      this._finishSession();
      this._viewProvider.postMessage({ type: 'state', status: 'stopped', percent: 0 });
    });

    engine.on('failure', ({ message }) => {
      if (!live()) return;
      log.error('Host engine error:', message);
      this._finishSession();
      this._viewProvider.postMessage({ type: 'state', status: 'stopped', percent: 0 });
      vscode.window.showErrorMessage(
        `Audio Cursor TTS error: ${message || 'Unknown error'}`,
        'Show Logs'
      ).then(choice => {
        if (choice === 'Show Logs') this.showLogs();
      });
    });
  }

  /**
   * A spoken-position update from whichever engine is speaking: move the
   * editor highlight, keep the status bar and session cursor in step.
   * @param {number} charIndex
   * @param {number} chunkIndex
   * @param {number} [charLength]
   */
  _onProgress(charIndex, chunkIndex, charLength) {
    const session = this._session;
    if (!session) return;
    // A tick that was already on its way when Pause was pressed must not
    // paint the status bar back to "playing" — that is what left the pause
    // icon showing over a paused read.
    if (this._status !== 'playing') return;
    session.cursorChar = charIndex;
    session.cursorChunk = chunkIndex;
    this._progressTracker.onEvent(charIndex);

    const editor = vscode.window.activeTextEditor;
    const { docChanged } = this._decorations.highlight(editor, session.snapshot, charIndex, charLength);

    if (docChanged && this._config.get('stopOnDocumentChange')) {
      log.warn('Document changed during playback; stopping playback as per configuration');
      this.stop();
      vscode.window.showInformationMessage('Audio Cursor: Playback stopped because document was edited.');
      return;
    }

    this._statusBar.update({ status: this._status, percent: session.percent() });
  }

  _clearStartWatchdog() {
    if (this._startWatchdog) {
      clearTimeout(this._startWatchdog);
      this._startWatchdog = null;
    }
  }

  /**
   * A session that never reports back used to leave the status bar spinning on
   * `starting` forever, with `audioCursor.playing` false so the Stop command
   * stayed hidden. Give up after a while and say so.
   * @param {string} sessionId
   */
  _armStartWatchdog(sessionId, timeoutMs = START_TIMEOUT_MS) {
    this._clearStartWatchdog();
    this._startWatchdog = setTimeout(() => {
      this._startWatchdog = null;
      if (!this._session || this._session.isStale(sessionId)) return;
      if (this._status !== 'starting') return;
      log.warn(
        `Session ${sessionId} never confirmed playback within ${timeoutMs}ms; ` +
        'see the entries above for where it stopped.'
      );
      if (this._hostEngine && this._hostEngine.isActive) this._hostEngine.stop();
      this._setStatus('stopped');
      this._viewProvider.postMessage({ type: 'state', status: 'stopped', percent: 0 });
    }, timeoutMs);
  }

  _finishSession() {
    this._clearStartWatchdog();
    if (this._hostEngine && this._hostEngine.isActive) this._hostEngine.stop();
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
    // Whatever brought us here, it was not the terminal keybinding, so prefer
    // the selection the watcher already holds over running the copy command.
    if (!snapshot && !customSnapshot && vscode.window.activeTerminal) {
      snapshot = await this._captureTerminalSelection({ live: false });
    }

    if (!snapshot || !snapshot.text || !snapshot.text.trim()) {
      vscode.window.showInformationMessage('Audio Cursor: No text selected to read.');
      return;
    }

    const useHost = await this._shouldUseHostEngine();

    // Only the panel engine needs the panel — it is where its sound comes
    // from. Host audio must not open it: the editor highlight works without
    // it, and having Alt+P yank the sidebar open was itself a complaint.
    const isReady = useHost ? true : await this._ensureWebviewReady();
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
      if (this._hostEngine && this._hostEngine.isActive) this._hostEngine.stop();
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

    log.info(`Starting speech session ${this._session.id} (${snapshot.wordCount} words, ` +
      `${this._session.chunks.length} chunks, ${useHost ? 'host' : 'panel'} engine)`);

    this._engine = useHost ? 'host' : 'panel';
    this._armStartWatchdog(this._session.id, useHost ? HOST_START_TIMEOUT_MS : START_TIMEOUT_MS);

    if (useHost) {
      // The panel only mirrors state from here on; it must not start its own
      // engine for this session.
      this._viewProvider.postMessage({ type: 'hostSession', sessionId: this._session.id });
      this._hostEngine.start(this._session, () => ({
        voice: this._config.get('voice') || 'en-US-JennyNeural',
        rate: this._config.get('rate'),
        pitch: this._config.get('pitch')
      }));
      return;
    }

    const firstBatch = this._session.nextWindow(queueAhead);
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
    if (this._engine === 'host') {
      this._hostEngine.pause();
      this._viewProvider.postMessage({ type: 'state', status: 'paused', percent: this._session.percent() });
      return;
    }
    this._viewProvider.postMessage({
      type: 'pause',
      sessionId: this._session.id
    });
  }

  resume() {
    if (this._status !== 'paused' || !this._session) return;
    this._setStatus('playing');
    this._progressTracker.resume();
    if (this._engine === 'host') {
      this._hostEngine.resume();
      this._viewProvider.postMessage({ type: 'state', status: 'playing', percent: this._session.percent() });
      return;
    }
    this._viewProvider.postMessage({
      type: 'resume',
      sessionId: this._session.id
    });
  }

  stop() {
    if (this._session) {
      if (this._hostEngine && this._hostEngine.isActive) this._hostEngine.stop();
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

    if (this._engine === 'host') {
      // The host engine does its own re-positioning; the session id stays.
      this._setStatus('starting');
      this._armStartWatchdog(this._session.id, HOST_START_TIMEOUT_MS);
      this._viewProvider.postMessage({ type: 'state', status: 'starting', percent: this._session.percent() });
      this._hostEngine.seek(charIndex);
      return;
    }

    const { chunkIndex, newSessionId } = this._session.seekTo(charIndex);
    const queueAhead = this._config.get('queueAhead');
    const chunks = this._session.nextWindow(queueAhead);

    // Seeking re-synthesizes from the new position, so nothing is audible yet.
    // Claiming 'playing' here is the same lie the 0.7.3 work removed elsewhere.
    this._setStatus('starting');
    this._armStartWatchdog(newSessionId);
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
   * What `terminal.integrated.copyOnSelection` left on the clipboard, as a
   * terminal snapshot — or null if it is empty or is really the editor's own
   * selection (a copy made in the editor is the one false positive that
   * matters, and it is excluded by value, the same way the watcher does it).
   * @param {vscode.Terminal} terminal
   * @returns {Promise<Object | null>}
   */
  async _terminalSelectionFromClipboard(terminal) {
    let text;
    try {
      text = await vscode.env.clipboard.readText();
    } catch (_) {
      return null;
    }
    if (!text || !text.trim()) return null;
    if (this._clipboardWatcher.matchesEditorSelection(text)) return null;
    const snapshot = createTextSnapshot(text, {
      label: terminal.name ? `Terminal: ${terminal.name}` : 'Terminal',
      source: 'terminal'
    });
    if (snapshot) snapshot.terminalName = terminal.name || '';
    return snapshot;
  }

  /**
   * Read the active terminal's selection. VS Code has no stable API for
   * terminal selections, so the text is lifted via the terminal's own copy
   * command with the user's clipboard saved and restored around it.
   *
   * That command only works while the terminal has keyboard focus, and when it
   * finds nothing VS Code itself announces "The terminal has no selection to
   * copy" — a notice this extension cannot suppress. So it is only ever run
   * from a path where the terminal really does have focus, which means the
   * Alt+P keybinding and the terminal context menu.
   *
   * Pass `live: false` from anything the user reached by clicking in the
   * sidebar. Focus is in the panel by then, so the command would always fail
   * and always complain; only the selection the clipboard watcher already
   * holds is used, and if there is none the caller is told so.
   *
   * @param {{ live?: boolean }} [options]
   * @returns {Promise<Object | null>}
   */
  async _captureTerminalSelection({ live = true } = {}) {
    const terminal = vscode.window.activeTerminal || vscode.window.terminals[0];
    if (!terminal) {
      log.warn('Terminal capture skipped: no terminal is open.');
      return null;
    }

    // With `copyOnSelection` on, VS Code has already put the selection on the
    // clipboard at the moment it was made — so read it from there, and never
    // run the copy command at all. The command needs the terminal to still
    // hold both focus and its selection, and a terminal running a full-screen
    // program (a TUI redraws constantly) drops the selection almost at once;
    // that is how a plainly highlighted selection still produced "The terminal
    // has no selection to copy".
    if (vscode.workspace.getConfiguration('terminal.integrated').get('copyOnSelection')) {
      const fromClipboard = await this._terminalSelectionFromClipboard(terminal);
      if (fromClipboard) {
        log.info(`Terminal selection taken from the clipboard (${fromClipboard.wordCount} words).`);
        return fromClipboard;
      }
      if (this._lastTerminalSnapshot) return this._lastTerminalSnapshot;
      return null;
    }

    // Reached by a click, so focus is in the panel and the copy command could
    // only fail — noisily. Use what the watcher has, or nothing.
    if (!live) {
      if (this._lastTerminalSnapshot) {
        log.info('Using the terminal selection the watcher already captured; not running the copy command.');
        return this._lastTerminalSnapshot;
      }
      log.info('No terminal selection has been captured, and the copy command needs terminal focus.');
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

    const snapshot = createTextSnapshot(copied, {
      label: terminal.name ? `Terminal: ${terminal.name}` : 'Terminal',
      source: 'terminal'
    });
    // Remember which terminal it came from, so a fallback replay cannot read
    // one terminal's output while a different one is in front of the user.
    if (snapshot) snapshot.terminalName = terminal.name || '';
    return snapshot;
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

  /**
   * @param {{ live?: boolean }} [options] `live: false` when the user got here
   *   by clicking in the sidebar, so keyboard focus is no longer in the terminal.
   */
  async readTerminalSelection({ live = true } = {}) {
    log.info(`Read terminal selection requested (${live ? 'live capture' : 'from the player preview'}).`);
    this._offerTerminalKeybinding();
    this._offerCopyOnSelection();

    if (vscode.window.terminals.length === 0) {
      log.warn('Read terminal selection: no terminal is open.');
      vscode.window.showInformationMessage('Audio Cursor: No terminal is open.');
      return;
    }

    const snapshot = await this._captureTerminalSelection({ live });
    if (!snapshot) {
      // Nothing selected right now: fall back to what the player is showing,
      // but only if it came from the terminal that is actually in front of the
      // user — otherwise a second terminal would replay the first one's output.
      const active = vscode.window.activeTerminal;
      const remembered = this._lastTerminalSnapshot;
      const sameTerminal = remembered && (
        !remembered.terminalName || !active || remembered.terminalName === active.name
      );

      if (remembered && sameTerminal) {
        log.info('No live terminal selection; replaying the previewed terminal text.');
        this._lastSource = 'terminal';
        await this.play(remembered);
        // After `play`, not before: starting a read posts `selection` and
        // `speak`, and both clear the notice slot.
        this._viewProvider.postMessage({
          type: 'notice',
          message: 'No live terminal selection — replaying the last one.'
        });
        return;
      }
      await this._explainNoTerminalSelection(live);
      return;
    }

    log.info(`Reading terminal selection (${snapshot.wordCount} words) from "${snapshot.fileName}".`);
    this._lastSource = 'terminal';
    this._lastTerminalSnapshot = snapshot;
    await this.play(snapshot);
  }

  /**
   * Nothing to read from the terminal. Which advice is useful depends on why:
   * a live capture that came back empty means there really is no selection,
   * whereas a click in the sidebar never got to look — the copy command needs
   * terminal focus, so Alt+P is the thing that works from there.
   * @param {boolean} live
   */
  async _explainNoTerminalSelection(live) {
    if (live) {
      vscode.window.showInformationMessage(
        'Audio Cursor: Select some text in the terminal first, then read it again.'
      );
      return;
    }

    const cfg = vscode.workspace.getConfiguration('terminal.integrated');
    if (cfg.get('copyOnSelection')) {
      vscode.window.showInformationMessage(
        'Audio Cursor: Select some text in the terminal and it will appear here ready to read.'
      );
      return;
    }

    const choice = await vscode.window.showInformationMessage(
      'Audio Cursor: reading the terminal from this panel needs `terminal.integrated.copyOnSelection`, ' +
      'because VS Code exposes no terminal-selection API. With it on, selecting text in a terminal ' +
      'puts it straight into the player. Otherwise press Alt+P with the terminal focused.',
      'Enable',
      'Not now'
    );
    if (choice === 'Enable') {
      await cfg.update('copyOnSelection', true, vscode.ConfigurationTarget.Global);
      log.info('Enabled terminal.integrated.copyOnSelection from the player panel.');
    }
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
   * The extension contributes its terminal-reachable commands to
   * `terminal.integrated.commandsToSkipShell` so Alt+P and Alt+Shift+P are
   * handled by VS Code instead of the shell. A user-defined value for that
   * setting replaces our contributed default, so offer to add them back — once.
   */
  async _offerTerminalKeybinding() {
    const cfg = vscode.workspace.getConfiguration('terminal.integrated');
    const info = cfg.inspect('commandsToSkipShell');
    const userValue = (info && (info.workspaceValue || info.globalValue)) || null;
    const missing = missingSkipShellCommands(userValue);
    if (!missing.length) return;

    log.warn(
      'Audio Cursor shortcuts will not reach the extension from a focused terminal: your ' +
      'terminal.integrated.commandsToSkipShell setting overrides the extension default. ' +
      `Add ${missing.map(c => `"${c}"`).join(', ')} to that list to fix it.`
    );

    if (!this._memento) return;

    // Remember *which* commands were offered, not merely that a prompt once
    // happened. This used to be a single boolean, so when a command was added
    // to the list a user who had already answered the earlier prompt was never
    // asked again — their shortcut just silently did nothing forever. Older
    // installs stored `true` here; that counts as nothing offered yet, so they
    // get one fresh prompt covering whatever is now missing.
    const stored = this._memento.get(SKIP_SHELL_PROMPTED_KEY);
    const offered = Array.isArray(stored) ? stored : [];
    const unoffered = missing.filter(command => !offered.includes(command));
    if (!unoffered.length) return;

    await this._memento.update(SKIP_SHELL_PROMPTED_KEY, [...offered, ...unoffered]);
    const choice = await vscode.window.showInformationMessage(
      'Audio Cursor: enable its shortcuts inside the terminal? Your own ' +
      '`terminal.integrated.commandsToSkipShell` setting currently sends ' +
      `${unoffered.map(labelForCommand).join(' and ')} to the shell instead.`,
      'Enable',
      'Not now'
    );

    if (choice === 'Enable') {
      await cfg.update('commandsToSkipShell', [...userValue, ...missing], vscode.ConfigurationTarget.Global);
      log.info(`Added ${missing.join(', ')} to terminal.integrated.commandsToSkipShell.`);
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
        description: 'Offline · the operating system voice, no network needed',
        value: SYSTEM_VOICE,
        picked: currentVoice === SYSTEM_VOICE
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
    this._clearStartWatchdog();
    this._clipboardWatcher.dispose();
    this.stop();
    if (this._hostEngine) this._hostEngine.dispose();
    if (this._hostPlayer) this._hostPlayer.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
  }
}

module.exports = {
  AudioCursorController,
  missingSkipShellCommands
};
