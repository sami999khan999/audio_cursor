# Change Log

All notable changes to the "audio-cursor" extension will be documented in this file.

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
