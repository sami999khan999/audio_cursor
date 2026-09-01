// Audio Cursor — Offscreen Document
// Owns BOTH Edge Neural TTS synthesis and MP3 playback.
//
// Synthesis must happen here rather than in the background service worker:
// Chromium does not apply declarativeNetRequest header rules to WebSocket
// upgrade requests initiated from a service worker (crbug.com/1285664), so the
// Origin/User-Agent spoofing in rules.json is silently skipped there and
// speech.platform.bing.com answers the handshake with 403. From a document
// context the rules apply normally.
//
// Protocol (messages from background):
//   { type: 'AC_SYNTH_PLAY',   sessionId, chunkIndex, isLast, text, voice, rate, pitch }
//   { type: 'AC_PREFETCH',     sessionId, chunkIndex, text, voice, rate, pitch }
//   { type: 'AC_PAUSE'  }
//   { type: 'AC_RESUME' }
//   { type: 'AC_STOP'   }
//   { type: 'AC_PREVIEW',      text, voice, rate, pitch }
//   { type: 'AC_PREVIEW_STOP' }
//
// Protocol (messages to background):
//   { type: 'AC_CHUNK_PROGRESS', sessionId, chunkIndex, fraction }
//   { type: 'AC_CHUNK_ENDED',    sessionId, chunkIndex, isLast }
//   { type: 'AC_CHUNK_ERROR',    sessionId, chunkIndex, error, fatal }
//   { type: 'AC_PREVIEW_ENDED' }
//   { type: 'AC_PREVIEW_ERROR',  error }

let currentAudio = null;
let currentAudioUrl = null;
let currentSessionId = -1;

let previewAudio = null;
let previewAudioUrl = null;
let previewToken = 0;

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

    audio.play().catch((err) => {
        if (sessionId === currentSessionId) {
            post({ type: 'AC_CHUNK_ERROR', sessionId, chunkIndex, error: err.message, fatal: false });
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
    const { sessionId, chunkIndex, text, voice, rate, pitch } = msg;
    getOrSynthesize(sessionId, chunkIndex, text, voice, rate, pitch).catch(() => {
        // Errors surface when the chunk is actually played.
    });
}

function doStop() {
    currentSessionId = -1;
    audioCache.clear();
    stopCurrent();
}

// ── Voice preview ─────────────────────────────────────────────────────────────

function stopPreview() {
    // Invalidate any preview still being synthesized so it never starts playing.
    previewToken++;
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

async function exportAudio(msg) {
    const { requestId, text, voice, rate, pitch } = msg;
    try {
        const isNeural = voice && voice.includes('Neural');
        let chunks;
        if (typeof Chunk !== 'undefined' && Chunk.chunkText) {
            chunks = Chunk.chunkText(text);
        } else {
            chunks = [{ text: text.trim(), start: 0, end: text.length }];
        }

        const buffers = [];
        for (const chunk of chunks) {
            if (!chunk.text || !chunk.text.trim()) continue;
            let base64;
            if (isNeural) {
                base64 = await synthesizeWithRetry(chunk.text, voice, rate, pitch);
            } else {
                const langMatch = voice.match(/^[a-z]{2,3}/);
                const langCode = langMatch ? langMatch[0] : 'en';
                const res = await CloudTTS.synthesizeCloudAudio(chunk.text, langCode);
                base64 = res.base64;
            }

            if (base64) {
                const bin = atob(base64);
                const bytes = new Uint8Array(bin.length);
                for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
                buffers.push(bytes);
            }
        }

        const totalLen = buffers.reduce((a, b) => a + b.length, 0);
        const merged = new Uint8Array(totalLen);
        let offset = 0;
        for (const b of buffers) {
            merged.set(b, offset);
            offset += b.length;
        }

        let binary = '';
        for (let i = 0; i < merged.length; i++) binary += String.fromCharCode(merged[i]);
        const base64 = btoa(binary);

        post({
            type: 'AC_EXPORT_RESULT',
            requestId,
            base64,
            success: true
        });
    } catch (err) {
        console.warn('Offscreen audio export error:', err);
        post({
            type: 'AC_EXPORT_RESULT',
            requestId,
            error: (err && err.message) || String(err),
            success: false
        });
    }
}

// ── Message router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message) => {
    switch (message.type) {
        case 'AC_SYNTH_PLAY':
            synthAndPlay(message);
            break;
        case 'AC_PREFETCH':
            prefetch(message);
            break;
        case 'AC_PAUSE':
            if (currentAudio) currentAudio.pause();
            break;
        case 'AC_RESUME':
            if (currentAudio) currentAudio.play().catch(() => {});
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
    }
});
