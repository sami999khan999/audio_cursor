const vscode = require('vscode');

// How long after our own `revealRange` a visible-range change is still assumed
// to be its echo rather than the user scrolling.
const SELF_REVEAL_ECHO_MS = 250;

class DecorationController {
  /**
   * @param {import('./config').config} config
   */
  constructor(config) {
    this._config = config;

    this._wordDecorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('editor.findMatchHighlightBackground'),
      borderRadius: '3px',
      // A CSS custom property does not resolve inside decoration styles, so the
      // border was never drawn. ThemeColor is the supported way to say this.
      borderColor: new vscode.ThemeColor('editor.findMatchHighlightBorder'),
      borderStyle: 'solid',
      borderWidth: '1px'
    });

    this._sentenceDecorationType = vscode.window.createTextEditorDecorationType({
      backgroundColor: new vscode.ThemeColor('editor.rangeHighlightBackground'),
      borderRadius: '3px'
    });

    this._lastRevealTime = 0;
    this._userInteractedUntil = 0;
    // `revealRange` raises a visible-range change of its own, which used to be
    // read as the user scrolling — so auto-scroll switched itself off for five
    // seconds every time it scrolled. Ignore the echo of our own reveal.
    this._selfRevealUntil = 0;
    this._disposables = [];

    // Detect user manual scroll or selection changes to back off auto-scrolling
    this._disposables.push(
      vscode.window.onDidChangeTextEditorVisibleRanges(() => {
        if (Date.now() < this._selfRevealUntil) return;
        this._userInteractedUntil = Date.now() + 5000;
      }),
      vscode.window.onDidChangeTextEditorSelection(e => {
        if (e.kind === vscode.TextEditorSelectionChangeKind.Mouse || e.kind === vscode.TextEditorSelectionChangeKind.Keyboard) {
          this._userInteractedUntil = Date.now() + 5000;
        }
      })
    );
  }

  /**
   * Highlight the spoken word in the active editor
   * @param {vscode.TextEditor | undefined} editor
   * @param {Object} snapshot
   * @param {number} charIndex Snapshot-global character offset
   * @param {number} [charLength] Optional word length from speech boundary
   * @returns {{ docChanged: boolean }}
   */
  highlight(editor, snapshot, charIndex, charLength) {
    if (!editor || !editor.document || !snapshot || !snapshot.uri) {
      return { docChanged: false };
    }

    if (editor.document.uri.toString() !== snapshot.uri.toString()) {
      return { docChanged: false };
    }

    // Document version check
    if (editor.document.version !== snapshot.version) {
      this.clear(editor);
      return { docChanged: true };
    }

    if (!this._config.get('highlightWord')) {
      this.clear(editor);
      return { docChanged: false };
    }

    const doc = editor.document;
    const docOffset = Math.min(doc.getText().length, snapshot.startOffset + charIndex);
    const startPos = doc.positionAt(docOffset);

    // Compute word range
    let wordRange = doc.getWordRangeAtPosition(startPos);
    if (!wordRange) {
      const len = Math.max(1, charLength || 1);
      const endPos = doc.positionAt(Math.min(doc.getText().length, docOffset + len));
      wordRange = new vscode.Range(startPos, endPos);
    }

    editor.setDecorations(this._wordDecorationType, [wordRange]);

    // Follow cursor (reveal range in viewport) if enabled and not paused by user interaction
    if (this._config.get('followCursor')) {
      const now = Date.now();
      if (now > this._userInteractedUntil && now - this._lastRevealTime > 1000) {
        this._lastRevealTime = now;
        this._selfRevealUntil = now + SELF_REVEAL_ECHO_MS;
        editor.revealRange(wordRange, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
      }
    }

    return { docChanged: false };
  }

  /**
   * Clear decorations from the editor
   * @param {vscode.TextEditor} [editor]
   */
  clear(editor) {
    const target = editor || vscode.window.activeTextEditor;
    if (target) {
      target.setDecorations(this._wordDecorationType, []);
      target.setDecorations(this._sentenceDecorationType, []);
    }
  }

  dispose() {
    this._wordDecorationType.dispose();
    this._sentenceDecorationType.dispose();
    for (const d of this._disposables) {
      d.dispose();
    }
    this._disposables = [];
  }
}

module.exports = {
  DecorationController
};
