<div align="center">

# 🔊 Audio Cursor

**Select any text on any page — and just listen.**

A zero-dependency Chrome extension that turns your text selection into speech, with a draggable floating player, live word-by-word syncing, and a scrubbable progress bar.

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

```
  ┌──────────────────────────────────────────────┐
  │  ▶   …turns your text into speech, live   42%│
  │  ━━━━━━━━━━━━━━━━━━●───────────────────────  │
  └──────────────────────────────────────────────┘
        drag me anywhere · click the bar to seek
```

---

## 🎯 Features

| | |
|---|---|
| 🖱️ **Select-to-play** | Highlight text and the player appears. Deselect and playback stops automatically. |
| 🎞️ **Live word ticker** | A sliding strip highlights the exact word being spoken, anchored at 35% of the view. |
| 🎚️ **Scrub to seek** | Drag the progress bar to jump anywhere in the text — playback restarts from that word. |
| 🧲 **Draggable + edge snap** | Move the player anywhere; release and it springs to the nearest screen edge. |
| ⌨️ **Recordable hotkey** | Press your own key combo to play/pause. Default `Alt+P`, remappable from the popup. |
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
| **Play / pause** | `Alt+P` (or your own binding), or click the button |
| **Seek** | Drag anywhere along the progress bar |
| **Move the player** | Drag it — a move over 4px is a drag, anything less is a click |
| **Stop** | Click elsewhere to clear the selection |
| **Change voice / speed / pitch** | Click the toolbar icon |
| **Remap the hotkey** | Popup → click the key chip → press your combo (`Esc` cancels) |

The hotkey is ignored while you're typing in an input, textarea, or contenteditable field.

---

## ⚙️ Settings

All settings live in `chrome.storage.sync`, so they follow your Chrome profile:

| Key | Type | Default | |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Master on/off switch |
| `voice` | `string` | `"default"` | Chrome TTS voice name |
| `rate` | `number` | `1.0` | Speech speed, 0.5–2.0 |
| `pitch` | `number` | `1.0` | Voice pitch, 0–2.0 |
| `keybinds` | `object` | `{ togglePlayback: "Alt+P" }` | User-recorded shortcuts |

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
│   │   ├── content.js         # floating player, ticker, scrub, drag
│   │   └── content.css        # player styles
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
- [ ] Chrome Web Store listing

---

<div align="center">

Built with plain JavaScript and no build dependencies. 🎧

</div>
