/**
 * What the sidebar's shortcut list should say.
 *
 * VS Code exposes no API for resolved keybindings — an extension cannot ask
 * what key runs one of its commands (microsoft/vscode#4504). The panel used to
 * print the four defaults as literal text, so a remap in the Keyboard Shortcuts
 * editor left it advertising a chord that no longer did anything.
 *
 * So the list is worked out the way VS Code works it out: start from the
 * defaults this extension contributes, then apply the user's `keybindings.json`
 * over them. That covers the case that matters — the user rebinding our own
 * commands. It cannot see a *different* extension binding over our chord, so a
 * key shown here is what this extension asked for, not a promise that nothing
 * else claimed it.
 */

const path = require('path');
const jsonc = require('jsonc-parser');
const manifest = require('../package.json');

/**
 * This extension's own default keybindings, straight from the manifest that
 * declares them — so the panel and the contribution can never drift apart, and
 * no extension-id lookup can fail on casing.
 * @returns {Array<Object>}
 */
function contributedKeybindings() {
  return (manifest.contributes && manifest.contributes.keybindings) || [];
}

// The rows the panel lists, in order. `when` is the contributed clause of the
// binding each row describes; it is what tells two bindings of the same command
// apart when the user has given the surfaces different keys.
//
// The surface leads the label because a narrow side bar clips the end: three
// rows reading "Play / Pause in an…", "Play / Pause in a…", "Play / Pause in
// a…" are indistinguishable, whereas "Editor · Play…", "Terminal · Pl…" and
// "Preview · Pl…" still say which is which.
const PANEL_ROWS = [
  {
    label: 'Editor · Play / Pause',
    command: 'audioCursor.togglePlayback',
    when: 'editorTextFocus || audioCursor.playing || audioCursor.paused'
  },
  {
    label: 'Terminal · Play / Pause',
    command: 'audioCursor.togglePlaybackTerminal',
    when: 'terminalFocus'
  },
  {
    label: 'Preview · Play / Pause',
    command: 'audioCursor.togglePlayback',
    when: 'activeCustomEditorId =~ /markdown/ || activeWebviewPanelId =~ /markdown/'
  },
  {
    label: 'Stop',
    command: 'audioCursor.stop',
    when: 'audioCursor.playing || audioCursor.paused'
  }
];

/**
 * The user's keybindings.json, next to the extension's own global storage.
 *
 * `globalStorageUri` is `<user data>/User/globalStorage/<extension id>`, so the
 * file is two levels up. Deriving it that way rather than hardcoding
 * `%APPDATA%/Code` keeps it correct for Insiders, VSCodium, other forks, a
 * portable install and `--user-data-dir`.
 *
 * @param {{ fsPath: string }} globalStorageUri
 * @returns {string}
 */
function userKeybindingsPath(globalStorageUri) {
  return path.join(globalStorageUri.fsPath, '..', '..', 'keybindings.json');
}

/**
 * Parse keybindings.json. It is JSONC — comments and trailing commas are both
 * normal there, and both are present in a file VS Code has written itself, so
 * it can never go through JSON.parse.
 *
 * @param {string} text
 * @returns {Array<Object>} the entries, or [] for anything unreadable
 */
function parseUserKeybindings(text) {
  if (!text || !text.trim()) return [];
  const errors = [];
  const parsed = jsonc.parse(text, errors, { allowTrailingComma: true });
  // A half-typed file is the normal state of one that is open in an editor.
  // Whatever survived is still better than nothing, so errors are not fatal.
  return Array.isArray(parsed) ? parsed.filter(entry => entry && typeof entry.command === 'string') : [];
}

/**
 * Normalize a chord for comparison: VS Code treats modifier order and case as
 * insignificant, so `Shift+Alt+P` and `alt+shift+p` are the same binding.
 * @param {string} key
 * @returns {string}
 */
function normalizeKey(key) {
  return String(key || '')
    .trim()
    .toLowerCase()
    .split(/\s+/)                       // chords: "ctrl+k ctrl+o"
    .map(part => part.split('+').filter(Boolean).sort().join('+'))
    .join(' ');
}

/**
 * Canonical form of a `when` clause, for equality only.
 *
 * The Keyboard Shortcuts editor writes the clause back out from its parsed
 * form, which reorders the operands: removing the contributed
 * `audioCursor.playing || audioCursor.paused` produces an entry that reads
 * `audioCursor.paused || audioCursor.playing`. Comparing those as plain strings
 * said "different clause", the removal was ignored, and the panel went on
 * showing a chord the user had just deleted.
 *
 * Sorting the operands is enough for the clauses involved here. It does not
 * understand parentheses; a clause using them that fails to match simply leaves
 * the contributed binding in place, which is the conservative direction.
 *
 * @param {string} when
 * @returns {string}
 */
function normalizeWhen(when) {
  return String(when || '')
    .split('||')
    .map(clause => clause.split('&&').map(term => term.trim()).filter(Boolean).sort().join(' && '))
    .filter(Boolean)
    .sort()
    .join(' || ');
}

/**
 * Whether a user entry removing a binding (`"command": "-audioCursor.stop"`)
 * applies to a contributed one. VS Code matches the command, and narrows by key
 * and `when` when the removal names them.
 *
 * @param {Object} removal
 * @param {Object} binding
 * @returns {boolean}
 */
function removalMatches(removal, binding) {
  if (removal.command.slice(1) !== binding.command) return false;
  if (removal.key && normalizeKey(removal.key) !== normalizeKey(binding.key)) return false;
  if (removal.when && normalizeWhen(removal.when) !== normalizeWhen(binding.when)) return false;
  return true;
}

/**
 * The bindings in force for this extension's commands.
 *
 * @param {Array<Object>} contributed defaults from package.json
 * @param {Array<Object>} userEntries parsed keybindings.json
 * @returns {Array<{command: string, key: string, when: string, source: 'default' | 'user'}>}
 */
function resolveBindings(contributed, userEntries) {
  const ours = new Set(contributed.map(b => b.command));
  const entries = Array.isArray(userEntries) ? userEntries : [];

  const removals = entries.filter(e => e.command.startsWith('-'));
  const additions = entries.filter(e => !e.command.startsWith('-') && ours.has(e.command) && e.key);

  const kept = contributed
    .filter(binding => !removals.some(removal => removalMatches(removal, binding)))
    .map(binding => ({
      command: binding.command,
      key: binding.key,
      when: binding.when || '',
      source: 'default'
    }));

  // Later entries win in VS Code, and user entries outrank defaults, so the
  // additions go on the end.
  return kept.concat(additions.map(entry => ({
    command: entry.command,
    key: entry.key,
    when: entry.when || '',
    source: 'user'
  })));
}

/**
 * How many `when` terms two clauses share — used only to pick the binding that
 * best fits a row when one command has several. An added user binding usually
 * carries no `when` at all, which is why a zero score still counts.
 * @returns {number}
 */
function whenAffinity(rowWhen, bindingWhen) {
  if (!bindingWhen) return 0;
  if (String(rowWhen).trim() === String(bindingWhen).trim()) return 100;
  const terms = String(bindingWhen).split(/[^\w.]+/).filter(t => t.length > 3);
  return terms.filter(term => String(rowWhen).includes(term)).length;
}

/**
 * Render a chord the way VS Code's own keybinding labels do: `alt+shift+p`
 * becomes `Alt+Shift+P`, in a fixed modifier order.
 * @param {string} key
 * @returns {string}
 */
function formatKey(key) {
  const MODIFIER_ORDER = ['ctrl', 'shift', 'alt', 'cmd', 'meta', 'win'];
  const NAMES = {
    ctrl: 'Ctrl', shift: 'Shift', alt: 'Alt', cmd: 'Cmd', meta: 'Meta', win: 'Win',
    escape: 'Esc', pageup: 'PageUp', pagedown: 'PageDown',
    left: 'Left', right: 'Right', up: 'Up', down: 'Down'
  };

  return String(key || '')
    .trim()
    .split(/\s+/)
    .map(chord => {
      const parts = chord.split('+').filter(Boolean).map(p => p.toLowerCase());
      const modifiers = MODIFIER_ORDER.filter(m => parts.includes(m));
      const keys = parts.filter(p => !MODIFIER_ORDER.includes(p));
      return modifiers.concat(keys)
        .map(p => NAMES[p] || (p.length === 1 ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1)))
        .join('+');
    })
    .join(' ');
}

/**
 * The rows the panel should render.
 *
 * @param {Array<Object>} contributed defaults from package.json
 * @param {Array<Object>} userEntries parsed keybindings.json
 * @returns {Array<{label: string, keys: string[], unassigned: boolean}>}
 */
function panelKeybindingRows(contributed, userEntries) {
  const resolved = resolveBindings(contributed, userEntries);

  return PANEL_ROWS.map(row => {
    const candidates = resolved.filter(b => b.command === row.command);
    if (!candidates.length) return { label: row.label, keys: [], unassigned: true };

    // Best `when` fit first, and a user binding ahead of a default at a tie.
    const ranked = candidates.slice().sort((a, b) => {
      const affinity = whenAffinity(row.when, b.when) - whenAffinity(row.when, a.when);
      if (affinity !== 0) return affinity;
      return (a.source === 'user' ? -1 : 0) - (b.source === 'user' ? -1 : 0);
    });

    const seen = new Set();
    const keys = [];
    for (const binding of ranked) {
      const normalized = normalizeKey(binding.key);
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      keys.push(formatKey(binding.key));
    }

    return { label: row.label, keys: keys.slice(0, 2), unassigned: false };
  });
}

module.exports = {
  PANEL_ROWS,
  contributedKeybindings,
  userKeybindingsPath,
  parseUserKeybindings,
  resolveBindings,
  panelKeybindingRows,
  normalizeKey,
  normalizeWhen,
  formatKey
};
