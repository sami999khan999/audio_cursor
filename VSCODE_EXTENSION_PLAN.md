# Audio Cursor for VS Code — Implementation Plan

Port of the Audio Cursor Chrome extension to a VS Code extension.

**Two surfaces:**

1. **Status bar** (bottom right) — a play/pause button that appears when text is selected.
2. **Activity bar + sidebar** — a webview panel with settings, the selected text, and full playback controls.

**One architectural idea:** the sidebar webview is *both* the UI and the speech engine. A webview is Chromium, so it has `speechSynthesis` + `utterance.onboundary` — the same event model `src/background/background.js` already consumes. The extension host owns state; the webview owns audio and rendering.

---

## Table of contents

- [0. Ground rules and decisions](#0-ground-rules-and-decisions)
- [1. Target file layout](#1-target-file-layout)
- [2. Reference: message protocol](#2-reference-message-protocol)
- [3. Reference: configuration schema](#3-reference-configuration-schema)
- [4. Reference: commands and context keys](#4-reference-commands-and-context-keys)
- [5. Reference: playback state machine](#5-reference-playback-state-machine)
- [Phase 0 — Spike](#phase-0--spike-de-risk-before-anything-else)
- [Phase 1 — Scaffold](#phase-1--scaffold)
- [Phase 2 — Selection tracking + status bar](#phase-2--selection-tracking--status-bar)
- [Phase 3 — Chunking + session](#phase-3--chunking--session)
- [Phase 4 — Speech engine](#phase-4--speech-engine-webview)
- [Phase 5 — Sidebar UI](#phase-5--sidebar-ui)
- [Phase 6 — Editor word highlight](#phase-6--editor-word-highlight)
- [Phase 7 — Settings](#phase-7--settings)
- [Phase 8 — Commands + keybindings](#phase-8--commands--keybindings)
- [Phase 9 — Edge cases + polish](#phase-9--edge-cases--polish)
- [Phase 10 — Packaging + docs](#phase-10--packaging--docs)
- [Phase 11 — Optional: native engine fallback](#phase-11--optional-native-engine-fallback)
- [Risk register](#risk-register)
- [Out of scope](#out-of-scope)

---

## 0. Ground rules and decisions

| # | Decision | Rationale |
|---|---|---|
| D1 | **Plain JavaScript, zero runtime dependencies.** Only devDeps: `@types/vscode`, `@vscode/vsce`. | Matches the Chrome extension's ethos — no bundler, no framework, no transpilation. |
| D2 | **New top-level `vscode-ext/` folder.** Nothing existing moves. | `vsce` needs its own package root. The Chrome extension keeps `manifest.json` at repo root. |
| D3 | **`chunk.js` is copied from `background.js`, not shared.** | 40 lines; the two will diverge (code-aware chunking is VS Code-only). |
| D4 | **Playback does NOT stop on deselect.** Text is snapshotted at play time. | In VS Code a single click collapses the selection — porting the Chrome behavior would stop playback constantly. |
| D5 | **No selection → read from the cursor to end of file.** | Turns a Chrome roadmap item into the natural VS Code default. |
| D6 | **Settings live in `contributes.configuration`.** The webview writes through `workspace.getConfiguration().update()`. | Free Settings UI + Settings Sync — the `chrome.storage.sync` equivalent. |
| D7 | **The caret mode (`Alt+S`) is not ported.** | A VS Code editor already *is* a keyboard text cursor. `designMode`, the edit guard, the key shield, and the focus-ring reset all disappear. |
| D8 | **The keybind recorder is not ported.** | VS Code's Keyboard Shortcuts editor already records combos and detects conflicts. |
| D9 | **The MV3 keepalive ping is not ported.** | No service-worker eviction in the extension host. |
| D10 | **Status bar, not bottom panel.** | The screenshot shows the status bar. A panel view (tab beside Terminal/Problems) is a later option if the sidebar proves awkward. |

---

## 1. Target file layout

```
vscode-ext/
├── package.json                # manifest: contributions, activation, scripts
├── .vscodeignore
├── README.md
├── CHANGELOG.md
├── LICENSE
├── jsconfig.json               # for @types/vscode intellisense
├── media/
│   ├── icon.svg                # activity-bar icon (24x24, monochrome, currentColor)
│   └── icon-128.png            # marketplace icon
└── src/
    ├── extension.js            # activate(): construct + wire everything
    ├── controller.js           # the orchestrator; owns playback state
    ├── chunk.js                # ported from src/background/background.js
    ├── session.js              # sessionId guarding, rolling chunk window
    ├── selection.js            # snapshot capture + change events
    ├── statusBar.js            # the bottom-bar item
    ├── decorations.js          # spoken-word highlight in the editor
    ├── config.js               # read/write config, change events
    ├── progress.js             # EMA interpolator (ported from content.js)
    ├── log.js                  # OutputChannel wrapper
    └── view/
        ├── provider.js         # WebviewViewProvider + message bridge
        ├── player.html         # CSP, nonce, markup
        ├── player.js           # speechSynthesis engine + UI
        └── player.css          # themed with --vscode-* vars
```

---

## 2. Reference: message protocol

All messages are `{ type, ...payload }`. Every playback-related message carries `sessionId`; the receiver drops any message whose `sessionId` is stale.

### Host → Webview

| Type | Payload | Meaning |
|---|---|---|
| `init` | `{ settings, snapshot }` | Sent on `resolveWebviewView` and after a webview reload. |
| `speak` | `{ sessionId, chunks, startIndex, voice, rate, pitch }` | Begin/resume speaking a chunk window. |
| `enqueue` | `{ sessionId, chunks }` | Top up the rolling queue. |
| `pause` | `{ sessionId }` | |
| `resume` | `{ sessionId }` | |
| `stop` | `{ sessionId }` | Cancel; clear the queue. |
| `settings` | `{ settings }` | Config changed externally (Settings UI, Sync). |
| `selection` | `{ text, wordCount, charCount, languageId, fileName }` | Preview pane update. |
| `state` | `{ status, percent }` | Host-authoritative state echo (for UI redraw after reload). |

### Webview → Host

| Type | Payload | Meaning |
|---|---|---|
| `ready` | `{}` | Webview script booted; safe to send `init`. |
| `voices` | `{ voices: [{ name, lang, default, localService }] }` | After `onvoiceschanged` settles. |
| `started` | `{ sessionId, chunkIndex }` | An utterance began. |
| `progress` | `{ sessionId, charIndex, chunkIndex }` | Word boundary. **Posted directly from `onboundary`, never batched through `requestAnimationFrame`.** |
| `chunkEnded` | `{ sessionId, chunkIndex }` | Triggers a queue top-up. |
| `ended` | `{ sessionId }` | Whole queue drained. |
| `error` | `{ sessionId, message, code }` | |
| `command` | `{ action: 'play' \| 'pause' \| 'stop' \| 'seek', charIndex? }` | User clicked a control in the webview. |
| `setSetting` | `{ key, value }` | User moved a slider / picked a voice. |

---

## 3. Reference: configuration schema

All keys under the `audioCursor.` prefix, contributed in `package.json`.

| Key | Type | Default | Notes |
|---|---|---|---|
| `voice` | string | `""` | Empty = system default. |
| `rate` | number | `1.0` | 0.5–2.0. |
| `pitch` | number | `1.0` | 0–2.0. |
| `highlightWord` | boolean | `true` | Decorate the spoken word in the editor. |
| `followCursor` | boolean | `true` | `revealRange` to keep the spoken word on screen. |
| `readFromCursorWhenNoSelection` | boolean | `true` | See D5. |
| `statusBar` | enum | `"auto"` | `auto` \| `always` \| `never`. |
| `autoRevealPanel` | boolean | `true` | Reveal the sidebar on first play so the engine exists. |
| `stopOnDocumentChange` | boolean | `false` | If false, keep speaking but drop decorations. |
| `chunkSize` | number | `300` | Characters per TTS chunk. |
| `queueAhead` | number | `12` | Chunks queued ahead of playback. |
| `sanitizeCode` | boolean | `false` | Collapse symbol runs before speaking (Phase 9). |

---

## 4. Reference: commands and context keys

### Commands

| Command id | Title | Notes |
|---|---|---|
| `audioCursor.togglePlayback` | Audio Cursor: Play/Pause | Bound to the status bar item. |
| `audioCursor.play` | Audio Cursor: Play | |
| `audioCursor.pause` | Audio Cursor: Pause | |
| `audioCursor.stop` | Audio Cursor: Stop | |
| `audioCursor.readSelection` | Audio Cursor: Read Selection | Editor context menu. |
| `audioCursor.readFromCursor` | Audio Cursor: Read From Cursor | |
| `audioCursor.nextSentence` | Audio Cursor: Next Sentence | |
| `audioCursor.previousSentence` | Audio Cursor: Previous Sentence | |
| `audioCursor.selectVoice` | Audio Cursor: Select Voice | QuickPick. |
| `audioCursor.increaseRate` | Audio Cursor: Speed Up | +0.1, clamped. |
| `audioCursor.decreaseRate` | Audio Cursor: Slow Down | −0.1, clamped. |
| `audioCursor.openPanel` | Audio Cursor: Open Panel | |
| `audioCursor.showLogs` | Audio Cursor: Show Logs | |

### Context keys (`setContext`)

| Key | When true |
|---|---|
| `audioCursor.playing` | An utterance is in flight. |
| `audioCursor.paused` | Paused mid-session. |
| `audioCursor.hasSelection` | Active editor has a non-empty selection. |

---

## 5. Reference: playback state machine

```
        play                started            pause
idle ──────────▶ starting ──────────▶ playing ────────▶ paused
 ▲                   │                 │  ▲                │
 │                   │ error           │  └────────────────┘
 │                   ▼                 │       resume
 └──────────── stopped ◀───────────────┘
      stop / ended / new session
```

Rules:

- Every transition to `starting` increments `sessionId`.
- Any message carrying a `sessionId` older than the current one is discarded silently (ported from `background.js` session guarding).
- `stop` is idempotent.
- A new `play` while `playing` or `paused` implies an internal `stop` first.

---

## Phase 0 — Spike (de-risk before anything else)

Goal: prove the webview can be the speech engine. **Do not start Phase 1 until S6 passes.** Everything is throwaway code in `spike/`.

- [ ] **S1** — Create `vscode-ext/` with a minimal `package.json` (`engines.vscode`, `main`, one command) and `spike/extension.js` that opens a `WebviewPanel`.
- [ ] **S2** — In the spike webview, call `speechSynthesis.getVoices()` and render the list. Confirm it returns non-empty (handle `onvoiceschanged` — the first call is often empty).
- [ ] **S3** — Speak a 3-paragraph string. Confirm audio comes out.
- [ ] **S4** — Log every `utterance.onboundary` event with `charIndex` and `name`. Confirm word events fire, and note which voices emit them and which don't.
- [ ] **S5** — Convert the spike to a `WebviewView` in the sidebar with `retainContextWhenHidden: true`. Start playback, then **collapse the sidebar / switch to Explorer**. Confirm: (a) audio keeps playing, (b) `onboundary` messages still reach the extension host.
- [ ] **S6** — Confirm `speechSynthesis.pause()` / `.resume()` work on this platform, and record the behavior. **Gate: if S5 fails, stop and switch to the Phase 11 native engine before building anything else.**
- [ ] **S7** — Write findings into `vscode-ext/SPIKE_NOTES.md` (voices with/without word events, hidden-webview behavior, pause reliability). Delete `spike/` afterwards.

---

## Phase 1 — Scaffold

Goal: an extension that installs, activates, and shows an empty sidebar. No audio.

### 1a. Package manifest

- [ ] **A1** — `vscode-ext/package.json`: `name`, `displayName: "Audio Cursor"`, `description`, `version: 0.1.0`, `publisher`, `engines.vscode`, `categories: ["Other", "Accessibility"]`, `main: "./src/extension.js"`.
- [ ] **A2** — Add `activationEvents: ["onStartupFinished"]` (needed so the status bar and selection listeners exist before any command runs).
- [ ] **A3** — Add `contributes.viewsContainers.activitybar`: id `audioCursor`, title `Audio Cursor`, icon `media/icon.svg`.
- [ ] **A4** — Add `contributes.views.audioCursor`: one entry, id `audioCursor.player`, name `Player`, `"type": "webview"`.
- [ ] **A5** — Create `media/icon.svg` — 24×24, single path, `fill="currentColor"`, no hardcoded color (VS Code recolors it per theme/state).
- [ ] **A6** — `jsconfig.json` with `checkJs: false`, `"types": ["vscode"]`; install `@types/vscode` and `@vscode/vsce` as devDependencies.
- [ ] **A7** — `.vscodeignore` excluding `spike/`, `.vscode/`, `jsconfig.json`, `*.md` except README/CHANGELOG.
- [ ] **A8** — `.vscode/launch.json` with an Extension Development Host config so `F5` works.

### 1b. Bootstrap code

- [ ] **A9** — `src/log.js`: create an `OutputChannel("Audio Cursor")`; export `info/warn/error`. Every module logs through this — no `console.log`.
- [ ] **A10** — `src/extension.js`: `activate(context)` logs "activated" and pushes disposables; `deactivate()` is a no-op stub.
- [ ] **A11** — `src/view/provider.js`: a `WebviewViewProvider` registered with `retainContextWhenHidden: true` and `enableScripts: true`; `localResourceRoots` limited to `src/view` and `media`.
- [ ] **A12** — `src/view/player.html` with a strict CSP meta tag (`default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'`) and a nonce generator in `provider.js`.
- [ ] **A13** — Render a "Hello" placeholder in the view. **Done when:** `F5` opens a dev host, the Audio Cursor icon appears in the activity bar, and clicking it shows the placeholder.

---

## Phase 2 — Selection tracking + status bar

Goal: the bottom-bar button appears/disappears correctly. Still no audio.

### 2a. Selection

- [ ] **B1** — `src/selection.js`: `getSnapshot(editor)` returns `{ text, uri, version, startOffset, endOffset, languageId, fileName, wordCount, charCount }` or `null`.
- [ ] **B2** — Handle the empty-selection case per D5: if `readFromCursorWhenNoSelection`, the snapshot spans cursor → end of document; mark it `{ fromCursor: true }`.
- [ ] **B3** — Subscribe to `onDidChangeTextEditorSelection` and `onDidChangeActiveTextEditor`; emit a debounced (~120 ms) `onSelectionChanged` event.
- [ ] **B4** — Ignore selection changes originating in output/debug-console/webview editors — only act on real `file`/`untitled` schemes.
- [ ] **B5** — Cache the last non-empty snapshot so pressing play still works if focus moved to the sidebar.
- [ ] **B6** — Compute `wordCount` and an estimated duration (`words / (200 * rate)` minutes) for the tooltip.

### 2b. Status bar

- [ ] **B7** — `src/statusBar.js`: create a `StatusBarItem` (`Right`, priority `100`), `command: 'audioCursor.togglePlayback'`.
- [ ] **B8** — Idle + selection present → `$(play) Read` with tooltip `340 words · ~1m 42s · Alt+P`.
- [ ] **B9** — Playing → `$(debug-pause) 42%`. Paused → `$(play) Paused 42%`. Starting → `$(loading~spin) …`.
- [ ] **B10** — Hide the item when there is no selection and nothing is playing; respect the `statusBar` enum setting (`auto`/`always`/`never`).
- [ ] **B11** — Throttle percentage updates to at most ~5/sec — the status bar re-renders on every `text` write.
- [ ] **B12** — Register `audioCursor.togglePlayback` as a stub that logs the current snapshot. **Done when:** selecting text makes the button appear with the right word count, and deselecting hides it.
- [ ] **B13** — Wire the three context keys (`playing`, `paused`, `hasSelection`) via `setContext`.

---

## Phase 3 — Chunking + session

Goal: the pure logic layer, testable without any UI.

- [ ] **C1** — Copy `chunkText()` from `src/background/background.js` into `vscode-ext/src/chunk.js`; convert to a module export. Keep the sentence → line-break → space fallback order.
- [ ] **C2** — Make `chunkSize` a parameter (default from config) instead of a hardcoded 300.
- [ ] **C3** — Each chunk carries `{ index, text, start, end }` where `start`/`end` are offsets **into the snapshot text** (not the document).
- [ ] **C4** — `src/session.js`: a `Session` class holding `{ id, snapshot, chunks, cursorChunk, cursorChar, status }`.
- [ ] **C5** — `Session.nextWindow(n)` returns the next `n` unqueued chunks and advances the queue head (the rolling-window logic from `background.js`).
- [ ] **C6** — `Session.isStale(id)` — the guard every inbound webview message runs through.
- [ ] **C7** — `Session.seekTo(charIndex)` → finds the containing chunk, resets the queue head, bumps the session id.
- [ ] **C8** — `Session.percent()` — `cursorChar / snapshot.text.length`, clamped 0–100.
- [ ] **C9** — `Session.sentenceBoundaries()` — offsets of sentence starts, for `nextSentence`/`previousSentence`.
- [ ] **C10** — `src/controller.js`: the orchestrator. Owns the current `Session`, exposes `play/pause/resume/stop/seek/nextSentence/prevSentence`, and emits `onStateChanged` + `onProgress`. Everything else (status bar, decorations, webview) subscribes; nothing talks to anything else directly.
- [ ] **C11** — Port `src/content/content.js`'s EMA progress interpolator into `src/progress.js`: track chars-per-second and mean inter-event gap; when events go quiet for `4 × gap`, interpolate; hand back on the next real event.
- [ ] **C12** — Quick sanity harness: a scratch script that chunks a long file and asserts chunk boundaries reassemble to the original string exactly.

---

## Phase 4 — Speech engine (webview)

Goal: pressing the status bar button speaks the selection.

### 4a. Webview side

- [ ] **D1** — `src/view/player.js`: on load, post `ready`.
- [ ] **D2** — Collect voices: call `getVoices()`, also listen for `onvoiceschanged`, debounce, post `voices` once settled.
- [ ] **D3** — Implement `speak(chunks, opts)`: build one `SpeechSynthesisUtterance` per chunk, set `voice`/`rate`/`pitch`, queue them via `speechSynthesis.speak()`.
- [ ] **D4** — Wire `utterance.onstart` → post `started`; `onend` → post `chunkEnded`; `onerror` → post `error`.
- [ ] **D5** — Wire `utterance.onboundary` → post `progress` with the **snapshot-global** char index (`chunk.start + event.charIndex`). Post immediately — no rAF batching (a hidden webview does not run rAF).
- [ ] **D6** — Implement `pause`/`resume`/`stop` handlers over `speechSynthesis.pause/resume/cancel`.
- [ ] **D7** — Drop any inbound message whose `sessionId` is not the webview's current one; drop outbound events from utterances belonging to a dead session.
- [ ] **D8** — Guard the known Chromium bug where `speechSynthesis` stalls on long queues: cap in-flight utterances at `queueAhead` and re-`speak()` on `chunkEnded`.

### 4b. Host side

- [ ] **D9** — `provider.js`: message bridge with a `postToWebview(msg)` that queues messages until `ready` arrives.
- [ ] **D10** — Handle webview disposal (user closed the view, or a window reload dropped the retained context): mark the engine unavailable, reset state to idle.
- [ ] **D11** — `controller.play()`: if the view has never resolved and `autoRevealPanel` is on, `executeCommand('audioCursor.player.focus')`, await `ready`, then speak.
- [ ] **D12** — If the view cannot be revealed, show a one-time `showWarningMessage` explaining the panel must be open, with an "Open Panel" action.
- [ ] **D13** — On `chunkEnded`, top up the queue via `Session.nextWindow()` and post `enqueue`.
- [ ] **D14** — On `progress`, update `Session.cursorChar` and emit `onProgress` (status bar + decorations + webview all listen).
- [ ] **D15** — On `ended`, reset to idle; clear decorations; update the status bar.
- [ ] **D16** — Implement `seek(charIndex)`: stop, `Session.seekTo`, restart from that chunk with a fresh session id. **Done when:** select a paragraph, click the status bar button, hear it read, watch the percentage climb; click again to pause.

---

## Phase 5 — Sidebar UI

Goal: the panel shows settings, the selected text, and playback — the three things the sidebar is for.

### 5a. Layout and theme

- [ ] **E1** — `player.css`: use `--vscode-foreground`, `--vscode-editor-background`, `--vscode-button-background`, `--vscode-focusBorder`, `--vscode-descriptionForeground`, `--vscode-list-hoverBackground`. **No hardcoded hex** — the panel must follow the user's theme (this replaces `src/shared/theme.css`).
- [ ] **E2** — Use `--vscode-font-family` / `--vscode-font-size` so text matches the workbench.
- [ ] **E3** — Three stacked sections in `player.html`: **Now Playing**, **Text**, **Settings**. Sections collapse; collapsed state persisted via `vscode.getState()`.
- [ ] **E4** — Handle the narrow-sidebar case (users dock it at ~180 px): controls wrap, no horizontal scroll.

### 5b. Playback controls

- [ ] **E5** — Play/pause button, stop button, prev/next sentence buttons. Codicons are not automatically available inside webviews — inline the SVG glyphs.
- [ ] **E6** — Progress bar reflecting `percent`; smooth via CSS transition, not per-frame JS.
- [ ] **E7** — Click/drag on the progress bar → post `command { action: 'seek', charIndex }`. (This is the scrub bar from the Chrome player, and the one piece of that UI worth keeping.)
- [ ] **E8** — Elapsed/remaining estimate beside the bar.
- [ ] **E9** — Disable controls when there is no snapshot; show an empty state ("Select text in the editor to begin").

### 5c. Text pane

- [ ] **E10** — Render the snapshot text with each word wrapped in a span, only for snapshots under a size threshold (e.g. 20k chars); above that, render plain text and skip per-word highlighting in the panel.
- [ ] **E11** — Highlight the current word from `progress`; scroll it into view with `block: 'center'`, throttled.
- [ ] **E12** — Click a word in the pane → seek to it.
- [ ] **E13** — Header line showing source: `fileName · languageId · 340 words`.

### 5d. Settings pane

- [ ] **E14** — Voice `<select>` populated from `voices`; shows the current value; change → `setSetting`.
- [ ] **E15** — Rate slider (0.5–2.0, step 0.1) with a live numeric readout.
- [ ] **E16** — Pitch slider (0–2.0, step 0.1) with a live readout.
- [ ] **E17** — Checkboxes for `highlightWord` and `followCursor`.
- [ ] **E18** — A "More settings…" link running `workbench.action.openSettings` filtered to `audioCursor`.
- [ ] **E19** — Persist scroll position + collapsed sections across webview reloads via `vscode.getState()` / `setState()`.

---

## Phase 6 — Editor word highlight

Goal: the word being spoken lights up in the real document — the VS Code-native replacement for the Chrome word ticker.

- [ ] **F1** — `src/decorations.js`: create a `TextEditorDecorationType` using `--vscode-editor-findMatchHighlightBackground` (theme-aware via `new ThemeColor(...)`).
- [ ] **F2** — Map a snapshot-global char index to a `Range`: `document.positionAt(snapshot.startOffset + charIndex)` → extend to the word end using `document.getWordRangeAtPosition`, falling back to the boundary event's `charLength`.
- [ ] **F3** — Apply on `onProgress`; clear on stop/end/error.
- [ ] **F4** — Guard on `document.version`: if the document changed since the snapshot, clear decorations and stop highlighting (respect `stopOnDocumentChange` for whether audio also stops).
- [ ] **F5** — Guard on identity: only decorate if the visible editor's `document.uri` matches the snapshot's `uri`.
- [ ] **F6** — `followCursor`: `revealRange(range, InCenterIfOutsideViewport)`, throttled to ~1/sec so it doesn't fight the user's scrolling.
- [ ] **F7** — Stop revealing for 5 s after any manual scroll or cursor move by the user (don't yank their viewport back).
- [ ] **F8** — Add a subtler second decoration for the current *sentence* (light background), optional behind a setting.
- [ ] **F9** — Dispose decoration types on deactivate.

---

## Phase 7 — Settings

- [ ] **G1** — Declare every key from [§3](#3-reference-configuration-schema) in `contributes.configuration` with `type`, `default`, `minimum`/`maximum`, `enum`, `markdownDescription`, and `order`.
- [ ] **G2** — `src/config.js`: typed getters with clamping (rate 0.5–2.0, pitch 0–2.0, chunkSize 100–1000, queueAhead 1–50).
- [ ] **G3** — `set(key, value)` writing with `ConfigurationTarget.Global` so it rides Settings Sync.
- [ ] **G4** — Subscribe to `onDidChangeConfiguration`, filter with `affectsConfiguration('audioCursor')`, emit a change event.
- [ ] **G5** — On change: post `settings` to the webview so the panel controls stay in sync with the Settings UI (two-way binding).
- [ ] **G6** — Rate/pitch/voice changes mid-playback: apply from the *next chunk* onward (the Web Speech API can't retune an in-flight utterance). Document this in the setting description.
- [ ] **G7** — Validate `voice` against the reported voice list on startup; if it's missing (different machine via Sync), fall back to default and log — don't error.

---

## Phase 8 — Commands + keybindings

- [ ] **H1** — Register every command in [§4](#4-reference-commands-and-context-keys) in `contributes.commands` with `category: "Audio Cursor"`.
- [ ] **H2** — Implement `togglePlayback` — the single entry point: idle → play, playing → pause, paused → resume.
- [ ] **H3** — Implement `readSelection` and `readFromCursor` (always start fresh, ignoring current state).
- [ ] **H4** — Implement `nextSentence` / `previousSentence` on top of `Session.sentenceBoundaries()`.
- [ ] **H5** — Implement `selectVoice` as a `QuickPick` grouped by language, with the current voice pre-selected and a detail line showing `lang` + local/remote.
- [ ] **H6** — Implement `increaseRate` / `decreaseRate` with a transient status-bar confirmation.
- [ ] **H7** — Implement `openPanel` and `showLogs`.
- [ ] **H8** — `contributes.keybindings`: `alt+p` → `togglePlayback` with `when: "editorTextFocus || audioCursor.playing"`. (`Alt+S` is deliberately unused — see D7.)
- [ ] **H9** — `contributes.menus.editor/context`: "Read Selection", `when: editorHasSelection`.
- [ ] **H10** — `contributes.menus.view/title` for the sidebar: stop button and a gear linking to settings, `when: view == audioCursor.player`.
- [ ] **H11** — `contributes.menus.commandPalette`: hide `pause`/`stop` when nothing is playing so the palette stays clean.

---

## Phase 9 — Edge cases + polish

- [ ] **I1** — Very large selections (a 50k-line file via read-from-cursor): confirm memory stays flat — the rolling window is what makes this cheap. Add a soft warning above ~500k chars.
- [ ] **I2** — Empty/whitespace-only selection → no-op with a status-bar hint, not an error.
- [ ] **I3** — Multi-cursor / multiple selections: concatenate the selections in document order, separated by a newline.
- [ ] **I4** — Document closed mid-playback: keep speaking from the snapshot (text is already captured), drop decorations.
- [ ] **I5** — Window reload mid-playback: the webview reboots; ensure the host resets cleanly to idle rather than showing a phantom "playing".
- [ ] **I6** — Two windows open: state is per-window, no cross-talk. Verify the status bar in window B stays idle.
- [ ] **I7** — Voice with no boundary events: verify `progress.js` interpolation drives a smooth bar, and that a real event snaps it back.
- [ ] **I8** — `error` from `speechSynthesis` (`synthesis-failed`, `audio-busy`): retry the chunk once, then stop with a `showErrorMessage` and a "Show Logs" action.
- [ ] **I9** — `sanitizeCode` (default off): collapse runs of `{}()[];=>` and long paths before speaking so code is bearable to listen to; never mutate the snapshot used for offsets — keep a parallel spoken-text mapping, or skip highlighting while active.
- [ ] **I10** — Remote/SSH and Codespaces: confirm behavior when the extension host is remote but the webview is local. (Webview speech runs client-side, so it should work — verify and document.)
- [ ] **I11** — Accessibility: `aria-label` on every control, keyboard-reachable, visible focus rings using `--vscode-focusBorder`.
- [ ] **I12** — Ensure no `console.log` remains; everything routes through `log.js`.
- [ ] **I13** — Dispose audit: every listener, decoration type, status bar item, and output channel is pushed to `context.subscriptions`.
- [ ] **I14** — Manual QA pass in a dark theme, a light theme, and one high-contrast theme.

---

## Phase 10 — Packaging + docs

- [ ] **J1** — `README.md` for the extension: what it does, the two surfaces, the keybinding, the settings table, and a note that it's a port of the Chrome extension.
- [ ] **J2** — Animated GIF or screenshots of the status bar button and the sidebar.
- [ ] **J3** — `CHANGELOG.md` with `0.1.0`.
- [ ] **J4** — `media/icon-128.png` for the marketplace listing.
- [ ] **J5** — `package.json` metadata: `repository`, `bugs`, `license`, `keywords` (tts, speech, read aloud, accessibility), `galleryBanner`.
- [ ] **J6** — `vsce package` produces a clean `.vsix`; verify `.vscodeignore` excludes the spike and dev files.
- [ ] **J7** — Install the `.vsix` into a clean VS Code profile and run the full happy path from scratch (first-ever play, panel never opened).
- [ ] **J8** — Update the root `README.md` with a "VS Code extension" section pointing at `vscode-ext/`.
- [ ] **J9** — Decide on publishing: Marketplace (needs a publisher + PAT) or a `.vsix` on GitHub Releases.

---

## Phase 11 — Optional: native engine fallback

Only needed if **S5/S6** fail, or later for headless playback with the panel never opened.

- [ ] **K1** — Extract a `SpeechEngine` interface from the webview implementation: `speak/pause/resume/stop/voices`, emitting the same events. **Build this seam during Phase 4 even if K2+ never happens** — it's cheap then and expensive later.
- [ ] **K2** — `WindowsSpeechEngine`: long-lived PowerShell process using `System.Speech.Synthesis.SpeechSynthesizer`; subscribe to `SpeakProgress` and write `{charIndex}` lines to stdout → real word events.
- [ ] **K3** — `MacSpeechEngine`: `say -v <voice> -r <wpm>`; no boundary events, so `progress.js` interpolation becomes the primary source. Pause via `SIGSTOP`/`SIGCONT`.
- [ ] **K4** — `LinuxSpeechEngine`: `spd-say` or `espeak`; detect availability at activation and degrade gracefully.
- [ ] **K5** — Voice enumeration per platform (`GetInstalledVoices()`, `say -v ?`, `spd-say -L`).
- [ ] **K6** — Engine selection setting: `auto` | `webview` | `native`.
- [ ] **K7** — Ensure child processes are killed on `deactivate()` and on window close — no orphaned speech.

---

## Risk register

| # | Risk | Impact | Mitigation | Resolved by |
|---|---|---|---|---|
| R1 | Hidden webview is suspended, killing audio | Blocks the whole design | `retainContextWhenHidden`, auto-reveal on first play, native fallback | S5 |
| R2 | `requestAnimationFrame` doesn't run when hidden, freezing progress | Status bar stalls | Post `progress` directly from `onboundary`, never batch | D5 |
| R3 | Voices that emit no word events | No word sync | Port the EMA interpolator from `content.js` | C11, I7 |
| R4 | `speechSynthesis.pause()` unreliable (notably Linux) | Pause appears broken | Fall back to stop + resume-from-word using the seek machinery | S6, D16 |
| R5 | Chromium stalls on long utterance queues | Playback dies mid-article | Cap in-flight utterances; re-queue on `chunkEnded` | D8 |
| R6 | Document edited during playback | Highlights the wrong word | Version guard; clear decorations | F4 |
| R7 | `getVoices()` empty on first call | Empty voice dropdown | Wait for `onvoiceschanged` | D2 |
| R8 | Sidebar never opened → engine doesn't exist | Status bar button silently fails | Auto-reveal + explicit warning with an action | D11, D12 |
| R9 | Remote/SSH host + local webview mismatch | Unknown behavior | Test explicitly | I10 |

---

## Out of scope

Deliberately not ported, with the reason:

- **Caret mode / `designMode` / edit guard / key shield / focus-ring reset** — the editor is already a keyboard text cursor (D7).
- **The keybind recorder** — VS Code's Keyboard Shortcuts editor does this natively (D8).
- **The MV3 keepalive ping** — no service-worker eviction (D9).
- **The draggable, edge-snapping floating player** — VS Code has no injectable DOM over the editor. The sidebar panel is the replacement; the scrub bar survives inside it (E7).
- **The popup HTML/CSS** — replaced by contributed configuration (D6).
- **Reading non-editor UI** (hovers, tree views, notifications) — no DOM access to the workbench.
