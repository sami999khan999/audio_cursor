// Audio Cursor — Background Service Worker
// Manages speech playback and communication with content scripts.
//
// Three speech engines:
//   - Neural (Edge Natural voices, e.g. "en-US-JennyNeural"): this worker chunks
//     the text and drives playback, but the offscreen document does the actual
//     synthesis and audio playback, chunk by chunk. Synthesis cannot happen here:
//     Chromium does not apply declarativeNetRequest header rules to WebSocket
//     upgrades initiated from a service worker (crbug.com/1285664), so the
//     Origin/User-Agent spoofing rules.json needs would be skipped and
//     speech.platform.bing.com would reject the handshake with 403.
//   - Web Speech ('webspeech'): Chrome's own default voices, including the
//     bundled "Google …" ones that chrome.tts.getVoices() does not report.
//     window.speechSynthesis does not exist in a service worker either, so these
//     are chunked here and spoken by the offscreen document as well.
//   - Local (real OS/browser voices reported by chrome.tts.getVoices()): spoken
//     directly with chrome.tts.speak(), unchanged from before.

let currentSessionId = 0;
// Chunked playback driven from here and performed in the offscreen document —
// { sessionId, tabId, engine, text, voice, rate, pitch, chunks, chunkIndex }
let offscreenSession = null;
let offscreenReadyPromise = null;

function sendToTab(tabId, msg) {
    if (tabId !== undefined) {
        chrome.tabs.sendMessage(tabId, msg, () => void chrome.runtime.lastError);
    }
}

function isNeuralVoiceName(voiceName) {
    return typeof voiceName === 'string' && voiceName.includes('Neural');
}

// The popup records which engine a voice belongs to when it is picked. Settings
// saved before Chrome's default voices existed have no `voiceEngine`, so fall
// back to the old name heuristic for them.
function resolveEngine(voiceName, savedEngine) {
    if (savedEngine === 'neural' || savedEngine === 'webspeech' || savedEngine === 'local') {
        return savedEngine;
    }
    return isNeuralVoiceName(voiceName) ? 'neural' : 'local';
}

async function ensureOffscreenDocument() {
    if (await chrome.offscreen.hasDocument()) return;
    if (!offscreenReadyPromise) {
        offscreenReadyPromise = chrome.offscreen.createDocument({
            url: 'dist/offscreen.html',
            // AUDIO_PLAYBACK alone is the reason Chrome retires a document it
            // sees as idle, and an export makes no sound for minutes at a
            // time. BLOBS is equally true of it — the exported file is built
            // and held there — and does not carry that timeout.
            reasons: ['AUDIO_PLAYBACK', 'BLOBS'],
            justification: 'Play synthesized speech, and build exported audio files'
        }).finally(() => {
            offscreenReadyPromise = null;
        });
    }
    await offscreenReadyPromise;
}

// ── Local (chrome.tts) voice matching ───────────────────────────────────────

function findBestVoiceName(desiredVoiceName, systemVoices) {
    if (!systemVoices || systemVoices.length === 0) return undefined;
    if (!desiredVoiceName || desiredVoiceName === 'default') return systemVoices[0].voiceName;

    // 1. Exact match
    let m = systemVoices.find(s => s.voiceName === desiredVoiceName);
    if (m) return m.voiceName;

    // 2. Partial clean name (e.g. 'Jenny', 'Guy', 'David', 'Zira')
    const clean = desiredVoiceName.replace(/^[a-z]{2,3}-[A-Z]{2,4}-/, '').replace(/Neural$/, '').replace(/^Microsoft /, '');
    if (clean) {
        m = systemVoices.find(s => s.voiceName.toLowerCase().includes(clean.toLowerCase()));
        if (m) return m.voiceName;
    }

    // 3. Match lang + gender
    const langMatch = desiredVoiceName.match(/^[a-z]{2,3}/);
    const langPrefix = langMatch ? langMatch[0].toLowerCase() : 'en';
    const isMale = desiredVoiceName.toLowerCase().includes('guy') ||
                   desiredVoiceName.toLowerCase().includes('male') ||
                   desiredVoiceName.toLowerCase().includes('david') ||
                   desiredVoiceName.toLowerCase().includes('ryan') ||
                   desiredVoiceName.toLowerCase().includes('christopher');

    const sameLangList = systemVoices.filter(s => s.lang && s.lang.toLowerCase().replace('_', '-').startsWith(langPrefix));
    if (sameLangList.length > 0) {
        if (isMale) {
            const maleVoice = sameLangList.find(s => s.voiceName.toLowerCase().includes('male') || s.voiceName.toLowerCase().includes('david') || s.voiceName.toLowerCase().includes('guy'));
            if (maleVoice) return maleVoice.voiceName;
        } else {
            const femaleVoice = sameLangList.find(s => s.voiceName.toLowerCase().includes('female') || s.voiceName.toLowerCase().includes('zira') || s.voiceName.toLowerCase().includes('jenny'));
            if (femaleVoice) return femaleVoice.voiceName;
        }
        return sameLangList[0].voiceName;
    }

    return systemVoices[0].voiceName;
}

// ── Playback Control ──────────────────────────────────────────────────────────

async function startPlayback(text, offset, tabId) {
    const sessionId = ++currentSessionId;

    chrome.storage.sync.get(['voice', 'voiceEngine', 'rate', 'pitch', 'enabled'], async (data) => {
        if (data.enabled === false) return;
        if (sessionId !== currentSessionId) return;

        const voice = data.voice || 'en-US-JennyNeural';
        const rate = parseFloat(data.rate) || 1.0;
        const pitch = parseFloat(data.pitch) || 1.0;
        const engine = resolveEngine(voice, data.voiceEngine);

        // Speech does not begin here: a neural voice has to be synthesized over
        // the network first, and even a local one starts asynchronously. Report
        // that as 'loading' so the player holds its progress bar still until an
        // engine reports real playback.
        sendToTab(tabId, {
            type: 'TTS_STATUS',
            status: 'loading',
            offset,
            totalLength: text.length,
            rate
        });

        // Stop whatever engine was previously speaking.
        chrome.tts.stop();
        chrome.runtime.sendMessage({ type: 'AC_STOP' }, () => void chrome.runtime.lastError);
        offscreenSession = null;

        if (engine === 'local') {
            startLocalPlayback(text, offset, tabId, sessionId, voice, rate, pitch);
        } else {
            startOffscreenPlayback(text, offset, tabId, sessionId, engine, voice, rate, pitch);
        }
    });
}

function startLocalPlayback(text, offset, tabId, sessionId, voice, rate, pitch) {
    const isMale = voice.toLowerCase().includes('male') ||
                   voice.toLowerCase().includes('guy') ||
                   voice.toLowerCase().includes('david') ||
                   voice.toLowerCase().includes('ryan') ||
                   voice.toLowerCase().includes('christopher') ||
                   voice.toLowerCase().includes('keita');
    if (isMale) pitch *= 0.88;
    else pitch *= 1.06;

    chrome.tts.getVoices((systemVoices) => {
        if (sessionId !== currentSessionId) return;

        const voiceName = findBestVoiceName(voice, systemVoices);
        chrome.tts.stop();
        const textToSpeak = text.slice(offset);

        chrome.tts.speak(textToSpeak, {
            voiceName,
            rate,
            pitch,
            onEvent: (event) => {
                if (sessionId !== currentSessionId) return;
                if (event.type === 'start') {
                    sendToTab(tabId, { type: 'TTS_STATUS', status: 'playing', offset, totalLength: text.length, rate });
                } else if (event.type === 'word') {
                    sendToTab(tabId, { type: 'TTS_STATUS', status: 'playing', offset: offset + (event.charIndex || 0), totalLength: text.length, rate });
                } else if (event.type === 'end') {
                    chrome.storage.sync.get(['repeat'], (repData) => {
                        if (repData.repeat && sessionId === currentSessionId) {
                            startPlayback(text, 0, tabId);
                        } else {
                            sendToTab(tabId, { type: 'TTS_STATUS', status: 'idle' });
                        }
                    });
                } else if (event.type === 'error' || event.type === 'interrupted' || event.type === 'cancelled') {
                    sendToTab(tabId, { type: 'TTS_STATUS', status: 'idle' });
                }
            }
        });
    });
}

function startOffscreenPlayback(text, offset, tabId, sessionId, engine, voice, rate, pitch) {
    const remaining = text.slice(offset);
    const rawChunks = globalThis.ChunkText
        ? globalThis.ChunkText.chunkText(remaining, 300)
        : [{ index: 0, text: remaining, start: 0, end: remaining.length }];

    if (rawChunks.length === 0) {
        sendToTab(tabId, { type: 'TTS_STATUS', status: 'idle' });
        return;
    }

    const chunks = rawChunks.map(c => ({ ...c, start: c.start + offset, end: c.end + offset }));

    const session = {
        sessionId,
        tabId,
        engine,
        text,
        voice,
        rate,
        pitch,
        chunks,
        chunkIndex: 0
    };

    offscreenSession = session;
    playOffscreenChunk(session, 0);
}

async function playOffscreenChunk(session, index) {
    if (offscreenSession !== session) return; // superseded by a new session

    const chunk = session.chunks[index];
    if (!chunk) {
        chrome.storage.sync.get(['repeat'], (repData) => {
            if (offscreenSession !== session) return;
            if (repData.repeat) {
                startPlayback(session.text, 0, session.tabId);
            } else {
                offscreenSession = null;
                sendToTab(session.tabId, { type: 'TTS_STATUS', status: 'idle' });
            }
        });
        return;
    }

    try {
        await ensureOffscreenDocument();
    } catch (err) {
        console.error('Audio Cursor: could not create offscreen document', err);
        if (offscreenSession === session) {
            offscreenSession = null;
            sendToTab(session.tabId, { type: 'TTS_STATUS', status: 'idle' });
        }
        return;
    }
    if (offscreenSession !== session) return;

    session.chunkIndex = index;

    // Synthesis happens inside the offscreen document — see offscreen.js for why.
    chrome.runtime.sendMessage({
        type: 'AC_SYNTH_PLAY',
        sessionId: session.sessionId,
        chunkIndex: index,
        isLast: index === session.chunks.length - 1,
        engine: session.engine,
        text: chunk.text,
        voice: session.voice,
        rate: session.rate,
        pitch: session.pitch
    }, () => void chrome.runtime.lastError);

    // Only the chunk's starting position is known at this point — the audio for
    // it does not exist yet. 'playing' comes later, from AC_CHUNK_STARTED.
    sendToTab(session.tabId, {
        type: 'TTS_STATUS',
        status: 'loading',
        offset: chunk.start,
        totalLength: session.text.length,
        rate: session.rate
    });

    // Pre-fetch the next chunk's audio while this one plays.
    const nextChunk = session.engine === 'neural' ? session.chunks[index + 1] : null;
    if (nextChunk) {
        chrome.runtime.sendMessage({
            type: 'AC_PREFETCH',
            sessionId: session.sessionId,
            chunkIndex: index + 1,
            engine: session.engine,
            text: nextChunk.text,
            voice: session.voice,
            rate: session.rate,
            pitch: session.pitch
        }, () => void chrome.runtime.lastError);
    }
}

// ── MP3 Export ────────────────────────────────────────────────────────────────
//
// The offscreen document does the work (split, synthesize, join) and hands back
// a blob: URL; this worker only starts the download and watches it finish. The
// URL is same-origin with this worker, so chrome.downloads takes it at any
// size — unlike the base64 data: URL the export used to travel as, which
// Chrome refuses once a file is more than a few minutes of audio.

// tabId -> { requestId, filename, voiceName, startedAt, textLength }
const activeExports = new Map();
// downloadId -> { tabId, requestId, filename }
const pendingDownloads = new Map();
// Two triggers can fire for one keypress (the manifest command and the page's
// own keydown); a repeat this soon for the same text is that, not a new ask.
const DUPLICATE_TRIGGER_MS = 1500;
// If chrome.downloads refuses the blob URL, a small file can still go out the
// old way, through the page; a large one cannot and gets an honest error.
const DATA_URL_FALLBACK_MAX_BYTES = 2 * 1024 * 1024;
// A download of a local blob completes in well under this; if we never hear
// back (worker restarted between start and finish), ask instead of waiting.
const DOWNLOAD_SETTLE_CHECK_MS = 20000;
// How long an export may go without saying anything before we check whether
// the document doing the work is still running at all.
const EXPORT_QUIET_PROBE_MS = 25000;
// Restarts resume from stored parts, so several are useful rather than futile.
const MAX_EXPORT_RESTARTS = 6;
// requestId -> timestamp of the last thing we heard about it.
const exportActivity = new Map();
// requestIds already acted on, so a repeated result cannot download twice.
const settledExports = new Set();

function exportKey(tabId) {
    return tabId === undefined ? 'popup' : tabId;
}

function finishExport(tabId, status) {
    const entry = activeExports.get(exportKey(tabId));
    if (entry) exportActivity.delete(entry.requestId);
    activeExports.delete(exportKey(tabId));
    sendToTab(tabId, { type: 'DOWNLOAD_STATUS', ...status });
}

function releaseExportUrl(requestId) {
    chrome.runtime.sendMessage({ type: 'AC_EXPORT_RELEASE', requestId }, () => void chrome.runtime.lastError);
}

function requestExport(text, tabId, { restarted = false } = {}) {
    const key = exportKey(tabId);
    const active = activeExports.get(key);
    if (active && !restarted) {
        const isEcho = Date.now() - active.startedAt < DUPLICATE_TRIGGER_MS && active.textLength === text.length;
        if (!isEcho) sendToTab(tabId, { type: 'DOWNLOAD_STATUS', status: 'busy' });
        return;
    }

    const requestId = 'export_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    // The text is kept so an export whose document disappeared can be started
    // again without asking the page for the selection a second time.
    activeExports.set(key, {
        requestId,
        startedAt: Date.now(),
        textLength: text.length,
        text,
        // Each restart picks up the parts the last attempt stored, so several
        // are worth allowing; they make progress rather than repeating work.
        restarts: restarted ? ((active && active.restarts) || 0) + 1 : 0
    });
    exportActivity.set(requestId, Date.now());

    chrome.storage.sync.get(['voice', 'voiceEngine', 'voiceLang', 'rate', 'pitch'], async (data) => {
        const voice = data.voice || 'en-US-JennyNeural';
        const rate = parseFloat(data.rate) || 1.0;
        const pitch = parseFloat(data.pitch) || 1.0;
        const engine = resolveEngine(voice, data.voiceEngine);
        const voiceName = voice.replace(/^[a-z]{2,3}-[A-Z]{2,4}-/, '').replace(/Neural$/, '');
        const filename = `AudioCursor_${voiceName.replace(/\s+/g, '_')}_${Date.now()}.mp3`;

        const entry = activeExports.get(key);
        if (!entry || entry.requestId !== requestId) return;
        Object.assign(entry, { filename, voiceName });

        sendToTab(tabId, { type: 'DOWNLOAD_STATUS', status: 'loading', voiceName });

        try {
            await ensureOffscreenDocument();
            chrome.runtime.sendMessage({
                type: 'AC_EXPORT_AUDIO',
                requestId,
                tabId,
                filename,
                voiceName,
                text,
                engine,
                voice,
                lang: data.voiceLang || '',
                rate,
                pitch
            }, () => void chrome.runtime.lastError);
        } catch (err) {
            console.warn('Audio export error:', err);
            finishExport(tabId, { status: 'error', error: err.message });
        }
    });
}

// Ask the offscreen document whether it is still working. No answer means the
// document is gone — Chrome may retire one that is not playing audio — and the
// export is never going to report anything, so restart it once and say so.
function probeExporter(entry, tabId) {
    if (entry.probing) return;
    entry.probing = true;
    chrome.runtime.sendMessage({ type: 'AC_EXPORT_QUERY', requestId: entry.requestId }, (reply) => {
        const gone = chrome.runtime.lastError || !reply || !reply.alive;
        entry.probing = false;
        if (!gone) {
            // Alive and working; the speech service is just slow.
            if (reply.running) exportActivity.set(entry.requestId, Date.now());
            return;
        }
        console.warn('Export document is not responding; restarting the export.');
        recoverExport(entry, tabId);
    });
}

async function recoverExport(entry, tabId) {
    const text = entry.text;
    activeExports.delete(exportKey(tabId));
    exportActivity.delete(entry.requestId);
    settledExports.add(entry.requestId);

    if (!text || (entry.restarts || 0) >= MAX_EXPORT_RESTARTS) {
        sendToTab(tabId, {
            type: 'DOWNLOAD_STATUS',
            status: 'error',
            error: `the exporter stopped responding ${MAX_EXPORT_RESTARTS} times. The parts it did`
                + ' finish are kept, so pressing Alt+D again carries on from there.'
        });
        return;
    }

    sendToTab(tabId, { type: 'EXPORT_LOG', text: 'exporter went away — carrying on from the parts it saved' });
    sendToTab(tabId, { type: 'DOWNLOAD_STATUS', status: 'progress', done: null, note: 'restarting where it left off' });
    try {
        await ensureOffscreenDocument();
    } catch (_) {}
    requestExport(text, tabId, { restarted: true });
}

function cancelExport(tabId) {
    const active = activeExports.get(exportKey(tabId));
    if (!active) return;
    chrome.runtime.sendMessage({ type: 'AC_EXPORT_CANCEL', requestId: active.requestId }, () => void chrome.runtime.lastError);
}

function handleExportResult(msg) {
    const { requestId, tabId, filename } = msg;
    if (settledExports.has(requestId)) return;
    settledExports.add(requestId);
    if (settledExports.size > 20) {
        settledExports.delete(settledExports.values().next().value);
    }
    const active = activeExports.get(exportKey(tabId));
    // A result for an export this tab has since replaced is stale; one for an
    // export this (restarted) worker never saw is still worth finishing.
    if (active && active.requestId !== requestId) {
        if (msg.blobUrl) releaseExportUrl(requestId);
        return;
    }

    if (!msg.success) {
        finishExport(tabId, {
            status: msg.cancelled ? 'cancelled' : 'error',
            error: msg.error
        });
        return;
    }

    sendToTab(tabId, { type: 'DOWNLOAD_STATUS', status: 'saving', filename, skipped: msg.skipped });

    chrome.downloads.download({ url: msg.blobUrl, filename, saveAs: false }, (downloadId) => {
        const err = chrome.runtime.lastError;
        if (err || downloadId === undefined) {
            console.warn('chrome.downloads refused the export:', err && err.message);
            fallbackDownload(msg, err ? err.message : 'download did not start');
            return;
        }
        pendingDownloads.set(downloadId, { tabId, requestId, filename, skipped: msg.skipped });
        setTimeout(() => settleDownload(downloadId), DOWNLOAD_SETTLE_CHECK_MS);
    });
}

// The old route: base64 through the page and an <a download> click. Only
// viable for a small file, but keeps a small export working if chrome.downloads
// is unavailable or refuses the blob URL.
async function fallbackDownload(msg, reason) {
    const { requestId, tabId, filename } = msg;
    try {
        if (msg.size > DATA_URL_FALLBACK_MAX_BYTES) {
            throw new Error(`Chrome refused the download (${reason})`);
        }
        const resp = await fetch(msg.blobUrl);
        const bytes = new Uint8Array(await resp.arrayBuffer());
        let binary = '';
        const STEP = 0x8000;
        for (let i = 0; i < bytes.length; i += STEP) {
            binary += String.fromCharCode.apply(null, bytes.subarray(i, i + STEP));
        }
        const dataUrl = `data:audio/mpeg;base64,${btoa(binary)}`;
        sendToTab(tabId, { type: 'TRIGGER_ANCHOR_DOWNLOAD', dataUrl, filename });
        finishExport(tabId, { status: 'success', filename });
    } catch (err) {
        finishExport(tabId, { status: 'error', error: err.message });
    } finally {
        releaseExportUrl(requestId);
    }
}

function completeDownload(downloadId, state, errorCode) {
    const pending = pendingDownloads.get(downloadId);
    if (!pending) return;
    pendingDownloads.delete(downloadId);
    releaseExportUrl(pending.requestId);
    if (state === 'complete') {
        finishExport(pending.tabId, { status: 'success', filename: pending.filename, skipped: pending.skipped });
    } else if (errorCode === 'USER_CANCELED') {
        finishExport(pending.tabId, { status: 'cancelled' });
    } else {
        finishExport(pending.tabId, { status: 'error', error: `Download ${state || 'failed'}${errorCode ? ': ' + errorCode : ''}` });
    }
}

function settleDownload(downloadId) {
    if (!pendingDownloads.has(downloadId)) return;
    chrome.downloads.search({ id: downloadId }, (items) => {
        const item = items && items[0];
        if (!item) {
            completeDownload(downloadId, 'missing');
        } else if (item.state !== 'in_progress') {
            completeDownload(downloadId, item.state, item.error);
        } else {
            setTimeout(() => settleDownload(downloadId), DOWNLOAD_SETTLE_CHECK_MS);
        }
    });
}

// The offscreen document reports over a port: a one-shot message can be lost
// against a worker that is asleep or shutting down, and a lost result means an
// export that finished is never saved. A port also keeps this worker alive for
// as long as the export runs.
chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'ac-export') return;
    port.onMessage.addListener((message) => {
        if (!message) return;
        if (message.requestId) exportActivity.set(message.requestId, Date.now());
        switch (message.type) {
            case 'AC_EXPORT_PROGRESS':
                sendToTab(message.tabId, {
                    type: 'DOWNLOAD_STATUS',
                    status: 'progress',
                    done: message.done,
                    total: message.total,
                    note: message.note,
                    voiceName: message.voiceName
                });
                break;
            case 'AC_EXPORT_RESULT':
                // Acknowledge first: the sender repeats a result nobody has
                // confirmed, and repeating a download is worse than missing an
                // ack we can recover from.
                try { port.postMessage({ type: 'AC_EXPORT_ACK', requestId: message.requestId }); } catch (_) {}
                handleExportResult(message);
                break;
            case 'AC_EXPORT_LOG':
                sendToTab(message.tabId, { type: 'EXPORT_LOG', text: message.text });
                break;
        }
    });
});

chrome.downloads.onChanged.addListener((delta) => {
    if (!pendingDownloads.has(delta.id)) return;
    const state = delta.state && delta.state.current;
    if (state === 'complete' || state === 'interrupted') {
        completeDownload(delta.id, state, delta.error && delta.error.current);
    }
});

// ── Message Router ────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const tabId = sender.tab && sender.tab.id;

    switch (message.type) {
        case 'PLAY_TEXT':
        case 'START_SPEECH':
            if (tabId !== undefined) {
                startPlayback(message.text, message.offset || message.from || 0, tabId);
            } else {
                chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
                    if (tabs && tabs[0]) {
                        startPlayback(message.text, message.offset || message.from || 0, tabs[0].id);
                    }
                });
            }
            break;

        case 'PAUSE_TTS': {
            const target = tabId !== undefined ? tabId : (offscreenSession ? offscreenSession.tabId : undefined);
            if (offscreenSession) {
                chrome.runtime.sendMessage({ type: 'AC_PAUSE' }, () => void chrome.runtime.lastError);
            } else {
                currentSessionId++;
                chrome.tts.pause();
            }
            sendToTab(target, { type: 'TTS_STATUS', status: 'paused' });
            break;
        }

        case 'RESUME_TTS': {
            const target = tabId !== undefined ? tabId : (offscreenSession ? offscreenSession.tabId : undefined);
            if (offscreenSession) {
                chrome.runtime.sendMessage({ type: 'AC_RESUME' }, () => void chrome.runtime.lastError);
                // AC_CHUNK_STARTED confirms it; a resume that landed while the
                // chunk was still synthesizing has nothing to play back yet.
                sendToTab(target, { type: 'TTS_STATUS', status: 'loading' });
            } else {
                chrome.tts.resume();
                sendToTab(target, { type: 'TTS_STATUS', status: 'playing' });
            }
            break;
        }

        case 'STOP_TTS': {
            const target = tabId !== undefined ? tabId : (offscreenSession ? offscreenSession.tabId : undefined);
            currentSessionId++;
            chrome.tts.stop();
            if (offscreenSession) {
                chrome.runtime.sendMessage({ type: 'AC_STOP' }, () => void chrome.runtime.lastError);
                offscreenSession = null;
            }
            sendToTab(target, { type: 'TTS_STATUS', status: 'idle' });
            break;
        }

        case 'EXPORT_MP3':
            if (message.text && message.text.trim()) {
                requestExport(message.text.trim(), tabId);
            }
            break;

        case 'EXPORT_CANCEL':
            cancelExport(tabId);
            break;

        // The page asks how its export is doing. Answering keeps this worker
        // awake, and a long silence is checked here rather than left to look
        // like a hang in the page.
        case 'EXPORT_POLL': {
            const running = activeExports.get(exportKey(tabId));
            if (!running) {
                sendResponse({ running: false });
                return true;
            }
            const quietMs = Date.now() - (exportActivity.get(running.requestId) || running.startedAt);
            if (quietMs > EXPORT_QUIET_PROBE_MS) probeExporter(running, tabId);
            sendResponse({ running: true, quietMs });
            return true;
        }

        // From the offscreen document. Everything needed to finish is in the
        // message, so these work even if this worker was restarted meanwhile.
        case 'AC_EXPORT_PROGRESS':
            sendToTab(message.tabId, {
                type: 'DOWNLOAD_STATUS',
                status: 'progress',
                done: message.done,
                total: message.total,
                note: message.note,
                voiceName: message.voiceName
            });
            break;

        case 'AC_EXPORT_RESULT':
            handleExportResult(message);
            break;

        case 'AC_CHUNK_STARTED':
            if (offscreenSession && message.sessionId === offscreenSession.sessionId) {
                const startedChunk = offscreenSession.chunks[message.chunkIndex];
                sendToTab(offscreenSession.tabId, {
                    type: 'TTS_STATUS',
                    status: 'playing',
                    offset: startedChunk ? startedChunk.start : 0,
                    totalLength: offscreenSession.text.length,
                    rate: offscreenSession.rate
                });
            }
            break;

        case 'AC_CHUNK_ENDED':
            if (offscreenSession && message.sessionId === offscreenSession.sessionId) {
                playOffscreenChunk(offscreenSession, message.chunkIndex + 1);
            }
            break;

        case 'AC_CHUNK_ERROR':
            if (offscreenSession && message.sessionId === offscreenSession.sessionId) {
                const session = offscreenSession;
                if (message.fatal) {
                    // Synthesis failed — silently fall back to local voice.
                    const chunk = session.chunks[message.chunkIndex];
                    const resumeAt = chunk ? chunk.start : 0;
                    offscreenSession = null;
                    startLocalPlayback(session.text, resumeAt, session.tabId, session.sessionId, session.voice, session.rate, session.pitch);
                } else {
                    playOffscreenChunk(session, message.chunkIndex + 1);
                }
            }
            break;

        case 'AC_CHUNK_PROGRESS':
            if (offscreenSession && message.sessionId === offscreenSession.sessionId) {
                const chunk = offscreenSession.chunks[message.chunkIndex];
                if (chunk) {
                    const span = chunk.end - chunk.start;
                    const charIndex = chunk.start + Math.floor((message.fraction || 0) * span);
                    sendToTab(offscreenSession.tabId, { type: 'TTS_PROGRESS', charIndex });
                }
            }
            break;

        case 'PREVIEW_VOICE':
            ensureOffscreenDocument()
                .then(() => {
                    chrome.runtime.sendMessage({
                        type: 'AC_PREVIEW',
                        engine: message.engine || 'neural',
                        text: message.text,
                        voice: message.voice,
                        rate: message.rate || 1.0,
                        pitch: message.pitch || 1.0
                    }, () => void chrome.runtime.lastError);
                    sendResponse({ ok: true });
                })
                .catch((err) => sendResponse({ ok: false, error: err.message }));
            return true;

        case 'STOP_PREVIEW':
            chrome.runtime.sendMessage({ type: 'AC_PREVIEW_STOP' }, () => void chrome.runtime.lastError);
            break;
    }
});

// ── Context Menu & Keyboard Command ───────────────────────────────────────────

function setupContextMenu() {
    chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
            id: 'audio-cursor-play',
            title: 'Read with Audio Cursor',
            contexts: ['selection']
        });
    });
}

chrome.runtime.onInstalled.addListener(setupContextMenu);
chrome.runtime.onStartup.addListener(setupContextMenu);

chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (info.menuItemId === 'audio-cursor-play' && info.selectionText) {
        const tabId = tab && tab.id;
        if (tabId !== undefined) {
            startPlayback(info.selectionText.trim(), 0, tabId);
        }
    }
});

chrome.commands.onCommand.addListener((command) => {
    if (command === 'play-selection') {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs || !tabs[0]) return;
            const tab = tabs[0];
            const tabId = tab.id;

            if (tabId !== undefined) {
                chrome.tabs.sendMessage(tabId, { type: 'TRIGGER_PLAYBACK' }, () => {
                    void chrome.runtime.lastError;
                });
            }
        });
    } else if (command === 'download-selection') {
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (!tabs || !tabs[0]) return;
            const tab = tabs[0];
            const tabId = tab.id;

            if (tabId !== undefined) {
                chrome.tabs.sendMessage(tabId, { type: 'TRIGGER_DOWNLOAD_AUDIO' }, () => {
                    void chrome.runtime.lastError;
                });
            }
        });
    }
});
