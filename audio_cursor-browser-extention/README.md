<div align="center">

<img src="src/icons/logo.svg" alt="Audio Cursor Logo" width="128" height="128">

# 🔊 Audio Cursor

**Select any text on any page — and just listen.**

A high-performance Chrome extension that turns your text selection into natural AI speech, with a draggable floating player, live word-by-word syncing, a scrubbable progress bar, offline and neural cloud voices, MP3 export, and a keyboard text cursor for pages that fight your mouse.

<p>
  <img alt="Manifest V3" src="https://img.shields.io/badge/Manifest-V3-7c8cf8?style=for-the-badge&labelColor=161922">
  <img alt="Version" src="https://img.shields.io/badge/version-2.0.0-98a5ff?style=for-the-badge&labelColor=161922">
  <img alt="Voices" src="https://img.shields.io/badge/voices-340%2B-38bdf8?style=for-the-badge&labelColor=161922">
  <img alt="Dependencies" src="https://img.shields.io/badge/dependencies-0-4ade80?style=for-the-badge&labelColor=161922">
  <img alt="Chrome" src="https://img.shields.io/badge/Chrome-88%2B-9ba3b4?style=for-the-badge&labelColor=161922">
</p>

</div>

---

## ✨ What it does

Highlight a paragraph, a page, or a whole article. A compact floating player fades in at the corner of the screen and reads it out loud in natural, fluent voice — while a ticker slides the words past in time with the speech.

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
| 🌐 **340+ Natural AI Voices** | Access neural cloud voices across dozens of languages and accents, plus all offline system voices and Chrome's own built-in voices (including the bundled “Google …” ones). |
| ⚡ **Auto-play on select** | Hold `Ctrl+Alt` while selecting text to automatically start playing it instantly. |
| 💾 **Download MP3** | Press `Alt+D` or click export to synthesize and download selected text as high-quality MP3 audio. |
| 📋 **Read Clipboard** | Quick action in the popup to read copied text from your clipboard immediately. |
| 📄 **Google Docs & PDFs** | Full compatibility with Google Docs (canvas & text layers) and PDF documents. |
| 🔁 **Repeat playback** | Loop audio continuously when playback finishes. |
| 🎞️ **Live word ticker** | A sliding strip highlights the exact word being spoken in real-time. |
| 🎚️ **Scrub to seek** | Drag the progress bar to jump anywhere in the text — playback restarts smoothly from that word. |
| 🧲 **Draggable + edge snap** | Move the player anywhere; release and it springs to the nearest screen edge. |
| ⌨️ **Keyboard shortcuts** | Rebindable hotkeys for playback (`Alt+P`), MP3 download (`Alt+D`), text cursor (`Alt+S`), and auto-play on select (`Ctrl+Alt`) — open the popup's **Shortcuts** tab, click a shortcut and press the keys you want. |
| ✍️ **Text cursor** | `Alt+S` drops a real blinking caret into the page. Arrows move, `Shift` selects, `Ctrl+C` copies — any page reads like a text editor. |
| 📚 **Handles huge selections** | Text is split into sentence-aligned chunks and streamed through an offscreen document queue, so long articles never cut off. |
| 🎨 **Modern dark UI** | Clean matte dark popup with custom sliders, preset speed pills (`0.8×`–`2.0×`), pitch tuning, and voice library browser. |
| 📦 **No dependencies** | Pure plain JavaScript + a fast lightweight concatenation build script. |

---

## 🚀 Install

Audio Cursor can be loaded directly as an unpacked extension:

```bash
git clone https://github.com/sami999khan999/audio_cursor.git audio-cursor
cd audio-cursor
node build.js          # bundles src/ → dist/
```

1. Open `chrome://extensions` in your browser.
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked** and select the project folder.
4. Pin **Audio Cursor** to your toolbar 📌.

> `dist/` is committed, so you can skip the build step if you only want to try it.

---

## 🎧 Usage

| Action | Shortcut / Method |
|---|---|
| **Start listening** | Select text → click ▶ on the floating player, or press `Alt+P` |
| **Download MP3 audio** | Press `Alt+D` while text is selected |
| **Auto-play selection** | Select text while holding `Ctrl+Alt` (rebindable in the popup's Shortcuts tab) |
| **Play / pause** | `Alt+P` or click the player button |
| **Repeat / loop** | Toggle "Repeat playback" in popup settings |
| **Seek** | Drag anywhere along the progress bar |
| **Move the player** | Drag the floating player — it snaps to the nearest edge |
| **Stop** | Click elsewhere to clear the selection |
| **Text cursor on / off** | `Alt+S` — drops a real caret into the page |
| **Move the caret** | Click any text, or use `↑ ↓ ← →` |
| **Select by keyboard** | `Shift` + arrows, or `Ctrl+Shift` + arrows for whole words |
| **Change voice / settings** | Click the toolbar icon to open popup |
| **Configure shortcuts** | Go to `chrome://extensions/shortcuts` |

---

## ⚙️ Settings

Settings are synced to your Chrome profile with `chrome.storage.sync`:

| Key | Type | Default | Description |
|---|---|---|---|
| `enabled` | `boolean` | `true` | Master on/off switch |
| `voice` | `string` | `"en-US-JennyNeural"` | Selected voice identifier |
| `voiceEngine` | `string` | `"neural"` | Engine that speaks it: `neural`, `webspeech` (Chrome's own voices), or `local` |
| `voiceLang` | `string` | `"en-US"` | BCP-47 tag of the selected voice, used to pick a cloud voice for MP3 export |
| `rate` | `number` | `1.0` | Speech rate (0.5×–2.0×) |
| `pitch` | `number` | `1.0` | Voice pitch (0.5–1.5) |
| `repeat` | `boolean` | `false` | Loop playback continuously |

---

## 🏗️ Architecture

```
┌─────────────────┐       PLAY_TEXT / PAUSE / RESUME / STOP       ┌────────────────────────┐
│  content.js     │ ────────────────────────────────────────────▶ │   background.js        │
│                 │                                               │  (service worker)      │
│  • selection    │ ◀──────────────────────────────────────────── │                        │
│  • floating UI  │           TTS_STATUS · TTS_PROGRESS           │  • chunkText()         │
│  • word ticker  │                                               │  • rolling queue       │
│  • scrub / drag │                                               │  • session guarding    │
└─────────────────┘                                               └───────────┬────────────┘
                                                                              │
                                                     OFFSCREEN_SYNTH          ▼
                                                   ┌───────────────────────────────────────┐
                                                   │  offscreen.js (Edge Neural & Cloud)   │
                                                   │  • WebSocket streaming                │
                                                   │  • MP3 audio blob generation          │
                                                   │  • fallback to chrome.tts             │
                                                   └───────────────────────────────────────┘
```

* **Chunking Pipeline**: Long selections are split into sentence-aligned chunks (~300 characters), queued dynamically, and streamed smoothly without cutting off or memory bloat.
* **Offscreen Document**: Synthesis connects to high-fidelity neural audio streams via an offscreen document, bypassing service worker lifecycle and connection limits.
* **Session Guarding**: Incrementing session IDs prevent race conditions and double audio when jumping or seeking mid-speech.
* **Progress Interpolation**: Smooth real-time position tracking and estimation ensure jitter-free word tracking across all voice engines.

---

## 📁 Project Structure

```
audio_cursor/
├── manifest.json              # MV3 extension manifest
├── build.js                   # Lightweight zero-dependency bundler
├── rules.json                 # DeclarativeNetRequest rules
├── src/
│   ├── background/
│   │   └── background.js      # Background service worker & orchestration
│   ├── content/
│   │   ├── content.js         # Floating player, ticker, caret mode, scrub
│   │   ├── content.css        # Floating player styles & caret reset
│   │   └── docs-bridge.js     # Google Docs selection bridge
│   ├── icons/
│   │   ├── icon.svg           # Scalable vector icon
│   │   ├── logo.svg           # High-resolution vector logo
│   │   ├── icon16.png         # Toolbar 16x16 icon
│   │   ├── icon32.png         # Toolbar 32x32 icon
│   │   ├── icon48.png         # Extensions 48x48 icon
│   │   └── icon128.png        # Web Store 128x128 icon
│   ├── offscreen/
│   │   ├── offscreen.html     # Offscreen audio synthesis document
│   │   └── offscreen.js       # WebSocket neural audio client + Web Speech playback
│   ├── popup/
│   │   ├── popup.html         # Settings popup UI
│   │   ├── popup.js           # Voice library, sliders, shortcuts
│   │   └── popup.css          # Clean matte dark theme styles
│   └── shared/
│       ├── chunk.js           # Text chunking logic
│       ├── cloudTts.js        # Cloud synthesis & MP3 download
│       ├── edgeTts.js         # Neural TTS client
│       ├── webSpeech.js       # Chrome's built-in speechSynthesis voices
│       ├── theme.css          # Shared design tokens
│       └── voices.json        # 340+ voice catalog
└── dist/                      # Bundled build output loaded by Chrome
```

---

## 🔐 Permissions

| Permission | Why |
|---|---|
| `storage` | Save voice, rate, pitch, and playback preferences |
| `tts` | Synthesize speech using offline system voices |
| `offscreen` | Host neural TTS WebSocket connections, Chrome voice playback, and audio output |
| `declarativeNetRequest` | Secure synthesis request headers |
| `downloads` | Save exported MP3 audio files directly to your machine |
| `clipboardRead` | Read copied text when using the clipboard reader action |
| `<all_urls>` | Inject the floating player on web pages where text is selected |

---

## 🗺️ Roadmap

- [x] Extension icons (`src/icons/` + `manifest.icons`)
- [x] 340+ Neural AI Cloud voices library
- [x] Export selection to MP3 audio
- [x] Google Docs & PDF support
- [ ] Light theme via `prefers-color-scheme`
- [ ] Right-click "Read selection" context menu
- [ ] Per-site enable/disable
- [ ] Chrome Web Store listing

---

<div align="center">

Built with plain JavaScript and zero runtime dependencies. 🎧

</div>
