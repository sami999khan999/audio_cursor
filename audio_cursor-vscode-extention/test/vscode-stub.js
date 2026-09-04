/**
 * Enough of the `vscode` module to load the extension host code outside VS Code.
 * Not a simulation of the editor — just the surface the modules touch at
 * require time and during a basic controller lifecycle.
 */

const noopDisposable = { dispose() {} };
const event = () => noopDisposable;

const state = {
  posted: [],
  info: [],
  commands: [],
  contextKeys: {},
  clipboard: '',
  configValues: {}
};

const workspaceConfig = (section) => ({
  get: (key, fallback) => {
    const value = state.configValues[`${section}.${key}`];
    return value === undefined ? fallback : value;
  },
  inspect: () => undefined,
  update: async () => {}
});

const vscode = {
  __state: state,
  Uri: {
    joinPath: (base, ...parts) => ({ fsPath: [base && base.fsPath, ...parts].join('/'), path: parts.join('/'), toString: () => parts.join('/') })
  },
  Range: class Range { constructor(start, end) { this.start = start; this.end = end; } },
  ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
  StatusBarAlignment: { Right: 2, Left: 1 },
  ConfigurationTarget: { Global: 1 },
  TextEditorRevealType: { InCenterIfOutsideViewport: 2 },
  TextEditorSelectionChangeKind: { Mouse: 2, Keyboard: 1 },
  QuickPickItemKind: { Separator: -1 },
  TabInputCustom: class TabInputCustom {},
  TabInputWebview: class TabInputWebview {},
  window: {
    activeTextEditor: undefined,
    activeTerminal: undefined,
    terminals: [],
    tabGroups: { activeTabGroup: { activeTab: null }, onDidChangeTabs: event, onDidChangeTabGroups: event },
    createOutputChannel: () => ({ appendLine: (l) => state.info.push(l), show() {}, dispose() {} }),
    createStatusBarItem: () => ({ text: '', tooltip: '', command: '', show() {}, hide() {}, dispose() {} }),
    createTextEditorDecorationType: () => ({ dispose() {} }),
    showInformationMessage: (msg) => { state.posted.push(['info', msg]); return Promise.resolve(undefined); },
    showWarningMessage: (msg) => { state.posted.push(['warn', msg]); return Promise.resolve(undefined); },
    showErrorMessage: (msg) => { state.posted.push(['error', msg]); return Promise.resolve(undefined); },
    showQuickPick: async () => undefined,
    showTextDocument: async () => ({}),
    setStatusBarMessage() {},
    onDidChangeActiveTextEditor: event,
    onDidChangeTextEditorSelection: event,
    onDidChangeTextEditorVisibleRanges: event,
    onDidOpenTerminal: event,
    onDidCloseTerminal: event,
    onDidChangeActiveTerminal: event,
    registerWebviewViewProvider: () => noopDisposable
  },
  workspace: {
    getConfiguration: workspaceConfig,
    onDidChangeConfiguration: event,
    textDocuments: [],
    openTextDocument: async () => { throw new Error('no document'); },
    findFiles: async () => []
  },
  commands: {
    executeCommand: async (cmd, ...args) => {
      state.commands.push([cmd, ...args]);
      if (cmd === 'setContext') state.contextKeys[args[0]] = args[1];
      return undefined;
    },
    registerCommand: () => noopDisposable
  },
  env: {
    clipboard: {
      readText: async () => state.clipboard,
      writeText: async (t) => { state.clipboard = t; }
    }
  }
};

module.exports = vscode;
