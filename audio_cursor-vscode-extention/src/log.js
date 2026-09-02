const vscode = require('vscode');

/** @type {vscode.OutputChannel | null} */
let channel = null;

function getChannel() {
  if (!channel) {
    channel = vscode.window.createOutputChannel('Audio Cursor');
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
