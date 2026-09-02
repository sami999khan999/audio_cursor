# Audio Cursor for VS Code

**Audio Cursor** brings intelligent text-to-speech reading with synchronized editor word highlighting directly into your VS Code environment.

Whether you are proofreading code comments, reviewing documentation, listening to terminal output, or listening to code aloud for accessibility, Audio Cursor lets you listen comfortably with both high-fidelity natural AI voices and offline system voices.

---

## Features

### 1. Two Convenient Surfaces
* **Status Bar Item**: Displays play/pause status, speech progress percentage (`42%`), estimated listening time, and word count. One click starts or pauses reading.
* **Activity Bar & Sidebar Player**: Full-featured player with scrub bar, interactive text preview, sentence navigation, preset speed pills (`0.8×`–`2.0×`), and voice selector with language/gender/type filter dropdowns.

### 2. Synchronized Word Highlighting
* The currently spoken word is highlighted in real-time in the active editor.
* **Follow Cursor / Auto-Scroll**: Keeps the spoken word in view without fighting manual scrolls.

### 3. Reads Any Text in VS Code — Including Terminal & Markdown
* **Code & Documents**: Select any block of text in any editor — files, untitled buffers, diffs, output channels, notebook cells, and remote documents.
* **Terminal**: Select output in an integrated terminal and press `Alt+P` or click **Read terminal selection** in the sidebar player.
* **Markdown as Prose**: Reads markdown files and preview tabs naturally without reading raw syntax symbols.
* **Cursor-to-EOF**: If nothing is selected, `Alt+P` starts reading smoothly from the cursor position to the end of the file.

### 4. 340+ Natural AI & Offline Voices
* Browse and search over 340 natural AI neural voices across dozens of languages and accents, plus all offline system voices.
* Filter by Language, Gender, and Engine Type using the compact filter dropdowns.

### 5. Interactive Text Preview & Seeking
* Click any word in the sidebar text pane or drag the scrub bar to jump playback instantly to that exact position.
* Navigate sentence-by-sentence using **Previous Sentence** (`Alt+[`) and **Next Sentence** (`Alt+]`) controls.

### 6. Customizable Speech Settings
* Adjust playback speed (`0.5x` – `2.0x`) with quick preset pills (`0.8x`, `1.0x`, `1.2x`, `1.5x`, `2.0x`) and fine-tune voice pitch.
* Native VS Code theme matching using official theme tokens (`--vscode-*`).

---

## Keyboard Shortcuts

| Shortcut | Command | When |
|---|---|---|
| `Alt+P` | Toggle Play / Pause | While focused in editor or during playback |
| `Alt+P` | Read Terminal Selection | While focused in an integrated terminal |
| `Alt+Shift+P` | Stop | While playing or paused |
| `Alt+[` | Previous Sentence | During playback |
| `Alt+]` | Next Sentence | During playback |

---

## Commands

All commands can be found in the Command Palette (`Ctrl+Shift+P` / `Cmd+Shift+P`):

* `Audio Cursor: Play/Pause` (`audioCursor.togglePlayback`)
* `Audio Cursor: Play` (`audioCursor.play`)
* `Audio Cursor: Pause` (`audioCursor.pause`)
* `Audio Cursor: Stop` (`audioCursor.stop`)
* `Audio Cursor: Read Selection` (`audioCursor.readSelection`)
* `Audio Cursor: Read Terminal Selection` (`audioCursor.readTerminalSelection`)
* `Audio Cursor: Read From Cursor` (`audioCursor.readFromCursor`)
* `Audio Cursor: Next Sentence` (`audioCursor.nextSentence`)
* `Audio Cursor: Previous Sentence` (`audioCursor.previousSentence`)
* `Audio Cursor: Select Voice` (`audioCursor.selectVoice`)
* `Audio Cursor: Speed Up` (`audioCursor.increaseRate`)
* `Audio Cursor: Slow Down` (`audioCursor.decreaseRate`)
* `Audio Cursor: Open Player` (`audioCursor.openPanel`)
* `Audio Cursor: Show Logs` (`audioCursor.showLogs`)

---

## Configuration Settings

Configure Audio Cursor via **Settings** (`Ctrl+,` / `Cmd+,`) under `audioCursor`:

| Setting | Type | Default | Description |
|---|---|---|---|
| `audioCursor.voice` | string | `""` | Preferred TTS voice name or URI (empty for system default). |
| `audioCursor.rate` | number | `1.0` | Speech rate multiplier (0.5 to 2.0). |
| `audioCursor.pitch` | number | `1.0` | Speech pitch multiplier (0.0 to 2.0). |
| `audioCursor.highlightWord` | boolean | `true` | Highlight the currently spoken word in the active editor. |
| `audioCursor.followCursor` | boolean | `true` | Automatically scroll editor to keep spoken word in viewport. |
| `audioCursor.readFromCursorWhenNoSelection` | boolean | `true` | When no text is selected, read from cursor to EOF. |
| `audioCursor.statusBar` | string | `"auto"` | Status bar visibility: `auto`, `always`, or `never`. |
| `audioCursor.autoRevealPanel` | boolean | `true` | Automatically reveal sidebar panel when playback starts. |
| `audioCursor.stopOnDocumentChange` | boolean | `false` | Stop playback if document is modified during reading. |
| `audioCursor.readMarkdownAsProse` | boolean | `true` | Speak Markdown as prose without reciting markdown syntax. |
| `audioCursor.chunkSize` | number | `300` | Target character length per speech chunk. |
| `audioCursor.queueAhead` | number | `12` | Number of chunks queued ahead in speech engine. |
| `audioCursor.sanitizeCode` | boolean | `false` | Clean up excessive code punctuation before speaking. |

---

## Architecture & Technology

Audio Cursor uses a zero-runtime-dependency architecture:
* **VS Code Extension Host**: Manages document selection snapshots, token chunking, session lifecycle, status bar updates, and editor decorations.
* **Sidebar Webview**: Runs the audio engine with real-time neural WebSocket audio streaming and Web Speech API fallback, delivering low-latency audio output with word-level boundary synchronization.
