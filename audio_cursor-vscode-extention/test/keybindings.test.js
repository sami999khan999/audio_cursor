const test = require('node:test');
const assert = require('node:assert');
const path = require('path');

const {
  contributedKeybindings,
  userKeybindingsPath,
  parseUserKeybindings,
  resolveBindings,
  panelKeybindingRows,
  normalizeKey,
  formatKey
} = require(path.join(__dirname, '..', 'src', 'keybindings.js'));

const DEFAULTS = contributedKeybindings();

test('the manifest is what the panel reads its defaults from', () => {
  assert.ok(DEFAULTS.length >= 4, 'the contributed keybindings were found');
  assert.ok(
    DEFAULTS.some(b => b.command === 'audioCursor.stop' && b.key === 'alt+shift+p'),
    'including the Stop default the panel advertises'
  );
});

test('keybindings.json sits two levels above the extension global storage', () => {
  const p = userKeybindingsPath({ fsPath: path.join('C:', 'u', 'Code', 'User', 'globalStorage', 'x.y') });
  assert.strictEqual(p, path.join('C:', 'u', 'Code', 'User', 'keybindings.json'));
});

test('a real keybindings.json parses despite comments and trailing commas', () => {
  // Exactly the shape VS Code writes: a leading comment, trailing commas, and
  // a `//` sequence inside a string that must not be read as a comment.
  const text = `
// Place your key bindings in this file to override the defaults
[
  {
    "key": "shift+alt+0",
    "command": "audioCursor.stop",
    "when": "audioCursor.paused || audioCursor.playing",
  },
  // A remark
  {
    "key": "ctrl+k m",
    "command": "workbench.action.terminal.sendSequence",
    "args": { "text": "https://example.com" },
  },
]`;
  const entries = parseUserKeybindings(text);
  assert.strictEqual(entries.length, 2);
  assert.strictEqual(entries[0].key, 'shift+alt+0');
  assert.strictEqual(entries[1].args.text, 'https://example.com');
});

test('unreadable or empty keybindings.json means "no overrides", not a crash', () => {
  assert.deepStrictEqual(parseUserKeybindings(''), []);
  assert.deepStrictEqual(parseUserKeybindings('   '), []);
  assert.deepStrictEqual(parseUserKeybindings('not json at all'), []);
  assert.deepStrictEqual(parseUserKeybindings('{"not": "an array"}'), []);

  // Half-typed is the normal state of a file open in an editor. What parsed is
  // kept; an entry with no key yet cannot rebind anything, so it changes
  // nothing downstream.
  const partial = parseUserKeybindings('[{"command": "audioCursor.stop", "key":');
  assert.deepStrictEqual(partial, [{ command: 'audioCursor.stop' }]);
  assert.deepStrictEqual(
    panelKeybindingRows(DEFAULTS, partial).find(r => r.label === 'Stop').keys,
    ['Shift+Alt+P']
  );
});

test('modifier order and case do not make two chords different', () => {
  assert.strictEqual(normalizeKey('Shift+Alt+P'), normalizeKey('alt+shift+p'));
  assert.notStrictEqual(normalizeKey('alt+shift+p'), normalizeKey('alt+shift+o'));
});

test('chords are labelled the way VS Code labels them', () => {
  assert.strictEqual(formatKey('alt+shift+p'), 'Shift+Alt+P');
  assert.strictEqual(formatKey('shift+alt+0'), 'Shift+Alt+0');
  assert.strictEqual(formatKey('ctrl+k ctrl+o'), 'Ctrl+K Ctrl+O');
  assert.strictEqual(formatKey('escape'), 'Esc');
});

test('remapping Stop is what the panel shows', () => {
  // The reported bug: Stop was remapped to Shift+Alt+0 in the Keyboard
  // Shortcuts editor and the sidebar went on printing Alt+Shift+P.
  const userEntries = parseUserKeybindings(`[
    { "key": "shift+alt+0", "command": "audioCursor.stop",
      "when": "audioCursor.paused || audioCursor.playing" },
    { "key": "shift+alt+p", "command": "-audioCursor.stop",
      "when": "audioCursor.paused || audioCursor.playing" },
  ]`);

  const rows = panelKeybindingRows(DEFAULTS, userEntries);
  const stop = rows.find(r => r.label === 'Stop');

  assert.deepStrictEqual(stop.keys, ['Shift+Alt+0'], 'the remap is shown');
  assert.ok(!stop.keys.includes('Shift+Alt+P'), 'and the removed default is gone');

  // The rows the user did not touch are untouched.
  assert.deepStrictEqual(
    rows.filter(r => r.label !== 'Stop').map(r => r.keys),
    [['Alt+P'], ['Alt+P'], ['Alt+P']]
  );
});

test('with no user file at all, the panel shows the contributed defaults', () => {
  const rows = panelKeybindingRows(DEFAULTS, []);
  assert.deepStrictEqual(rows.map(r => r.keys), [['Alt+P'], ['Alt+P'], ['Alt+P'], ['Shift+Alt+P']]);
  assert.ok(rows.every(r => !r.unassigned));
});

test('a command whose only binding was removed reads as unassigned', () => {
  const rows = panelKeybindingRows(DEFAULTS, [{ command: '-audioCursor.stop' }]);
  const stop = rows.find(r => r.label === 'Stop');
  assert.strictEqual(stop.unassigned, true);
  assert.deepStrictEqual(stop.keys, []);
});

test('a removal naming a different key leaves the default alone', () => {
  // VS Code narrows a removal by key when one is given, so this must not
  // silently blank a binding it does not actually match.
  const rows = panelKeybindingRows(DEFAULTS, [{ command: '-audioCursor.stop', key: 'ctrl+q' }]);
  assert.deepStrictEqual(rows.find(r => r.label === 'Stop').keys, ['Shift+Alt+P']);
});

test('an added chord is listed alongside the default it did not replace', () => {
  const rows = panelKeybindingRows(DEFAULTS, [{ command: 'audioCursor.stop', key: 'ctrl+alt+s' }]);
  const stop = rows.find(r => r.label === 'Stop');
  assert.strictEqual(stop.keys.length, 2, 'both chords run Stop, so both are shown');
  assert.ok(stop.keys.includes('Ctrl+Alt+S') && stop.keys.includes('Shift+Alt+P'));
});

test('other extensions’ keybindings are ignored', () => {
  const rows = panelKeybindingRows(DEFAULTS, [
    { command: 'workbench.action.files.save', key: 'ctrl+s' },
    { command: '-editor.toggleFold', key: 'ctrl+k ctrl+l' }
  ]);
  assert.deepStrictEqual(rows.map(r => r.keys), [['Alt+P'], ['Alt+P'], ['Alt+P'], ['Shift+Alt+P']]);
});

test('the terminal row follows its own command, not the editor one', () => {
  // Play/pause in a terminal is a separate command, so remapping the editor
  // binding must not claim to have changed the terminal one.
  const rows = panelKeybindingRows(DEFAULTS, [
    { command: '-audioCursor.togglePlayback', key: 'alt+p' },
    { command: 'audioCursor.togglePlayback', key: 'alt+j' }
  ]);
  assert.deepStrictEqual(rows.find(r => r.label === 'Editor · Play / Pause').keys, ['Alt+J']);
  assert.deepStrictEqual(rows.find(r => r.label === 'Terminal · Play / Pause').keys, ['Alt+P']);
});

test('every panel row names a command the manifest actually contributes', () => {
  const commands = new Set(DEFAULTS.map(b => b.command));
  for (const row of panelKeybindingRows(DEFAULTS, [])) {
    assert.ok(!row.unassigned, `${row.label} resolved to a real contributed binding`);
  }
  const { PANEL_ROWS } = require(path.join(__dirname, '..', 'src', 'keybindings.js'));
  for (const row of PANEL_ROWS) {
    assert.ok(commands.has(row.command), `${row.command} is contributed`);
  }
});

test('a when clause matches however its operands are ordered', () => {
  // What the Keyboard Shortcuts editor actually writes when it removes a
  // binding: the same expression, operands reordered by its own serializer.
  const { normalizeWhen } = require(path.join(__dirname, '..', 'src', 'keybindings.js'));
  assert.strictEqual(
    normalizeWhen('audioCursor.playing || audioCursor.paused'),
    normalizeWhen('audioCursor.paused || audioCursor.playing')
  );
  assert.strictEqual(normalizeWhen('a && b'), normalizeWhen('b   &&   a'));
  assert.notStrictEqual(normalizeWhen('terminalFocus'), normalizeWhen('editorTextFocus'));
});
