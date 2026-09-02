<div align="center">

<img src="audio_cursor-browser-extention/src/icons/logo.svg" alt="Audio Cursor Logo" width="128" height="128">

# 🔊 Audio Cursor

**Select any text, code, or terminal output — and just listen.**

Audio Cursor turns your text selections into natural, high-performance AI speech with live word synchronization, customizable speeds, and instant seeking across your browser and code editor.

<p>
  <img alt="Voices" src="https://img.shields.io/badge/voices-340%2B_Natural_AI-38bdf8?style=for-the-badge&labelColor=161922">
  <img alt="Chrome Extension" src="https://img.shields.io/badge/Chrome_Extension-MV3-7c8cf8?style=for-the-badge&logo=googlechrome&logoColor=white&labelColor=161922">
  <img alt="VS Code Extension" src="https://img.shields.io/badge/VS_Code_Extension-1.80%2B-007acc?style=for-the-badge&logo=visualstudiocode&logoColor=white&labelColor=161922">
  <img alt="Dependencies" src="https://img.shields.io/badge/dependencies-0-4ade80?style=for-the-badge&labelColor=161922">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-9ba3b4?style=for-the-badge&labelColor=161922">
</p>

</div>

---

## 📦 Workspace Packages

This monorepo contains both official Audio Cursor client extensions:

| Package | Platform | Description | Guide |
|---|---|---|---|
| **[Browser Extension](./audio_cursor-browser-extention)** | Chrome, Edge, Brave, Chromium | Floating overlay player with caret mode (`Alt+S`), live word ticker, MP3 audio export (`Alt+D`), Google Docs & PDF support, and 340+ natural AI voices. | [Read Docs](./audio_cursor-browser-extention/README.md) |
| **[VS Code Extension](./audio_cursor-vscode-extention)** | Visual Studio Code, Cursor, VSCodium | Editor word highlighting, Activity Bar sidebar player, status bar listener, terminal output reading (`Alt+P`), Markdown prose mode, and sentence navigation. | [Read Docs](./audio_cursor-vscode-extention/README.md) |

---

## ✨ Key Features

* 🎙️ **340+ Natural AI Voices**: Neural cloud TTS across dozens of languages and accents, plus offline fallback.
* ⚡ **Live Word Synchronization**: Real-time ticker in browser and active editor word highlights in VS Code.
* 🎚️ **Scrubbable Progress & Seeking**: Drag the progress bar or click words to jump anywhere in the text.
* ⌨️ **Keyboard Accessibility**: Full hotkey control for play/pause, stop, sentence skipping, and caret navigation.
* 📟 **Terminal Output Reading**: Listen to compiler errors and console logs directly inside your IDE.
* 💾 **MP3 Audio Export**: Synthesize and download high-quality MP3 audio files in the browser extension.
* 📦 **Zero External Dependencies**: Pure plain JavaScript and native APIs for lightweight, instant execution.

---

## 🚀 Quick Start

### 1. Chrome / Browser Extension
```bash
cd audio_cursor-browser-extention
node build.js
```
1. Navigate to `chrome://extensions` in Chromium browsers.
2. Enable **Developer mode** (top right).
3. Click **Load unpacked** and select `audio_cursor-browser-extention/` (or `dist/`).

### 2. VS Code Extension
```bash
cd audio_cursor-vscode-extention
npx @vscode/vsce package
code --install-extension audio-cursor-0.7.0.vsix --force
```

---

## 📁 Repository Layout

```
audio_cursor/
├── README.md                           # Root documentation
├── audio_cursor-browser-extention/     # Chrome / Chromium extension (MV3)
│   ├── manifest.json
│   ├── build.js
│   ├── src/
│   │   ├── background/
│   │   ├── content/
│   │   ├── offscreen/
│   │   ├── popup/
│   │   └── shared/
│   └── dist/
└── audio_cursor-vscode-extention/      # Visual Studio Code extension
    ├── package.json
    ├── media/
    └── src/
        ├── extension.js
        ├── controller.js
        ├── chunker.js
        ├── decorations.js
        ├── statusBar.js
        ├── neuralEngine.js
        └── view/
```

---

## 📄 License

[MIT License](LICENSE) © 2026 Audio Cursor
