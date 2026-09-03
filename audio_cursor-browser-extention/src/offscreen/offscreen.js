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
//   { type: 'AC_CHUNK_PROGRESS', sessionId, chunkIndex, fraction }
//   { type: 'AC_CHUNK_ENDED',    sessionId, chunkIndex, isLast }
//   { type: 'AC_CHUNK_ERROR',    sessionId, chunkIndex, error, fatal }
//   { type: 'AC_PREVIEW_ENDED' }
//   { type: 'AC_PREVIEW_ERROR',  error }

let currentAudio = null;
let currentAudioUrl = null;
let currentSessionId = -1;
let currentEngine = 'neural';

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

// Chrome's Web Speech voices cannot be recorded, so exporting one falls back to
// the cloud voice for its language — same as an OS voice does.
async function exportAudio(msg) {
    const { requestId, text, voice, lang, rate, pitch } = msg;
    try {
        const isNeural = msg.engine ? msg.engine === 'neural' : Boolean(voice && voice.includes('Neural'));
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
                const langMatch = (lang || voice || '').match(/^[a-z]{2,3}/);
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
            if (currentEngine === 'webspeech') WebSpeech.pause();
            else if (currentAudio) currentAudio.pause();
            break;
        case 'AC_RESUME':
            if (currentEngine === 'webspeech') WebSpeech.resume();
            else if (currentAudio) currentAudio.play().catch(() => {});
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
