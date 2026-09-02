const vscode = require('vscode');
const log = require('./log');
const { config } = require('./config');
const { SelectionTracker } = require('./selection');
const { StatusBarController } = require('./statusBar');
const { DecorationController } = require('./decorations');
const { AudioCursorViewProvider } = require('./view/provider');
const { AudioCursorController } = require('./controller');

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  log.info('Audio Cursor activating...');

  const selectionTracker = new SelectionTracker(config);
  const statusBar = new StatusBarController(config);
  const decorations = new DecorationController(config);
  const provider = new AudioCursorViewProvider(context.extensionUri);

  const controller = new AudioCursorController({
    config,
    selectionTracker,
    statusBar,
    decorations,
    viewProvider: provider,
    memento: context.globalState
  });

  // Register Webview View Provider
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      AudioCursorViewProvider.viewType,
      provider,
      {
        webviewOptions: {
          retainContextWhenHidden: true
        }
      }
    )
  );

  // Register Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('audioCursor.togglePlayback', () => controller.togglePlayback()),
    vscode.commands.registerCommand('audioCursor.play', () => controller.play()),
    vscode.commands.registerCommand('audioCursor.pause', () => controller.pause()),
    vscode.commands.registerCommand('audioCursor.stop', () => controller.stop()),
    vscode.commands.registerCommand('audioCursor.readSelection', () => controller.readSelection()),
    vscode.commands.registerCommand('audioCursor.readFromCursor', () => controller.readFromCursor()),
    vscode.commands.registerCommand('audioCursor.readTerminalSelection', () => controller.readTerminalSelection()),
    vscode.commands.registerCommand('audioCursor.togglePlaybackTerminal', () => controller.togglePlaybackTerminal()),
    vscode.commands.registerCommand('audioCursor.nextSentence', () => controller.nextSentence()),
    vscode.commands.registerCommand('audioCursor.previousSentence', () => controller.previousSentence()),
    vscode.commands.registerCommand('audioCursor.selectVoice', () => controller.selectVoice()),
    vscode.commands.registerCommand('audioCursor.increaseRate', () => controller.increaseRate()),
    vscode.commands.registerCommand('audioCursor.decreaseRate', () => controller.decreaseRate()),
    vscode.commands.registerCommand('audioCursor.openPanel', () => controller.openPanel()),
    vscode.commands.registerCommand('audioCursor.openKeybindings', () => controller.openKeybindings()),
    vscode.commands.registerCommand('audioCursor.showLogs', () => controller.showLogs())
  );

  // Register Component Disposables
  context.subscriptions.push(
    selectionTracker,
    statusBar,
    decorations,
    provider,
    controller,
    config,
    {
      dispose: () => log.dispose()
    }
  );

  log.info('Audio Cursor activated successfully');
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
