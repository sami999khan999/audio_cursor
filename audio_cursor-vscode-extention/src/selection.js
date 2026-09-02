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

// A markdown/docs preview is a webview or custom editor, so its contents and
// selection are unreachable. What is reachable is the document behind it.
const PREVIEW_VIEW_TYPE = /markdown|preview/i;
const READABLE_PREVIEW_EXT = /\.(md|markdown|mdx|txt|rst|adoc|html?)$/i;

function basenameOf(uriOrPath) {
  const path = typeof uriOrPath === 'string' ? uriOrPath : (uriOrPath && uriOrPath.path) || '';
  return path.split(/[\\/]/).pop() || '';
}

/**
 * The document preview shown by the active tab, if the active tab is one.
 * Returns null for ordinary editors, terminals, notebooks and image previews.
 * @returns {{ uri: vscode.Uri | null, label: string } | null}
 */
function getActivePreviewTarget() {
  const groups = vscode.window.tabGroups;
  const tab = groups && groups.activeTabGroup && groups.activeTabGroup.activeTab;
  if (!tab) return null;

  const input = tab.input;

  // Custom editors (e.g. Markdown Preview Enhanced) expose the source uri.
  if (vscode.TabInputCustom && input instanceof vscode.TabInputCustom) {
    if (!READABLE_PREVIEW_EXT.test(input.uri.path)) return null;
    if (!PREVIEW_VIEW_TYPE.test(input.viewType) && !/\.(md|markdown|mdx)$/i.test(input.uri.path)) return null;
    return { uri: input.uri, label: tab.label };
  }

  // Plain webview panels (VS Code's built-in preview) expose only a view type,
  // so the source document has to be found from the tab label.
  if (vscode.TabInputWebview && input instanceof vscode.TabInputWebview) {
    if (!PREVIEW_VIEW_TYPE.test(input.viewType)) return null;
    const name = tab.label.replace(/^preview\s+/i, '').trim();
    if (!READABLE_PREVIEW_EXT.test(name)) return null;
    return { uri: null, label: name };
  }

  return null;
}

/**
 * Resolve a preview tab to a snapshot of the document behind it.
 * @param {{ uri: vscode.Uri | null, label: string }} target
 * @returns {Promise<Snapshot | null>}
 */
async function resolvePreviewSnapshot(target) {
  if (!target) return null;

  let uri = target.uri;
  if (!uri) {
    const name = basenameOf(target.label) || target.label;
    const open = vscode.workspace.textDocuments.find(doc => basenameOf(doc.uri) === name);
    if (open) {
      uri = open.uri;
    } else {
      try {
        const found = await vscode.workspace.findFiles(`**/${name}`, '**/node_modules/**', 2);
        if (found.length > 0) uri = found[0];
      } catch (_) {
        return null;
      }
    }
  }
  if (!uri) return null;

  let doc;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch (_) {
    return null;
  }

  const text = doc.getText();
  if (!text || !text.trim()) return null;

  return {
    text,
    uri: doc.uri,
    version: doc.version,
    startOffset: 0,
    endOffset: text.length,
    languageId: doc.languageId,
    fileName: basenameOf(doc.uri),
    wordCount: countWords(text),
    charCount: text.length,
    fromCursor: false,
    source: 'preview'
  };
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

    /** @type {Snapshot | null} */
    this._previewSnapshot = null;

    this._disposables.push(
      vscode.window.onDidChangeActiveTextEditor(() => this._triggerUpdate('editor')),
      vscode.window.onDidChangeTextEditorSelection(() => this._triggerUpdate('selection'))
    );

    // Switching to (or away from) a preview tab changes what is readable.
    if (vscode.window.tabGroups) {
      this._disposables.push(
        vscode.window.tabGroups.onDidChangeTabs(() => this._triggerUpdate('editor')),
        vscode.window.tabGroups.onDidChangeTabGroups(() => this._triggerUpdate('editor'))
      );
    }

    this._triggerUpdate('init', true);
  }

  /**
   * Get the current snapshot or fallback to last cached snapshot
   * @param {boolean} [requireFresh=false]
   * @returns {Snapshot | null}
   */
  getSnapshot(requireFresh = false) {
    // A focused preview tab wins: `activeTextEditor` still points at the last
    // editor used, which is not what the user is looking at.
    const previewTarget = getActivePreviewTarget();
    if (previewTarget && this._previewSnapshot) {
      const wanted = previewTarget.uri ? previewTarget.uri.toString() : null;
      const have = this._previewSnapshot.uri ? this._previewSnapshot.uri.toString() : null;
      if (!wanted || wanted === have) {
        return this._previewSnapshot;
      }
    }

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
   * Snapshot for playback. Resolves the active preview tab if there is one,
   * because that lookup needs to open the underlying document.
   * @returns {Promise<Snapshot | null>}
   */
  async getSnapshotAsync() {
    const previewTarget = getActivePreviewTarget();
    if (previewTarget) {
      const snapshot = await resolvePreviewSnapshot(previewTarget);
      if (snapshot) {
        this._previewSnapshot = snapshot;
        return snapshot;
      }
    } else {
      this._previewSnapshot = null;
    }
    return this.getSnapshot(false);
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

    const run = async () => {
      const editor = vscode.window.activeTextEditor;
      const hasSelection = Boolean(editor && !editor.selection.isEmpty);
      vscode.commands.executeCommand('setContext', 'audioCursor.hasSelection', hasSelection);

      const previewTarget = getActivePreviewTarget();
      if (previewTarget) {
        this._previewSnapshot = await resolvePreviewSnapshot(previewTarget);
      } else {
        this._previewSnapshot = null;
      }

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
  getActivePreviewTarget,
  resolvePreviewSnapshot,
  createTextSnapshot,
  countWords,
  formatEstimatedDuration,
  SelectionTracker
};
