// Audio Cursor — Offscreen Document
// Owns Edge Neural TTS synthesis, MP3 playback, and Chrome's own Web Speech
// voices (window.speechSynthesis), which the background service worker cannot
// reach because speechSynthesis only exists in a document context.
//
// Every chunked-playback message carries an `engine`: 'neural' (synthesize an
// MP3 through Edge TTS, then play it) or 'webspeech' (hand the text to Chrome's
// speechSynthesis). Both report progress and completion the same way, so the
// background worker drives them with one code path.
//
// Synthesis must happen here rather than in the background service worker:
// Chromium does not apply declarativeNetRequest header rules to WebSocket
// upgrade requests initiated from a service worker (crbug.com/1285664), so the
// Origin/User-Agent spoofing in rules.json is silently skipped there and
// speech.platform.bing.com answers the handshake with 403. From a document
// context the rules apply normally.
//
// Protocol (messages from background):
//   { type: 'AC_SYNTH_PLAY',   sessionId, chunkIndex, isLast, engine, text, voice, rate, pitch }
//   { type: 'AC_PREFETCH',     sessionId, chunkIndex, engine, text, voice, rate, pitch }
//   { type: 'AC_PAUSE'  }
//   { type: 'AC_RESUME' }
//   { type: 'AC_STOP'   }
//   { type: 'AC_PREVIEW',      engine, text, voice, rate, pitch }
//   { type: 'AC_PREVIEW_STOP' }
//
// Protocol (messages to background):
//   { type: 'AC_CHUNK_STARTED',  sessionId, chunkIndex }
//   { type: 'AC_CHUNK_PROGRESS', sessionId, chunkIndex, fraction }
//   { type: 'AC_CHUNK_ENDED',    sessionId, chunkIndex, isLast }
//   { type: 'AC_CHUNK_ERROR',    sessionId, chunkIndex, error, fatal }
//   { type: 'AC_PREVIEW_STARTED' }
//   { type: 'AC_PREVIEW_ENDED' }
//   { type: 'AC_PREVIEW_ERROR',  error }

let currentAudio = null;
let currentAudioUrl = null;
let currentSessionId = -1;
let currentEngine = 'neural';
let currentChunkIndex = 0;

// Set by AC_PAUSE, cleared by AC_RESUME or by a new AC_SYNTH_PLAY. A pause that
// lands while a chunk is still being synthesized has no audio element to act on
// yet, so it is remembered here and honoured when the audio finally arrives.
let pausedState = false;

let previewAudio = null;
let previewAudioUrl = null;
let previewToken = 0;

// speechSynthesis is a single global queue shared by page playback and voice
// previews, so remember which of the two is using it. Without this, closing the
// voice picker would silence a page that is mid-read with a Chrome voice.
let webSpeechOwner = null; // 'playback' | 'preview' | null

function cancelWebSpeech(owner) {
    if (typeof WebSpeech === 'undefined') return;
    if (webSpeechOwner !== owner) return;
    webSpeechOwner = null;
    WebSpeech.cancel();
}

// `${sessionId}:${chunkIndex}` -> Promise<base64>
const audioCache = new Map();

function cacheKey(sessionId, chunkIndex) {
    return `${sessionId}:${chunkIndex}`;
}

function post(msg) {
    chrome.runtime.sendMessage(msg, () => void chrome.runtime.lastError);
}

// ── Synthesis ─────────────────────────────────────────────────────────────────

async function synthesizeWithRetry(text, voice, rate, pitch, retries = 2) {
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const { base64 } = await EdgeTTS.synthesize(text, voice, rate, pitch);
            if (!base64) throw new Error('Edge TTS returned no audio');
            return base64;
        } catch (err) {
            lastErr = err;
            if (attempt < retries) {
                await new Promise((resolve) => setTimeout(resolve, 250));
            }
        }
    }
    throw lastErr;
}

function getOrSynthesize(sessionId, chunkIndex, text, voice, rate, pitch) {
    const key = cacheKey(sessionId, chunkIndex);
    let pending = audioCache.get(key);
    if (!pending) {
        pending = synthesizeWithRetry(text, voice, rate, pitch);
        audioCache.set(key, pending);
        // Keep a rejected entry from poisoning a later retry of the same chunk.
        pending.catch(() => {
            if (audioCache.get(key) === pending) audioCache.delete(key);
        });
    }
    return pending;
}

// ── Playback ──────────────────────────────────────────────────────────────────

// Detach handlers before tearing an element down. Clearing the source makes the
// element try to load an empty resource, which fires a spurious `error` event —
// if the handlers were still attached that would be reported as a real failure.
function releaseAudio(audio) {
    if (!audio) return;
    audio.onplaying = null;
    audio.ontimeupdate = null;
    audio.onended = null;
    audio.onerror = null;
    try { audio.pause(); } catch (_) {}
    audio.removeAttribute('src');
    try { audio.load(); } catch (_) {}
}

function stopCurrent() {
    releaseAudio(currentAudio);
    currentAudio = null;
    if (currentAudioUrl) {
        try { URL.revokeObjectURL(currentAudioUrl); } catch (_) {}
        currentAudioUrl = null;
    }
    cancelWebSpeech('playback');
}

function base64ToBlobUrl(base64, mimeType = 'audio/mp3') {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    const blob = new Blob([bytes], { type: mimeType });
    return URL.createObjectURL(blob);
}

function playMp3(base64, sessionId, chunkIndex, isLast) {
    stopCurrent();

    currentAudioUrl = base64ToBlobUrl(base64);
    const audio = new Audio(currentAudioUrl);
    currentAudio = audio;

    // The only honest "sound is coming out now" signal: everything before it is
    // network and decode time. Reporting playback during that would run the
    // player's progress ahead of the audio.
    audio.onplaying = () => {
        if (sessionId !== currentSessionId) return;
        post({ type: 'AC_CHUNK_STARTED', sessionId, chunkIndex });
    };

    audio.ontimeupdate = () => {
        if (sessionId !== currentSessionId) return;
        const duration = audio.duration;
        if (!duration || !isFinite(duration)) return;
        const fraction = Math.min(1, Math.max(0, audio.currentTime / duration));
        post({ type: 'AC_CHUNK_PROGRESS', sessionId, chunkIndex, fraction });
    };

    audio.onended = () => {
        if (currentAudioUrl) {
            try { URL.revokeObjectURL(currentAudioUrl); } catch (_) {}
            currentAudioUrl = null;
        }
        currentAudio = null;
        if (sessionId === currentSessionId) {
            post({ type: 'AC_CHUNK_ENDED', sessionId, chunkIndex, isLast });
        }
    };

    audio.onerror = () => {
        if (sessionId === currentSessionId) {
            post({
                type: 'AC_CHUNK_ERROR',
                sessionId,
                chunkIndex,
                error: audio.error ? `Audio error code ${audio.error.code}` : 'Audio playback error',
                fatal: false
            });
        }
    };

    if (pausedState) return; // paused while this chunk was still synthesizing

    audio.play().catch((err) => {
        if (sessionId === currentSessionId) {
            post({ type: 'AC_CHUNK_ERROR', sessionId, chunkIndex, error: err.message, fatal: false });
        }
    });
}

// ── Chrome default voices (Web Speech) ────────────────────────────────────────

// Nothing to synthesize here: Chrome speaks the text itself and reports word
// boundaries as it goes, which map straight onto the chunk-progress fractions
// the neural path reports from audio playback position.
function speakWithWebSpeech(msg) {
    const { sessionId, chunkIndex, isLast, text, voice, rate, pitch } = msg;
    stopCurrent();

    const length = text.length || 1;
    webSpeechOwner = 'playback';

    WebSpeech.speak({
        text,
        voice,
        rate,
        pitch,
        onStart: () => {
            if (sessionId !== currentSessionId) return;
            post({ type: 'AC_CHUNK_STARTED', sessionId, chunkIndex });
        },
        onBoundary: (charIndex) => {
            if (sessionId !== currentSessionId) return;
            const fraction = Math.min(1, Math.max(0, charIndex / length));
            post({ type: 'AC_CHUNK_PROGRESS', sessionId, chunkIndex, fraction });
        },
        onEnd: () => {
            if (webSpeechOwner === 'playback') webSpeechOwner = null;
            if (sessionId !== currentSessionId) return;
            post({ type: 'AC_CHUNK_ENDED', sessionId, chunkIndex, isLast });
        },
        onError: (error, fatal) => {
            if (webSpeechOwner === 'playback') webSpeechOwner = null;
            if (sessionId !== currentSessionId) return;
            post({ type: 'AC_CHUNK_ERROR', sessionId, chunkIndex, error, fatal });
        }
    });
}

async function synthAndPlay(msg) {
    const { sessionId, chunkIndex, isLast, text, voice, rate, pitch } = msg;

    if (sessionId !== currentSessionId) {
        // New session: drop anything cached for older ones.
        for (const key of audioCache.keys()) {
            if (!key.startsWith(`${sessionId}:`)) audioCache.delete(key);
        }
        currentSessionId = sessionId;
    }
    currentEngine = msg.engine === 'webspeech' ? 'webspeech' : 'neural';
    currentChunkIndex = chunkIndex;
    pausedState = false;

    if (currentEngine === 'webspeech') {
        speakWithWebSpeech(msg);
        return;
    }

    let base64;
    try {
        base64 = await getOrSynthesize(sessionId, chunkIndex, text, voice, rate, pitch);
    } catch (err) {
        if (sessionId === currentSessionId) {
            post({
                type: 'AC_CHUNK_ERROR',
                sessionId,
                chunkIndex,
                error: (err && err.message) || String(err),
                fatal: true
            });
        }
        return;
    }

    if (sessionId !== currentSessionId) return; // stopped or superseded while synthesizing
    audioCache.delete(cacheKey(sessionId, chunkIndex));
    playMp3(base64, sessionId, chunkIndex, isLast);
}

function prefetch(msg) {
    if (msg.engine === 'webspeech') return;
    const { sessionId, chunkIndex, text, voice, rate, pitch } = msg;
    getOrSynthesize(sessionId, chunkIndex, text, voice, rate, pitch).catch(() => {
        // Errors surface when the chunk is actually played.
    });
}

function doStop() {
    currentSessionId = -1;
    pausedState = false;
    audioCache.clear();
    stopCurrent();
}

// ── Voice preview ─────────────────────────────────────────────────────────────

function stopPreview() {
    // Invalidate any preview still being synthesized so it never starts playing.
    previewToken++;
    cancelWebSpeech('preview');
    releaseAudio(previewAudio);
    previewAudio = null;
    if (previewAudioUrl) {
        try { URL.revokeObjectURL(previewAudioUrl); } catch (_) {}
        previewAudioUrl = null;
    }
}

async function playPreview(msg) {
    stopPreview();
    const token = ++previewToken;

    if (msg.engine === 'webspeech') {
        webSpeechOwner = 'preview';
        WebSpeech.speak({
            text: msg.text,
            voice: msg.voice,
            rate: msg.rate,
            pitch: msg.pitch,
            onStart: () => {
                if (token !== previewToken) return;
                post({ type: 'AC_PREVIEW_STARTED' });
            },
            onEnd: () => {
                if (webSpeechOwner === 'preview') webSpeechOwner = null;
                if (token !== previewToken) return;
                post({ type: 'AC_PREVIEW_ENDED' });
            },
            onError: (error) => {
                if (webSpeechOwner === 'preview') webSpeechOwner = null;
                if (token !== previewToken) return;
                post({ type: 'AC_PREVIEW_ERROR', error });
            }
        });
        return;
    }

    let base64;
    try {
        base64 = await synthesizeWithRetry(msg.text, msg.voice, msg.rate, msg.pitch);
    } catch (err) {
        if (token === previewToken) {
            post({ type: 'AC_PREVIEW_ERROR', error: (err && err.message) || String(err) });
        }
        return;
    }

    if (token !== previewToken) return; // stopped or superseded while synthesizing

    previewAudioUrl = base64ToBlobUrl(base64);
    const audio = new Audio(previewAudioUrl);
    previewAudio = audio;

    audio.onplaying = () => {
        if (token !== previewToken) return;
        post({ type: 'AC_PREVIEW_STARTED' });
    };
    audio.onended = () => {
        stopPreview();
        post({ type: 'AC_PREVIEW_ENDED' });
    };
    audio.onerror = () => {
        stopPreview();
        post({ type: 'AC_PREVIEW_ERROR', error: 'Preview playback error' });
    };
    audio.play().catch((err) => {
        stopPreview();
        post({ type: 'AC_PREVIEW_ERROR', error: err.message });
    });
}

// ── Full Audio Export ─────────────────────────────────────────────────────────
//
// The whole job runs here: split, synthesize a few segments at a time, join the
// MP3 frames, and hand the service worker a blob: URL to download. The bytes
// never cross a message as base64 — that is what capped the old export at a
// few minutes of audio — and everything the worker needs to finish the job
// (tab, filename) is echoed back in each message, so it can complete the
// download even if it was restarted while we were busy.

// requestId -> { cancelled, controller }
const activeExports = new Map();

// Export messages travel over a port rather than chrome.runtime.sendMessage.
// A one-shot message to a service worker that is asleep, starting, or shutting
// down can be dropped with nothing but a lastError nobody reads — and a lost
// result message means the audio is made and then thrown away, which looks
// exactly like a hang. A port delivers to a live worker, keeps it awake while
// the export runs, and tells us when it goes away so we can reconnect and say
// it all again.
let exportPort = null;
let exportPortRetry = null;
// The last thing worth repeating to a worker that reconnects.
let exportLastProgress = null;
let exportPendingResult = null;

// The tab whose export is talking, so its log can reach that page's console.
let exportLogTab;

function exportLog(...args) {
    // Mirrored into the page console by the content script, because the
    // offscreen document's own console is buried in chrome://extensions.
    console.log('[Audio Cursor export]', ...args);
    exportSend({ type: 'AC_EXPORT_LOG', tabId: exportLogTab, text: args.map(String).join(' ') }, false);
}

function connectExportPort() {
    if (exportPort) return exportPort;
    try {
        exportPort = chrome.runtime.connect({ name: 'ac-export' });
    } catch (_) {
        exportPort = null;
        return null;
    }
    exportPort.onMessage.addListener((msg) => {
        if (msg && msg.type === 'AC_EXPORT_ACK' && exportPendingResult &&
            msg.requestId === exportPendingResult.requestId) {
            exportPendingResult = null;
        }
    });
    exportPort.onDisconnect.addListener(() => {
        exportPort = null;
        // Keep saying it until someone confirms hearing it: a result that is
        // lost is audio we made and threw away, which looks like a hang.
        if (exportPendingResult) scheduleResultResend();
    });
    return exportPort;
}

function scheduleResultResend(attempt = 0) {
    if (exportPortRetry || !exportPendingResult) return;
    if (attempt > 60) return;
    exportPortRetry = setTimeout(() => {
        exportPortRetry = null;
        if (!exportPendingResult) return;
        exportSend(exportPendingResult, true);
        scheduleResultResend(attempt + 1);
    }, 1000);
}

function exportSend(msg, important = true) {
    const port = connectExportPort();
    if (port) {
        try {
            port.postMessage(msg);
            return;
        } catch (_) {
            exportPort = null;
        }
    }
    // No port available: fall back to a plain message so a worker that is up
    // still hears it, and let the reconnect above try again for a result.
    if (important) post(msg);
}
// requestId -> { url, timer }: blob URLs live until the worker reports the
// download done (AC_EXPORT_RELEASE), or this long, whichever is first.
const exportBlobUrls = new Map();
const EXPORT_URL_TTL_MS = 10 * 60 * 1000;

function rememberExportUrl(requestId, url) {
    const timer = setTimeout(() => releaseExportUrl(requestId), EXPORT_URL_TTL_MS);
    exportBlobUrls.set(requestId, { url, timer });
}

function releaseExportUrl(requestId) {
    const entry = exportBlobUrls.get(requestId);
    if (!entry) return;
    exportBlobUrls.delete(requestId);
    clearTimeout(entry.timer);
    try { URL.revokeObjectURL(entry.url); } catch (_) {}
}

function trackedSend(msg) {
    if (msg.type === 'AC_EXPORT_PROGRESS') exportLastProgress = msg;
    if (msg.type === 'AC_EXPORT_RESULT') {
        exportPendingResult = msg;
        exportSend(msg);
        scheduleResultResend();
        return;
    }
    exportSend(msg);
}

function cancelExport(requestId) {
    const entry = activeExports.get(requestId);
    if (!entry) return;
    entry.cancelled = true;
    // Abort rather than merely stop handing out work: an in-flight request
    // would otherwise hold its connection until it timed out.
    try { entry.controller.abort(); } catch (_) {}
}

const AUDIO_MIME = 'audio/mpeg';

// This document exists under the AUDIO_PLAYBACK reason, and Chrome ties both
// its lifetime and the rate its timers run at to audio actually coming out of
// it. An export plays nothing for minutes on end, so the document was liable
// to be throttled or torn down part way through — which is what an export that
// went silent with no error and no retries actually was. Holding an inaudible
// tone open for the duration keeps the document genuinely active.
let keepAliveCtx = null;
let keepAliveOsc = null;
let keepAliveHolders = 0;

function keepAwake() {
    keepAliveHolders++;
    if (keepAliveCtx) return;
    try {
        const Ctx = self.AudioContext || self.webkitAudioContext;
        keepAliveCtx = new Ctx();
        const gain = keepAliveCtx.createGain();
        // Low enough to be inaudible in practice, loud enough that Chrome
        // counts this document as playing audio rather than idle.
        gain.gain.value = 0.02;
        keepAliveOsc = keepAliveCtx.createOscillator();
        keepAliveOsc.frequency.value = 30;
        keepAliveOsc.connect(gain);
        gain.connect(keepAliveCtx.destination);
        keepAliveOsc.start();
        // It can come up suspended; a suspended context is not audio playing.
        if (keepAliveCtx.state !== 'running') keepAliveCtx.resume().catch(() => {});
        exportLog('keep-awake tone: ' + keepAliveCtx.state);
    } catch (err) {
        exportLog('keep-awake tone failed: ' + ((err && err.message) || err));
        keepAliveCtx = null;
        keepAliveOsc = null;
    }
}

function releaseAwake() {
    keepAliveHolders = Math.max(0, keepAliveHolders - 1);
    if (keepAliveHolders > 0) return;
    try { if (keepAliveOsc) keepAliveOsc.stop(); } catch (_) {}
    try { if (keepAliveCtx) keepAliveCtx.close(); } catch (_) {}
    keepAliveOsc = null;
    keepAliveCtx = null;
}

// Audio is kept as Blobs, never as typed arrays. A long export is tens of
// megabytes, and holding every part in the JavaScript heap — then copying the
// lot again to join them — is what put a ceiling on how much text could be
// exported. Blob data lives in the browser's own store, which spills to disk,
// so joining them at the end costs almost nothing.
function toAudioBlob(bytes) {
    return new Blob([bytes], { type: AUDIO_MIME });
}

function describeNote(note) {
    switch (note.kind) {
        case 'split': return `part ${note.segment} is being split up`;
        case 'skip': return `part ${note.segment} could not be read, skipping it`;
        case 'waiting': return `waiting on the speech service (${note.seconds}s)`;
        default: return `retrying part ${note.segment} (${note.attempt} of ${note.of})`;
    }
}

// Chrome's Web Speech voices cannot be recorded, so exporting one falls back to
// the cloud voice for its language — same as an OS voice does.
async function exportAudio(msg) {
    const { requestId, text, voice, lang, rate, pitch, tabId, filename, voiceName } = msg;
    const echo = { requestId, tabId, filename, voiceName };
    const state = { cancelled: false, controller: new AbortController() };
    activeExports.set(requestId, state);
    const isCancelled = () => state.cancelled;
    const signal = state.controller.signal;
    exportLogTab = tabId;
    keepAwake();

    try {
        const isNeural = msg.engine ? msg.engine === 'neural' : Boolean(voice && voice.includes('Neural'));
        const engine = isNeural ? 'neural' : 'cloud';
        const segments = ExportPipeline.segmentText(text, engine);
        if (!segments.length) throw new Error('Nothing to export');

        // Parts are written to storage as they are made and read back at the
        // end. This document may not outlive the export — Chrome retires an
        // offscreen document it thinks is idle — so anything held only here
        // would be lost. Stored parts mean a second attempt carries on rather
        // than starting again, which is what makes an arbitrarily long
        // selection exportable.
        const exportId = await ExportStore.exportIdFor([voice, String(rate), String(pitch), text]);
        ExportStore.sweepStale();
        const alreadyMade = await ExportStore.existingIndices(exportId);
        if (alreadyMade.size) {
            exportLog(`resuming: ${alreadyMade.size} of ${segments.length} parts already made`);
        }

        // A lane is one connection that speaks many segments in turn. The
        // neural service keeps a socket open for as long as we need it, which
        // is both quicker and gentler than a socket per segment; the cloud
        // endpoint is a plain request, so its lane holds nothing.
        let openLane;
        if (isNeural) {
            openLane = async () => {
                const session = await EdgeTTS.createSession({
                    connectTimeoutMs: ExportPipeline.CONNECT_TIMEOUT_MS
                });
                return {
                    speak: async (segment) => toAudioBlob(await session.speak(segment, voice, rate, pitch, {
                        timeoutMs: ExportPipeline.SEGMENT_TIMEOUT_MS,
                        signal,
                        // A truncated segment would silently drop words from
                        // the file, so a dropped connection is a failure here.
                        resolvePartialOnClose: false
                    })),
                    close: () => session.close()
                };
            };
        } else {
            const langMatch = (lang || voice || '').match(/^[a-z]{2,3}/);
            const langCode = langMatch ? langMatch[0] : 'en';
            openLane = async () => ({
                speak: async (segment) => toAudioBlob(await CloudTTS.fetchCloudAudioBytes(segment, langCode, {
                    signal,
                    timeoutMs: ExportPipeline.SEGMENT_TIMEOUT_MS
                })),
                close: () => {}
            });
        }

        exportLog(`starting: ${segments.length} parts, ${isNeural ? 'neural' : 'cloud'} voice ${voice}`);
        trackedSend({ type: 'AC_EXPORT_PROGRESS', ...echo, done: 0, total: segments.length });

        const { skipped } = await ExportPipeline.synthesizeSegments({
            segments,
            openLane,
            isCancelled,
            // A connection that answers neither audio nor an error cannot be
            // unwound from inside the pipeline; aborting closes its socket.
            onStall: () => { try { state.controller.abort(); } catch (_) {} },
            // Cloud segments are already at the endpoint's limit; only neural
            // ones can be retried in smaller pieces.
            split: isNeural ? undefined : null,
            combine: (pieces) => new Blob(pieces, { type: AUDIO_MIME }),
            hasPart: (index) => alreadyMade.has(index),
            onPart: (index, part) => ExportStore.putPart(exportId, index, part),
            onProgress: (done, total) => trackedSend({ type: 'AC_EXPORT_PROGRESS', ...echo, done, total }),
            onNotice: (note) => {
                if (note.kind !== 'waiting') {
                    exportLog(`${note.kind} part ${note.segment}${note.error ? ': ' + note.error : ''}`);
                }
                trackedSend({
                    type: 'AC_EXPORT_PROGRESS',
                    ...echo,
                    done: null,
                    note: describeNote(note)
                });
            }
        });

        if (isCancelled()) throw new ExportPipeline.CancelledError();

        trackedSend({ type: 'AC_EXPORT_PROGRESS', ...echo, done: null, note: 'assembling the file' });
        const usable = await ExportStore.readParts(exportId);
        if (!usable.length) {
            throw new Error('the speech service returned no audio for any part');
        }

        const blob = new Blob(usable, { type: AUDIO_MIME });
        const blobUrl = URL.createObjectURL(blob);
        rememberExportUrl(requestId, blobUrl);
        // The finished Blob owns its data, so the parts are no longer needed.
        ExportStore.deleteExport(exportId);
        exportLog(`finished: ${usable.length}/${segments.length} parts, ${(blob.size / 1048576).toFixed(1)} MB` +
            (skipped.length ? `, skipped ${skipped.map((s) => s.segment).join(', ')}` : ''));

        trackedSend({
            type: 'AC_EXPORT_RESULT',
            ...echo,
            success: true,
            blobUrl,
            size: blob.size,
            segments: segments.length,
            skipped: skipped.length
        });
    } catch (err) {
        const cancelled = Boolean((err && err.cancelled) || isCancelled());
        if (!cancelled) exportLog('failed: ' + ((err && err.message) || String(err)));
        trackedSend({
            type: 'AC_EXPORT_RESULT',
            ...echo,
            success: false,
            cancelled,
            error: cancelled ? 'Export cancelled' : ((err && err.message) || String(err))
        });
    } finally {
        activeExports.delete(requestId);
        releaseAwake();
    }
}

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        // "Are you still there?" — an export that has gone quiet is either a
        // slow speech service or a document that is no longer running, and
        // those need opposite responses.
        case 'AC_EXPORT_QUERY':
            sendResponse({
                alive: true,
                running: activeExports.has(message.requestId),
                progress: exportLastProgress || null
            });
            return;
        case 'AC_SYNTH_PLAY':
            synthAndPlay(message);
            break;
        case 'AC_PREFETCH':
            prefetch(message);
            break;
        case 'AC_PAUSE':
            pausedState = true;
            if (currentEngine === 'webspeech') WebSpeech.pause();
            else if (currentAudio) currentAudio.pause();
            break;
        case 'AC_RESUME':
            pausedState = false;
            if (currentEngine === 'webspeech') {
                // speechSynthesis has no "resumed" event, and an utterance only
                // fires onstart once — so confirm playback here instead. The
                // neural path gets its confirmation from the audio element.
                WebSpeech.resume();
                if (currentSessionId !== -1) {
                    post({ type: 'AC_CHUNK_STARTED', sessionId: currentSessionId, chunkIndex: currentChunkIndex });
                }
            } else if (currentAudio) {
                currentAudio.play().catch(() => {});
            }
            break;
        case 'AC_STOP':
            doStop();
            break;
        case 'AC_PREVIEW':
            playPreview(message);
            break;
        case 'AC_PREVIEW_STOP':
            stopPreview();
            break;
        case 'AC_EXPORT_AUDIO':
            exportAudio(message);
            break;
        case 'AC_EXPORT_CANCEL':
            cancelExport(message.requestId);
            break;
        case 'AC_EXPORT_RELEASE':
            releaseExportUrl(message.requestId);
            break;
    }
});
