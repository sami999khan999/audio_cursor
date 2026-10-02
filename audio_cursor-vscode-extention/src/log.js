// Outside VS Code (bin/speak.js, the standalone reader) lines go to stderr.
let vscode = null;
try {
  vscode = require('vscode');
} catch (_) { /* not in the extension host */ }

/** @type {{ appendLine(line: string): void, show(preserveFocus?: boolean): void, dispose(): void } | null} */
let channel = null;

function getChannel() {
  if (!channel) {
    channel = vscode
      ? vscode.window.createOutputChannel('Audio Cursor')
      : { appendLine: line => process.stderr.write(line + '\n'), show() {}, dispose() {} };
  }
  return channel;
}

function format(level, message, ...args) {
  const timestamp = new Date().toISOString().substring(11, 19);
  const extra = args.length > 0 ? ' ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ') : '';
  return `[${timestamp}] [${level}] ${message}${extra}`;
}

function info(message, ...args) {
  getChannel().appendLine(format('INFO', message, ...args));
}

function warn(message, ...args) {
  getChannel().appendLine(format('WARN', message, ...args));
}

function error(message, ...args) {
  getChannel().appendLine(format('ERROR', message, ...args));
}

function show() {
  getChannel().show(true);
}

function dispose() {
  if (channel) {
    channel.dispose();
    channel = null;
  }
}

module.exports = {
  info,
  warn,
  error,
  show,
  dispose
};
