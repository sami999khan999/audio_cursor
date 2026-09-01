<div align="center">

# 🔊 Audio Cursor

**Select any text on any page — and just listen.**

A zero-dependency Chrome extension that turns your text selection into speech, with a draggable floating player, live word-by-word syncing, a scrubbable progress bar — and a keyboard text cursor for pages that fight your mouse.

<p>
  <img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-7c8cf8?style=for-the-badge&labelColor=161922">
  <img alt="Version" src="https://img.shields.io/badge/version-2.0.0-98a5ff?style=for-the-badge&labelColor=161922">
  <img alt="Dependencies" src="https://img.shields.io/badge/dependencies-0-4ade80?style=for-the-badge&labelColor=161922">
  <img alt="Chrome" src="https://img.shields.io/badge/Chrome-88%2B-9ba3b4?style=for-the-badge&labelColor=161922">
</p>

</div>

---

## ✨ What it does

Highlight a paragraph, a page, or a whole article. A compact player fades in at the corner of the screen and reads it out loud — while a ticker slides the words past in time with the voice.

And when a page won't let you select cleanly, `Alt+S` drops a real caret into it and you select with the keyboard instead.

```
  ┌──────────────────────────────────────────────┐
  │  ▶   …turns your text into speech, live   42%│
  │  ━━━━━━━━━━━━━━━━━━●───────────────────────  │
  └──────────────────────────────────────────────┘
        drag me anywhere · click the bar to seek

  ╭────────────────────────────────────────────────────╮
  │ ● Text cursor │ ↑↓←→ move  Shift select  Alt+S off │
  ╰────────────────────────────────────────────────────╯
        the hint bar, top-centre, fades on its own
```

---

## 🎯 Features

| | |
|---|---|
| 🖱️ **Select-to-play** | Highlight text and the player appears. Deselect and playback stops automatically. |
| ⚡ **Auto-play on select** | Hold `Ctrl+Alt` while selecting text to automatically start playing it instantly. Remappable from popup settings. |
| 🔁 **Repeat playback** | Optional repeat mode to loop audio continuously when playback finishes. |
| 🎞️ **Live word ticker** | A sliding strip highlights the exact word being spoken, anchored at 35% of the view. |
| 🎚️ **Scrub to seek** | Drag the progress bar to jump anywhere in the text — playback restarts from that word. |
| 🧲 **Draggable + edge snap** | Move the player anywhere; release and it springs to the nearest screen edge. |
| ⌨️ **Recordable hotkeys** | Press your own key combos for play/pause, text cursor, and auto-play selection. Remappable from the popup. |
| ✍️ **Text cursor** | `Alt+S` drops a real blinking caret into the page. Arrows move, `Shift` selects, `Ctrl+C` copies — any page reads like a text editor, without editing it. |
| 📚 **Handles huge selections** | Text is split into sentence-aligned chunks and streamed to the TTS queue, so entire articles play without cutting off. |
| 🗣️ **Any system voice** | Pick from every voice Chrome exposes, with speed (0.5×–2.0×) and pitch controls. |
| 🧠 **Smart progress fallback** | Voices that don't emit word events still get a smooth bar — the pace is measured live and estimated between events. |
| 🎨 **Modern dark UI** | Glassy surfaces, springy motion, and a single shared token palette. |
| 📦 **No dependencies** | No npm packages, no bundler, no framework. Plain JS + a 40-line build script. |

---

## 🚀 Install

Audio Cursor isn't on the Web Store — load it unpacked:

```bash
git clone <your-repo-url> audio-cursor
cd audio-cursor
node build.js          # bundles src/ → dist/
```

1. Open `chrome://extensions`
2. Toggle **Developer mode** on (top right)
3. Click **Load unpacked** and pick the project folder
4. Pin **Audio Cursor** to your toolbar 📌

> `dist/` is committed, so you can skip the build step if you only want to try it.

---

## 🎧 Usage

| Action | How |
|---|---|
| **Start listening** | Select text → click ▶ on the floating player |
| **Auto-play selection** | Select text while holding `Ctrl+Alt` (or your mapped key) |
| **Play / pause** | `Alt+P` (or your own binding), or click the button |
| **Repeat / loop** | Toggle "Repeat playback" in popup settings |
| **Seek** | Drag anywhere along the progress bar |
| **Move the player** | Drag it — a move over 4px is a drag, anything less is a click |
| **Stop** | Click elsewhere to clear the selection |
| **Text cursor on / off** | `Alt+S` — a hint bar confirms the mode, then fades |
| **Move the caret** | Click any text, or use `↑ ↓ ← →` |
| **Select by keyboard** | `Shift` + arrows, or `Ctrl+Shift` + arrows for whole words |
| **Change voice / speed / pitch** | Click the toolbar icon |
| **Remap a hotkey** | Popup → click the key chip → press your combo (`Esc` cancels) |

Hotkeys are ignored while you're typing in an input, textarea, or contenteditable field.

**About the text cursor.** It's the browser's own caret, switched on with `designMode` — so arrow keys, `Shift` selection, and `Ctrl+C` all behave exactly as they do in a text editor. Edits can't land: `beforeinput`, `paste`, `cut`, and `drop` are cancelled on everything except the page's real form fields, which keep working normally. Clicking a link or a button steps out of the mode for that click and comes straight back on the next press on text. Pages that refuse `designMode` say so in the hint bar instead of failing silently.

---

## ⚙️ Settings

All settings live in `chrome.storage.sync`, so they follow your Chrome profile:

| Key | Type | Default | |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Master on/off switch |
| `voice` | `string` | `"default"` | Chrome TTS voice name |
| `rate` | `number` | `1.0` | Speech speed, 0.5–2.0 |
| `pitch` | `number` | `1.0` | Voice pitch, 0–2.0 |
| `repeat` | `boolean` | `false` | Loop playback continuously |
| `keybinds` | `object` | `{ togglePlayback: "Alt+P", keyboardSelect: "Alt+S", autoPlaySelect: "Ctrl+Alt" }` | User-recorded shortcuts |

Recording a combo that's already taken clears it from the other action, so two shortcuts can never collide.

---

## 🏗️ How it works

```
┌─────────────────┐   PLAY_TEXT / PAUSE / RESUME / STOP   ┌──────────────────────┐
│  content.js     │ ───────────────────────────────────▶  │   background.js      │
│                 │                                        │  (service worker)    │
│  • selection    │ ◀───────────────────────────────────  │                      │
│  • floating UI  │   TTS_STATUS · TTS_PROGRESS            │  • chunkText()       │
│  • word ticker  │                                        │  • rolling TTS queue │
│  • scrub / drag │                                        │  • session guarding  │
└─────────────────┘                                        └──────────┬───────────┘
                                                                      │
                                                              chrome.tts ▼
```

**The chunking pipeline.** Many TTS voices silently truncate long utterances, so the background worker slices text into ~300-character pieces, preferring sentence ends (`. ! ?`), then line breaks, then any space. Only 12 chunks are queued ahead of playback and the queue is topped up on every `start` event — so a 50,000-word selection costs the same memory as a sentence.

**Session guarding.** Every playback gets an incrementing `sessionId`. Stale TTS callbacks from a cancelled session compare their id and bail out, which is what keeps seeking mid-playback from producing double audio.

**Progress that never stutters.** Word events are the source of truth, but not every voice emits them. The content script keeps an EMA of the observed chars-per-second and the gap between real events; when events go quiet for longer than `4 × the usual gap`, an interpolator takes over at the measured pace — and hands control straight back the moment a real event lands.

**Rendering.** All UI writes are batched into a single `requestAnimationFrame`, and the ticker only renders a 28-word window around the current word, re-windowing when the cursor drifts near the edge.

**The text cursor.** Two flags, not one: `caretEnabled` is the `Alt+S` switch, `caretMode` is whether `designMode` is on right now. Clicking a link or a control drops `designMode` for that click — an editing host swallows those events otherwise — while the feature stays on, so the caret returns on the next press on text. Two shields run while it's up: an edit guard cancels `beforeinput` / `paste` / `cut` / `drop` / `dragstart`, and a key shield `stopImmediatePropagation()`s `selectstart`, `copy`, and `keypress` in the capture phase, because sites bind their own handlers to arrows and `Ctrl+A` and often cancel `selectstart` outright. Both step aside for the page's real inputs.

**Hiding focus rings.** A caret parked in ordinary prose is still focus, and pages ring whatever holds it. `outline: none` only covers the browser's own ring, so `html.ac-caret-mode` also zeroes `box-shadow` and `border-color` on `:focus`, `:focus-visible`, and `:focus-within` — with `:not()` carve-outs so the player and the hint bar keep theirs. The reset lives and dies with the mode class.

**Keeping the worker alive.** MV3 service workers idle out after 30s. The content script pings `KEEPALIVE` every 15 seconds during playback — the message itself is the point; the handler is a deliberate no-op.

---

## 📁 Project structure

```
audio_cursor-chrome-ext/
├── manifest.json              # MV3 manifest — points at dist/
├── build.js                   # dependency-free concat bundler
├── src/
│   ├── background/
│   │   └── background.js      # TTS engine: chunking, queue, sessions
│   ├── content/
│   │   ├── content.js         # floating player, ticker, scrub, drag, caret mode
│   │   └── content.css        # player, caret mode, hint bar
│   ├── popup/
│   │   ├── popup.html         # settings UI
│   │   ├── popup.js           # voices, sliders, keybind recorder
│   │   └── popup.css
│   └── shared/
│       └── theme.css          # design tokens (colors, radii, shadows)
└── dist/                      # build output — loaded by the extension
    ├── background.js
    ├── content.js
    └── content.css            # theme.css + content.css, bundled
```

### Building

```bash
node build.js
```

The build simply concatenates source files into `dist/` with provenance headers — no minification, no transpilation, nothing to install. Edit anything under `src/`, re-run it, then hit **Reload** on `chrome://extensions`.

> ⚠️ Never edit `dist/` directly — the next build overwrites it.

### Debugging the text cursor

```js
localStorage.setItem('audioCursorDebug', '1');   // then reload the page
```

Every click then logs why it did or didn't produce a caret — which element it stepped aside for, whether `designMode` took, and where the caret landed.

---

## 🎨 Design tokens

The whole UI is driven by one variable set in `src/shared/theme.css`:

```css
--ac-bg: #0f1116;        --ac-accent: #7c8cf8;
--ac-surface: #161922;   --ac-accent-strong: #98a5ff;
--ac-text: #edeff4;      --ac-text-muted: #9ba3b4;
```

Change the accent there and both the popup and the in-page player follow.

---

## 🔐 Permissions

| Permission | Why |
|---|---|
| `tts` | Speak the selected text |
| `storage` | Persist voice, speed, pitch, and keybinds across devices |
| `<all_urls>` | Inject the player on any page you select text on |

Nothing is sent anywhere. There's no network code in this extension — speech is synthesized by the voices already installed on your machine.

---

## 🗺️ Roadmap

- [ ] Extension icons (`icons/` + `manifest.icons`)
- [ ] Light theme via `prefers-color-scheme`
- [ ] Right-click "Read selection" context menu
- [ ] Per-site enable/disable
- [ ] Skip forward/back by sentence
- [ ] Read from the caret, without selecting first
- [ ] Chrome Web Store listing

---

<div align="center">

Built with plain JavaScript and no build dependencies. 🎧

</div>
