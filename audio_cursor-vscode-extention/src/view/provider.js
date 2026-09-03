const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const log = require('../log');

class AudioCursorViewProvider {
  static viewType = 'audioCursor.player';

  /**
   * @param {vscode.Uri} extensionUri
   */
  constructor(extensionUri) {
    this._extensionUri = extensionUri;
    /** @type {vscode.WebviewView | null} */
    this._view = null;
    this._isReady = false;
    this._pendingMessages = [];
    this._messageHandlers = new Set();
    this._readyHandlers = new Set();
  }

  /**
   * @param {vscode.WebviewView} webviewView
   * @param {vscode.WebviewViewResolveContext} _context
   * @param {vscode.CancellationToken} _token
   */
  resolveWebviewView(webviewView, _context, _token) {
    this._view = webviewView;
    this._isReady = false;

    // Note: retainContextWhenHidden is NOT a WebviewOptions property — for a
    // view it belongs to the `webviewOptions` passed to
    // registerWebviewViewProvider, which extension.js already does. Setting it
    // here would be silently ignored.
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this._extensionUri, 'src', 'view'),
        vscode.Uri.joinPath(this._extensionUri, 'media')
      ]
    };

    webviewView.description = 'Player';
    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message) => {
      if (message.type === 'ready') {
        this._isReady = true;
        log.info('Webview engine signaled ready');
        // Flush pending messages
        while (this._pendingMessages.length > 0) {
          const msg = this._pendingMessages.shift();
          this.postMessage(msg);
        }
        for (const rh of this._readyHandlers) {
          try {
            rh();
          } catch (err) {
            log.error('Error in onReady handler', err);
          }
        }
      }

      for (const handler of this._messageHandlers) {
        try {
          handler(message);
        } catch (err) {
          log.error('Error handling webview message:', err);
        }
      }
    });

    webviewView.onDidDispose(() => {
      this._view = null;
      this._isReady = false;
      log.info('Webview disposed');
    });

    log.info('Audio Cursor sidebar webview resolved');
  }

  /**
   * Check if webview is resolved and ready
   * @returns {boolean}
   */
  isReady() {
    return this._view !== null && this._isReady;
  }

  /**
   * Check if webview is resolved (even if still loading)
   * @returns {boolean}
   */
  isResolved() {
    return this._view !== null;
  }

  /**
   * Reveal an already-resolved view. Unlike the generated
   * `audioCursor.player.focus` command this can leave keyboard focus where it
   * is, so starting playback never pulls the caret out of the editor.
   * @param {boolean} preserveFocus
   * @returns {boolean} false when there is no resolved view to show
   */
  show(preserveFocus = true) {
    if (!this._view) return false;
    try {
      this._view.show(preserveFocus);
      return true;
    } catch (err) {
      log.warn('Could not show Audio Cursor player view:', err);
      return false;
    }
  }

  /**
   * Whether the sidebar is currently showing the player.
   * @returns {boolean}
   */
  isVisible() {
    return this._view !== null && this._view.visible === true;
  }

  /**
   * Post message to webview, queueing if not ready yet
   * @param {Object} message
   */
  postMessage(message) {
    if (this._view && this._isReady) {
      this._view.webview.postMessage(message);
    } else {
      this._pendingMessages.push(message);
    }
  }

  /**
   * Register a listener for webview messages
   * @param {(msg: Object) => void} handler
   * @returns {vscode.Disposable}
   */
  onMessage(handler) {
    this._messageHandlers.add(handler);
    return {
      dispose: () => this._messageHandlers.delete(handler)
    };
  }

  /**
   * Register a listener for when webview becomes ready
   * @param {() => void} handler
   * @returns {vscode.Disposable}
   */
  onReady(handler) {
    this._readyHandlers.add(handler);
    if (this._isReady) {
      handler();
    }
    return {
      dispose: () => this._readyHandlers.delete(handler)
    };
  }

  /**
   * @param {vscode.Webview} webview
   * @returns {string}
   */
  _getHtmlForWebview(webview) {
    const nonce = this._getNonce();
    const htmlPath = path.join(this._extensionUri.fsPath, 'src', 'view', 'player.html');
    let html = fs.readFileSync(htmlPath, 'utf8');

    const cssPath = path.join(this._extensionUri.fsPath, 'src', 'view', 'player.css');
    let cssContent = '';
    try {
      cssContent = fs.readFileSync(cssPath, 'utf8');
    } catch (_) {}

    const jsPath = path.join(this._extensionUri.fsPath, 'src', 'view', 'player.js');
    let jsContent = '';
    try {
      jsContent = fs.readFileSync(jsPath, 'utf8');
    } catch (_) {}

    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'src', 'view', 'player.css'));
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'src', 'view', 'player.js'));

    html = html.replace(/#{cspSource}/g, webview.cspSource);
    html = html.replace(/#{nonce}/g, nonce);
    html = html.replace(/#{styleUri}/g, `${styleUri.toString()}?v=${Date.now()}`);
    html = html.replace(/#{scriptUri}/g, `${scriptUri.toString()}?v=${Date.now()}`);

    if (cssContent) {
      html = html.replace('</head>', `<style>${cssContent}</style></head>`);
    }

    if (jsContent) {
      html = html.replace(
        /<script nonce="[^"]*" src="[^"]*"><\/script>/,
        `<script nonce="${nonce}">${jsContent}</script>`
      );
    }

    return html;
  }

  _getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  dispose() {
    this._messageHandlers.clear();
    this._readyHandlers.clear();
    this._pendingMessages = [];
    this._view = null;
  }
}

module.exports = {
  AudioCursorViewProvider
};
