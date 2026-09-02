const vscode = require('vscode');

// Documents we can never usefully read aloud. Everything else — files,
// untitled buffers, output channels, diffs, notebook cells, remote docs — is
// fair game, so Audio Cursor works with any text surface in VS Code.
const IGNORED_SCHEMES = new Set(['vscode-webview', 'vscode-terminal']);

/**
 * @typedef {Object} Snapshot
 * @property {string} text
 * @property {vscode.Uri} uri
 * @property {number} version
 * @property {number} startOffset
 * @property {number} endOffset
 * @property {string} languageId
 * @property {string} fileName
 * @property {number} wordCount
 * @property {number} charCount
 * @property {boolean} fromCursor
 */

/**
 * Count words in string
 * @param {string} text
 * @returns {number}
 */
function countWords(text) {
  if (!text) return 0;
  const matches = text.match(/\b\w+\b/g);
  return matches ? matches.length : 0;
}

/**
 * Format duration estimation given word count and speech rate.
 * @param {number} words
 * @param {number} [rate=1.0]
 * @returns {string} e.g. "1m 42s" or "35s"
 */
function formatEstimatedDuration(words, rate = 1.0) {
  if (words <= 0) return '0s';
  const effectiveWpm = 200 * (rate || 1.0);
  const totalSeconds = Math.max(1, Math.round((words / effectiveWpm) * 60));
  const mins = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

/**
 * Capture a text snapshot from an active text editor.
 *
 * @param {vscode.TextEditor | undefined} editor
 * @param {Object} [options]
 * @param {boolean} [options.readFromCursorWhenNoSelection=true]
 * @returns {Snapshot | null}
 */
function getSnapshot(editor, options = {}) {
  if (!editor || !editor.document) {
    return null;
  }

  const doc = editor.document;
  if (IGNORED_SCHEMES.has(doc.uri.scheme)) {
    return null;
  }

  const readFromCursorWhenNoSelection = options.readFromCursorWhenNoSelection !== false;
  const selections = editor.selections || [editor.selection];

  // Check if we have multiple selections or a non-empty selection
  const nonEmptySelections = selections.filter(s => !s.isEmpty);

  if (nonEmptySelections.length > 0) {
    // Sort selections by document position
    const sorted = [...nonEmptySelections].sort((a, b) => {
      if (a.start.line !== b.start.line) return a.start.line - b.start.line;
      return a.start.character - b.start.character;
    });

    if (sorted.length === 1) {
      const sel = sorted[0];
      const startOffset = doc.offsetAt(sel.start);
      const endOffset = doc.offsetAt(sel.end);
      const text = doc.getText(sel);
      if (!text.trim()) return null;

      return {
        text,
        uri: doc.uri,
        version: doc.version,
        startOffset,
        endOffset,
        languageId: doc.languageId,
        fileName: doc.fileName ? doc.fileName.split(/[\\/]/).pop() : 'untitled',
        wordCount: countWords(text),
        charCount: text.length,
        fromCursor: false,
        source: 'editor'
      };
    } else {
      // Multi-cursor selection: join text with newlines
      const texts = [];
      let minOffset = doc.getText().length;
      let maxOffset = 0;
      for (const sel of sorted) {
        const t = doc.getText(sel);
        if (t.trim()) {
          texts.push(t);
          const start = doc.offsetAt(sel.start);
          const end = doc.offsetAt(sel.end);
          if (start < minOffset) minOffset = start;
          if (end > maxOffset) maxOffset = end;
        }
      }

      if (texts.length === 0) return null;
      const combinedText = texts.join('\n');

      return {
        text: combinedText,
        uri: doc.uri,
        version: doc.version,
        startOffset: minOffset,
        endOffset: maxOffset,
        languageId: doc.languageId,
        fileName: doc.fileName ? doc.fileName.split(/[\\/]/).pop() : 'untitled',
        wordCount: countWords(combinedText),
        charCount: combinedText.length,
        fromCursor: false,
        source: 'editor'
      };
    }
  }

  // No selection: read from cursor to end of document if enabled
  if (readFromCursorWhenNoSelection) {
    const cursor = editor.selection.active;
    const startOffset = doc.offsetAt(cursor);
    const fullText = doc.getText();
    const text = fullText.substring(startOffset);
    if (!text.trim()) return null;

    return {
      text,
      uri: doc.uri,
      version: doc.version,
      startOffset,
      endOffset: fullText.length,
      languageId: doc.languageId,
      fileName: doc.fileName ? doc.fileName.split(/[\\/]/).pop() : 'untitled',
      wordCount: countWords(text),
      charCount: text.length,
      fromCursor: true,
      source: 'editor'
    };
  }

  return null;
}

/**
 * Build a snapshot from text that did not come from a text document
 * (terminal selection, clipboard, etc). It has no `uri`, so editor
 * decorations are skipped for it.
 *
 * @param {string} text
 * @param {Object} [options]
 * @param {string} [options.label='Terminal']
 * @param {string} [options.source='terminal']
 * @returns {Snapshot | null}
 */
function createTextSnapshot(text, options = {}) {
  if (!text || !text.trim()) return null;
  return {
    text,
    uri: null,
    version: 0,
    startOffset: 0,
    endOffset: text.length,
    languageId: 'plaintext',
    fileName: options.label || 'Terminal',
    wordCount: countWords(text),
    charCount: text.length,
    fromCursor: false,
    source: options.source || 'terminal'
  };
}

class SelectionTracker {
  /**
   * @param {import('./config').config} config
   */
  constructor(config) {
    this._config = config;
    /** @type {Snapshot | null} */
    this._lastSnapshot = null;
    this._listeners = new Set();
    this._debounceTimer = null;
    this._disposables = [];

    this._disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this._triggerUpdate('editor')),
      vscode.window.onDidChangeTextEditorSelection(() => this._triggerUpdate('selection'))
    );

    this._triggerUpdate('init', true);
  }

  /**
   * Get the current snapshot or fallback to last cached snapshot
   * @param {boolean} [requireFresh=false]
   * @returns {Snapshot | null}
   */
  getSnapshot(requireFresh = false) {
    const editor = vscode.window.activeTextEditor;
    const fresh = getSnapshot(editor, {
      readFromCursorWhenNoSelection: this._config.get('readFromCursorWhenNoSelection')
    });

    if (fresh) {
      this._lastSnapshot = fresh;
      return fresh;
    }

    return requireFresh ? null : this._lastSnapshot;
  }

  /**
   * Register selection changed listener. `cause` is 'selection' when the user
   * moved or changed the selection, 'editor' when the active editor changed,
   * and 'init' for the first snapshot.
   * @param {(snapshot: Snapshot | null, cause: string) => void} listener
   * @returns {vscode.Disposable}
   */
  onSelectionChanged(listener) {
    this._listeners.add(listener);
    return {
      dispose: () => this._listeners.delete(listener)
    };
  }

  _triggerUpdate(cause = 'selection', immediate = false) {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
      this._debounceTimer = null;
    }

    const run = () => {
      const editor = vscode.window.activeTextEditor;
      const hasSelection = Boolean(editor && !editor.selection.isEmpty);
      vscode.commands.executeCommand('setContext', 'audioCursor.hasSelection', hasSelection);

      const snapshot = this.getSnapshot(false);
      for (const listener of this._listeners) {
        try {
          listener(snapshot, cause);
        } catch (err) {
          console.error('Error in selection listener:', err);
        }
      }
    };

    if (immediate) {
      run();
    } else {
      this._debounceTimer = setTimeout(run, 120);
    }
  }

  dispose() {
    if (this._debounceTimer) {
      clearTimeout(this._debounceTimer);
    }
    this._listeners.clear();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
  }
}

module.exports = {
  getSnapshot,
  createTextSnapshot,
  countWords,
  formatEstimatedDuration,
  SelectionTracker
};
