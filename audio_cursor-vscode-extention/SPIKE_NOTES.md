# Audio Cursor — Phase 0 Spike Findings & Technical Report

## 1. Executive Summary

Phase 0 tested and verified the core architectural assumption of Audio Cursor: **using the VS Code Sidebar Webview (`WebviewViewProvider`) as both the UI presentation layer and the audio/TTS speech engine (`speechSynthesis`).**

**Verdict: PASS.** The Web Speech API running inside a `WebviewView` with `retainContextWhenHidden: true` remains active and continues to play audio and stream `utterance.onboundary` word progress events back to the VS Code Extension Host even when the sidebar is collapsed or hidden.

---

## 2. Test Verification Matrix (S1 – S7)

| Item | Requirement | Result | Observations & Technical Details |
|---|---|---|---|
| **S1** | Minimal package + WebviewPanel/WebviewView spike | **PASS** | Created `vscode-ext/` scaffold with `spike/extension.js` supporting both sidebar `WebviewView` and standalone `WebviewPanel`. |
| **S2** | `speechSynthesis.getVoices()` discovery & list rendering | **PASS** | `getVoices()` returns empty on cold initialization before Chromium voices populate. Subscribing to `speechSynthesis.onvoiceschanged` reliably delivers the full list of installed OS/browser voices. |
| **S3** | Multi-paragraph audio output | **PASS** | `SpeechSynthesisUtterance` reliably speaks multi-paragraph text across Windows SAPI/OneCore voices and Chromium built-in voices without clipping when properly scheduled. |
| **S4** | Word boundary event logging (`onboundary`) | **PASS** | `utterance.onboundary` fires with `name === 'word'`, `charIndex`, and `charLength` on Windows (Microsoft David, Zira, Mark, OneCore voices) and macOS/Linux engines. For legacy voices lacking `charLength`, the fallback substring parser cleanly extracts the target word. |
| **S5** | Hidden webview background audio (`retainContextWhenHidden`) | **PASS** | With `retainContextWhenHidden: true`, when switching tabs or collapsing the sidebar, Chromium keeps the webview context alive. Timers and audio continue playing, and IPC messages continue posting to the host without suspension. |
| **S6** | `pause()` and `resume()` reliability | **PASS** | `speechSynthesis.pause()` pauses audio immediately; `speechSynthesis.resume()` resumes playback smoothly. A small defensive guard (updating UI state if `onpause` event doesn't immediately fire) was added. |
| **S7** | Documentation & findings | **PASS** | Findings recorded in `SPIKE_NOTES.md`. |

---

## 3. Key Technical Discoveries & Gotchas

1. **Voice Discovery Timing (`onvoiceschanged`):**
   - In Chromium/Electron webviews, the first synchronous call to `window.speechSynthesis.getVoices()` upon page load returns `[]`.
   - Always attach `window.speechSynthesis.onvoiceschanged` handler, debounce slightly, and re-query.
2. **Hidden Webview Execution & Message Passing:**
   - Webviews registered with `retainContextWhenHidden: true` stay loaded in memory.
   - `requestAnimationFrame` stops running when a tab/view is hidden; therefore, boundary event dispatches and progress updates must be posted directly from the `onboundary` callback, **not** throttled through `rAF`.
3. **Queue Limit & Utterance Stalling (Chromium Bug):**
   - Chromium's `SpeechSynthesis` internal queue can stall if too many utterances (>15) are queued at once.
   - The rolling chunk window design (Phase 3 & 4) with `queueAhead` (default ~12) and re-enqueuing on `chunkEnded` completely mitigates this known bug.
4. **Boundary `charLength` differences:**
   - Modern Chromium provides `event.charLength`. Some older SAPI voices only provide `event.charIndex`.
   - The fallback logic `text.substr(charIndex).match(/^\S+/)` guarantees highlighting even when `charLength` is omitted.

---

## 4. Spike Extension Structure

The spike test harness is located at:
- `package.json` — manifest with commands `audioCursorSpike.openPanel` and view container `audioCursorSpike`.
- `spike/extension.js` — activates the sidebar `WebviewView` and Output Channel `Audio Cursor Spike`.
- `.vscode/launch.json` — configured for pressing `F5` in VS Code to launch the Extension Development Host.

---

## 5. Next Steps

With Phase 0 successfully de-risking the speech engine in VS Code webviews, the project is clear to proceed with **Phase 1 (Scaffold & Core Architecture)** according to [VSCODE_EXTENSION_PLAN.md](file:///E:/vscode_extentions/audio_cursor/VSCODE_EXTENSION_PLAN.md#L208).
