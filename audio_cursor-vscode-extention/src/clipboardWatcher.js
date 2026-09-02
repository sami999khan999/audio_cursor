const vscode = require('vscode');
const log = require('./log');
const { createTextSnapshot, getActivePreviewTarget } = require('./selection');

const POLL_INTERVAL_MS = 400;

/**
 * Watches for selections made in surfaces that have no selection API —
 * terminals and document previews — so they land in the player preview
 * exactly like editor selections do.
 *
 * VS Code exposes no terminal-selection API and no clipboard event, so this
 * leans on `terminal.integrated.copyOnSelection`: with that on, selecting text
 * in a terminal puts it on the clipboard, and a read-only poll picks it up.
 * It never writes to the clipboard.
 *
 * Focus cannot be used to attribute a clipboard change — `activeTextEditor`
 * stays set while a terminal has focus ("when none has focus, the one that has
 * changed input most recently"). So the one false positive that matters,
 * copying inside an editor, is excluded by value instead: a clipboard change
 * equal to the editor's own selection is not a terminal selection.
 */
class ClipboardSelectionWatcher {
  /**
   * @param {import('./config').config} config
   */
  constructor(config) {
    this._config = config;
    this._listeners = new Set();
    this._lastText = null;
    this._suspendDepth = 0;
    this._needsReseed = false;
    this._timer = null;

    // Seed with whatever is already on the clipboard so the current contents
    // are never mistaken for a fresh selection.
    vscode.env.clipboard.readText().then(
      text => { this._lastText = text; },
      () => {}
    );

    this._timer = setInterval(() => this._tick(), POLL_INTERVAL_MS);
  }

  /**
   * @param {(snapshot: Object) => void} listener
   * @returns {vscode.Disposable}
   */
  onDidChange(listener) {
    this._listeners.add(listener);
    return { dispose: () => this._listeners.delete(listener) };
  }

  /** Pause watching while the extension itself writes to the clipboard. */
  suspend() {
    this._suspendDepth++;
  }

  /**
   * Resume watching.
   * @param {string} [knownClipboardText] Clipboard contents to treat as already seen.
   */
  resume(knownClipboardText) {
    this._suspendDepth = Math.max(0, this._suspendDepth - 1);
    if (typeof knownClipboardText === 'string') {
      this._lastText = knownClipboardText;
    }
  }

  /** Forget the last seen text so the next identical selection re-fires. */
  reset() {
    this._lastText = null;
  }

  async _tick() {
    if (this._suspendDepth > 0) return;

    // Nothing is read at all unless a watchable surface is in play; the
    // reseed flag makes the first read after that a silent one, so a change
    // made while blind never fires retroactively.
    const surface = this._currentSurface();
    if (!surface) {
      this._needsReseed = true;
      return;
    }

    let text;
    try {
      text = await vscode.env.clipboard.readText();
    } catch (_) {
      return;
    }

    if (this._suspendDepth > 0 || typeof text !== 'string') return;

    // Always record what was seen, even when this change is not a terminal
    // selection — otherwise a copy made elsewhere fires the moment the
    // terminal regains focus.
    const changed = text !== this._lastText;
    this._lastText = text;

    if (this._needsReseed) {
      this._needsReseed = false;
      return;
    }
    if (!changed) return;

    if (!text.trim()) return;
    if (this._matchesEditorSelection(text)) return;

    const snapshot = createTextSnapshot(text, {
      label: surface.label,
      source: surface.kind
    });
    if (!snapshot) return;

    if (surface.kind === 'preview') {
      // Already-rendered text: it needs no Markdown clean-up.
      snapshot.rendered = true;
      snapshot.previewKey = surface.key;
    }

    log.info(`${surface.kind === 'preview' ? 'Preview' : 'Terminal'} selection detected (${snapshot.wordCount} words).`);
    for (const listener of this._listeners) {
      try {
        listener(snapshot);
      } catch (err) {
        log.error('Error in terminal selection listener:', err);
      }
    }
  }

  /**
   * The surface a clipboard change would be attributed to right now, or null
   * when there is nothing worth watching.
   * @returns {{ kind: 'preview' | 'terminal', label: string, key?: string } | null}
   */
  _currentSurface() {
    const previewTarget = getActivePreviewTarget();
    if (previewTarget && this._config.get('watchPreviewSelection')) {
      const label = previewTarget.uri
        ? (previewTarget.uri.path.split(/[\\/]/).pop() || previewTarget.label)
        : previewTarget.label;
      return {
        kind: 'preview',
        label,
        key: previewTarget.uri ? previewTarget.uri.toString() : previewTarget.label
      };
    }

    const terminal = vscode.window.activeTerminal;
    if (terminal && vscode.window.terminals.length > 0 && this._config.get('watchTerminalSelection')) {
      return { kind: 'terminal', label: terminal.name ? `Terminal: ${terminal.name}` : 'Terminal' };
    }

    return null;
  }

  /**
   * Public form of the editor-selection check, used before trusting a copy
   * captured from a preview.
   * @param {string} text
   * @returns {boolean}
   */
  matchesEditorSelection(text) {
    return this._matchesEditorSelection(text);
  }

  /**
   * True when the text is exactly what is selected in the active editor, i.e.
   * the user copied from the editor rather than selecting in a terminal.
   * @param {string} text
   * @returns {boolean}
   */
  _matchesEditorSelection(text) {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !editor.document) return false;

    const selections = (editor.selections || [editor.selection]).filter(sel => sel && !sel.isEmpty);
    if (selections.length === 0) return false;

    if (selections.some(sel => editor.document.getText(sel) === text)) return true;

    // Multi-cursor copies join the selections with newlines.
    const joined = selections.map(sel => editor.document.getText(sel)).join('\n');
    return joined === text;
  }

  dispose() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._listeners.clear();
  }
}

module.exports = {
  ClipboardSelectionWatcher
};
