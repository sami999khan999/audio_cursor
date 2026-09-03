# Change Log

All notable changes to the "audio-cursor" extension will be documented in this file.

## [0.7.4]

### Fixed
- **The transport button can no longer become a dead end.** 0.7.3 gave the player an honest `starting`
  state, but its button only released a chunk parked on a user gesture — so if the neural pipeline stalled
  before any audio arrived, the panel sat on the spinner with a button that did nothing. Prior to 0.7.3 an
  unrecognised status fell through to a plain **Play** button whose click restarted the session, which was
  the manual workaround this state was meant to remove. Clicking now releases a parked chunk if there is
  one and otherwise asks the host to start over, so the button always does something.
- **The spinner now times out.** If nothing confirms playback within six seconds the player drops to
  **Tap to play** rather than spinning indefinitely.

### Added
- Script errors and unhandled rejections inside the player webview are reported to the **Audio Cursor**
  output channel. The webview has its own console that nothing outside it can read, so a failure in there
  previously showed up only as a player that looked stuck, with no trace anywhere.

## [0.7.3]

### Fixed
- **The player no longer claims to be playing before any sound comes out.** Pressing `Alt+P` for the first
  time in a window put the button straight into its "Pause" state, while Chromium was in fact holding the
  audio back until the webview had seen a user gesture — one that `Alt+P` cannot provide, because VS Code
  handles the shortcut, not the panel. Clicking the button then unblocked the audio through a capture-phase
  listener while the button itself sent a `pause` the host ignored, so the panel appeared to start playing
  *because* you pressed Pause. The webview now reports two honest pre-playback states: **Loading** (spinner,
  chunk still being synthesized) and **Tap to play** (audio ready, waiting on the click), and it only says
  "Playing" once an audio source has actually started. In either waiting state the button starts playback
  instead of sending a transport command.

  The single click itself cannot be removed: a webview may not begin audio until its document has had a user
  gesture, and this is per document, so it is needed once per VS Code window rather than once per read.

## [0.7.2]

### Fixed
- **The player no longer shifts around when you play and pause.** Three things moved on every toggle: the `paused` status badge was the only state carrying a border, so pausing grew it by 2px and pushed the whole panel down; the badge and the Play/Pause/Resume button resized as their labels were swapped, sliding the transport buttons sideways; and the notice above the source card was removed outright on Play, snapping everything below it upward. Labels now sit in a fixed-width slot sized by an invisible copy of their longest state, the border is reserved in every badge state, and the notice collapses through an animated height instead of disappearing.

## [0.7.1]

### Fixed
- **Playback no longer takes over the editor.** Starting a read pulled the caret into the Audio Cursor sidebar, and did so again whenever audio was waiting on a click. Revealing the player is now focus-preserving: once the view exists it is shown with `WebviewView.show(true)`, and the one unavoidable case — the very first read in a window, where VS Code will not create the view without focusing it — hands focus straight back to the editor or terminal you came from, caret and selection intact.
- Removed a `retainContextWhenHidden` flag set on `webview.options`, where it is not a recognized property and did nothing. The real one is passed to `registerWebviewViewProvider`, which was already correct — but the dead copy suggested the retention was configured in two places.

### Changed
- Marketplace metadata: added an extension icon, plus the `license`, `repository`, `bugs` and `homepage` fields the listing had been missing.

## [0.7.0]

### Added
- **Remap the shortcuts.** The sidebar's Settings section now lists every Audio Cursor binding and has a **Remap…** button that opens VS Code's keyboard-shortcuts editor filtered to this extension; the same thing is available as *Audio Cursor: Configure Keyboard Shortcuts*. VS Code owns the keymap, so this points at its editor rather than storing a second one — bindings you set there survive updates and sync with your settings.

## [0.6.3]

### Changed
- Reading a preview now tries to lift the **live selection** first: pressing Play or `Alt+P` with text selected in a preview reads just that, with no `Ctrl+C` needed, falling back to the last copied selection and then to the whole document. A webview's selection is exposed by no API and this VS Code build registers no webview copy command (only find), so the generic copy action is attempted and whatever it returns is verified — a copy that actually came from the editor is rejected instead of being read out. The clipboard is saved and restored around the attempt.
- The player now says how to read part of a preview when it falls back to the whole document.

## [0.6.2]

### Added
- **Selecting inside a preview now feeds the player**, like selecting in an editor or terminal. A preview is a webview, so its selection is invisible to extensions and no preview offers a copy-selection command — copy the selection (`Ctrl+C`) and it lands in the player, stops anything playing, and waits for Play. It then outranks the whole document until you re-activate the tab, which restores the full read. Switch off with `audioCursor.watchPreviewSelection`.

### Changed
- Markdown clean-up now also removes YAML front matter, HTML comments, setext heading underlines (`===`), trailing `###`, footnote markers, link reference definitions and backslash escapes, plus any `#`, `*`, backtick or `~` still attached to a word. A lone `*` between spaces survives, because that is arithmetic rather than markup.
- Text copied out of a preview is already rendered prose, so it skips Markdown clean-up entirely.
- `terminalWatcher.js` is now `clipboardWatcher.js`: it serves both surfaces that lack a selection API.

## [0.6.1]

### Fixed
- **`Alt+P` did nothing in a Markdown preview.** The keybinding required `editorTextFocus`, which is false in a preview — it is a webview, not a text editor. There is now a binding for `activeCustomEditorId =~ /markdown/ || activeWebviewPanelId =~ /markdown/`, which covers VS Code's built-in preview (`vscode.markdown.preview.editor`) and third-party ones such as Markdown Preview Enhanced.
- A focused preview tab now outranks a remembered terminal selection when choosing what to read; previously, once you had read terminal text, `Alt+P` in a preview replayed that instead of the document.

## [0.6.0]

### Added
- **Markdown previews are readable.** With a preview tab focused (VS Code's built-in preview or a custom one such as Markdown Preview Enhanced), the player fills with the document behind it and `Alt+P` reads it. A preview is a webview, so its contents and selection are unreachable — Audio Cursor resolves the tab to its source file instead: via the tab's uri for custom editors, via the tab label for plain webview previews. The active *tab* decides this, because `activeTextEditor` keeps pointing at the last editor you used.
- **`audioCursor.readMarkdownAsProse`** (default on): Markdown is spoken as prose — headings, emphasis, bullets, task boxes, link and image syntax, tables and code fences are no longer read out literally ("hash hash Features", "star star bold star star"). Chunk offsets still track the original text, so editor highlighting is unaffected.
- The player's source card now has a **Preview** state alongside Editor and Terminal.

## [0.5.3]

### Fixed
- **`Alt+P` in a terminal read the previously selected text.** It played the watcher's cached snapshot, which could be a selection behind; it now captures the live terminal selection first — the same path as the sidebar's capture button, which is why that button worked. With nothing selected it falls back to whatever the preview is showing.
- **Terminal selections were almost never reaching the preview.** The watcher only emitted when no editor was active, but `window.activeTextEditor` keeps pointing at the most recently used editor while a terminal has focus, so the check was nearly always true. Clipboard changes are now attributed by value instead: a change equal to the editor's own selection is treated as an editor copy, anything else while a terminal is open is a terminal selection.

## [0.4.0]

### Added
- **Terminal selections now appear in the preview automatically**, exactly like editor selections: select text in a terminal and it fills the player, stops anything playing, and waits for you to press Play. VS Code exposes no terminal-selection API, so this rides on `terminal.integrated.copyOnSelection` — Audio Cursor offers to enable it once, then reads (never writes) the clipboard, and only while a terminal is the focused surface, so copying inside an editor is never mistaken for a terminal selection. Switch it off with `audioCursor.watchTerminalSelection`.
- `audioCursor.togglePlaybackTerminal`, bound to `Alt+P` in a focused terminal.

### Changed
- **`Alt+P` in the terminal now toggles play/pause instead of restarting.** It only captures a new selection when nothing is playing — the same contract `Alt+P` has in an editor.
- The player follows whichever surface you selected on last, so Play, the status bar and the sidebar button all act on the text actually shown in the preview.

## [0.3.2]

### Fixed
- `Alt+P` still did nothing in the terminal for anyone with their own `terminal.integrated.commandsToSkipShell` setting: a user value **replaces** the extension-contributed default rather than adding to it. Audio Cursor now detects that at startup, writes an explanatory warning to its log, and offers once to add itself to the list.

### Added
- Logging on every step of the terminal capture (requested / no terminal / empty selection / captured N chars), so `Audio Cursor: Show Logs` shows exactly where a terminal read stopped.
- The capture falls back to the first open terminal when no terminal is currently marked active.

## [0.3.1]

### Fixed
- **Terminal reading did not trigger at all.** `Alt+P` inside a terminal was being sent to the shell, because VS Code only handles a keybinding over the terminal when its command is listed in `terminal.integrated.commandsToSkipShell`; the extension now contributes itself to that list (VS Code merges it with its own built-in list, so nothing else changes). On Windows and Linux the terminal right-click menu never opens either — `terminal.integrated.rightClickBehavior` defaults to `copyPaste` — so the command is now also on the terminal tab's context menu.
- **Terminal text never reached the preview.** The VS Code API has no terminal-selection event, so the sidebar now has an explicit **Read terminal selection** button, shown whenever a terminal is open. It captures the selection, fills the preview, and starts reading.
- Clearer messages when a terminal has no selection or has never been focused, plus a log line for each capture.
- If your own settings override `terminal.integrated.commandsToSkipShell`, Audio Cursor offers once to add itself back so `Alt+P` works in the terminal.

## [0.3.0]

### Changed
- **Selecting text never starts playback.** A new selection updates the player preview and stops any reading in progress; playback begins only on `Alt+P`, the sidebar **Play** button, a command, or clicking a word in the preview.
- The preview now updates for every new selection (it previously only refreshed while the player was idle), and it stays pinned to the text being read during playback so word highlighting cannot drift out of sync. Switching tabs or editing the document no longer stops playback.

### Added
- **Terminal support**: read the selection in any integrated terminal with `Alt+P` (when the terminal is focused), the terminal right-click menu, or `Audio Cursor: Read Terminal Selection`. The clipboard is saved and restored around the capture.
- Any text document can now be read — output channels, diffs, notebook cells and remote documents included — instead of only `file`/`untitled` buffers.
- `Alt+Shift+P` stops playback.

### UI
- New source card showing what is queued, where it came from (Editor/Terminal), its word count and estimated listening time.
- Inline notice explaining when playback stopped because the selection changed.
- Draggable scrub thumb with a larger hit area, keyboard-hint styling, and a narrow-sidebar layout.

## [0.2.1]

### Fixed
- **Playback stopping mid-read** (`play() can only be initiated by a user gesture.`): audio now runs entirely through the Web Audio API, and the audio context is re-checked and resumed before every chunk instead of only at session start. A suspended context parks the chunk and shows the "Click to start playback" banner rather than silently failing.
- The sidebar webview now sets `retainContextWhenHidden`, so hiding or switching away from the Audio Cursor view no longer tears down the audio engine mid-playback.
- Local (system voice) `not-allowed` errors are treated as an activation request and replayed after a click, instead of ending the session.
- The activation prompt is shown once per session instead of once per blocked chunk.

## [0.1.0]

### Added
- **Core Speech Engine**: Webview-backed Web Speech API engine with `retainContextWhenHidden` support.
- **Selection & Cursor Fallback**: Smart selection capture with automatic fallback to read from cursor to EOF.
- **Synchronized Highlighting**: Real-time editor decoration highlighting the active spoken word with auto-scroll (`followCursor`).
- **Sidebar Player UI**:
  - Interactive scrub bar with elapsed and remaining time estimates.
  - Interactive text preview with clickable word seeking.
  - Sentence navigation (previous/next sentence).
  - Settings panel with voice selector, rate/pitch sliders, and live readouts.
- **Status Bar Integration**: Responsive status bar item reflecting reading progress (`%`), estimated reading duration, and play/pause control.
- **Rolling Queue Chunking**: Smart chunking respecting sentence, paragraph, and word boundaries with rolling buffer to eliminate Chromium queue stall issues.
- **Settings & Commands**: Complete VS Code settings integration, Command Palette commands, context menu contributions, and `Alt+P` keybinding.
