// Audio Cursor — Background Service Worker
// Manages speech playback and communication with content scripts.
//
// Two speech engines:
//   - Neural (Edge Natural voices, e.g. "en-US-JennyNeural"): this worker chunks
//     the text and drives playback, but the offscreen document does the actual
//     synthesis and audio playback, chunk by chunk. Synthesis cannot happen here:
//     Chromium does not apply declarativeNetRequest header rules to WebSocket
//     upgrades initiated from a service worker (crbug.com/1285664), so the
//     Origin/User-Agent spoofing rules.json needs would be skipped and
//     speech.platform.bing.com would reject the handshake with 403.
//   - Local (real OS/browser voices reported by chrome.tts.getVoices()): spoken
//     directly with chrome.tts.speak(), unchanged from before.

let currentSessionId = 0;
let neuralSession = null; // { sessionId, tabId, text, voice, rate, pitch, chunks, chunkIndex }
let offscreenReadyPromise = null;

function sendToTab(tabId, msg) {
    if (tabId !== undefined) {
        chrome.tabs.sendMessage(tabId, msg, () => void chrome.runtime.lastError);
    }
}

function isNeuralVoiceName(voiceName) {
    return typeof voiceName === 'string' && voiceName.includes('Neural');
}

async function ensureOffscreenDocument() {
    if (await chrome.offscreen.hasDocument()) return;
    if (!offscreenReadyPromise) {
        offscreenReadyPromise = chrome.offscreen.createDocument({
            url: 'dist/offscreen.html',
            reasons: ['AUDIO_PLAYBACK'],
            justification: 'Play synthesized Audio Cursor speech audio'
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

    chrome.storage.sync.get(['voice', 'rate', 'pitch', 'enabled'], async (data) => {
        if (data.enabled === false) return;
        if (sessionId !== currentSessionId) return;

        const voice = data.voice || 'en-US-JennyNeural';
        const rate = parseFloat(data.rate) || 1.0;
        const pitch = parseFloat(data.pitch) || 1.0;

        // Stop whatever engine was previously speaking.
        chrome.tts.stop();
        chrome.runtime.sendMessage({ type: 'AC_STOP' }, () => void chrome.runtime.lastError);
        neuralSession = null;

        if (isNeuralVoiceName(voice)) {
            startNeuralPlayback(text, offset, tabId, sessionId, voice, rate, pitch);
        } else {
            startLocalPlayback(text, offset, tabId, sessionId, voice, rate, pitch);
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

function startNeuralPlayback(text, offset, tabId, sessionId, voice, rate, pitch) {
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
        text,
        voice,
        rate,
        pitch,
        chunks,
        chunkIndex: 0
    };

    neuralSession = session;
    playNeuralChunk(session, 0);
}

async function playNeuralChunk(session, index) {
    if (neuralSession !== session) return; // superseded by a new session

    const chunk = session.chunks[index];
    if (!chunk) {
        chrome.storage.sync.get(['repeat'], (repData) => {
            if (neuralSession !== session) return;
            if (repData.repeat) {
                startPlayback(session.text, 0, session.tabId);
            } else {
                neuralSession = null;
                sendToTab(session.tabId, { type: 'TTS_STATUS', status: 'idle' });
            }
        });
        return;
    }

    try {
        await ensureOffscreenDocument();
    } catch (err) {
        console.error('Audio Cursor: could not create offscreen document', err);
        if (neuralSession === session) {
            neuralSession = null;
            sendToTab(session.tabId, { type: 'TTS_STATUS', status: 'idle' });
        }
        return;
    }
    if (neuralSession !== session) return;

    session.chunkIndex = index;

    // Synthesis happens inside the offscreen document — see offscreen.js for why.
    chrome.runtime.sendMessage({
        type: 'AC_SYNTH_PLAY',
        sessionId: session.sessionId,
        chunkIndex: index,
        isLast: index === session.chunks.length - 1,
        text: chunk.text,
        voice: session.voice,
        rate: session.rate,
        pitch: session.pitch
    }, () => void chrome.runtime.lastError);

    sendToTab(session.tabId, {
        type: 'TTS_STATUS',
        status: 'playing',
        offset: chunk.start,
        totalLength: session.text.length,
        rate: session.rate
    });

    // Pre-fetch the next chunk's audio while this one plays.
    const nextChunk = session.chunks[index + 1];
    if (nextChunk) {
        chrome.runtime.sendMessage({
            type: 'AC_PREFETCH',
            sessionId: session.sessionId,
            chunkIndex: index + 1,
            text: nextChunk.text,
            voice: session.voice,
            rate: session.rate,
            pitch: session.pitch
        }, () => void chrome.runtime.lastError);
    }
}

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
            const target = tabId !== undefined ? tabId : (neuralSession ? neuralSession.tabId : undefined);
            if (neuralSession) {
                chrome.runtime.sendMessage({ type: 'AC_PAUSE' }, () => void chrome.runtime.lastError);
            } else {
                currentSessionId++;
                chrome.tts.pause();
            }
            sendToTab(target, { type: 'TTS_STATUS', status: 'paused' });
            break;
        }

        case 'RESUME_TTS': {
            const target = tabId !== undefined ? tabId : (neuralSession ? neuralSession.tabId : undefined);
            if (neuralSession) {
                chrome.runtime.sendMessage({ type: 'AC_RESUME' }, () => void chrome.runtime.lastError);
            } else {
                chrome.tts.resume();
            }
            sendToTab(target, { type: 'TTS_STATUS', status: 'playing' });
            break;
        }

        case 'STOP_TTS': {
            const target = tabId !== undefined ? tabId : (neuralSession ? neuralSession.tabId : undefined);
            currentSessionId++;
            chrome.tts.stop();
            if (neuralSession) {
                chrome.runtime.sendMessage({ type: 'AC_STOP' }, () => void chrome.runtime.lastError);
                neuralSession = null;
            }
            sendToTab(target, { type: 'TTS_STATUS', status: 'idle' });
            break;
        }

        case 'AC_CHUNK_ENDED':
            if (neuralSession && message.sessionId === neuralSession.sessionId) {
                playNeuralChunk(neuralSession, message.chunkIndex + 1);
            }
            break;

        case 'AC_CHUNK_ERROR':
            if (neuralSession && message.sessionId === neuralSession.sessionId) {
                const session = neuralSession;
                if (message.fatal) {
                    // Synthesis failed (network / Edge TTS handshake). Keep the page
                    // readable by finishing with a local system voice instead of
                    // going silent, but make the reason obvious in the console.
                    console.error(
                        `Audio Cursor: Edge Neural TTS synthesis failed for "${session.voice}" ` +
                        `(${message.error}). Falling back to a local system voice.`
                    );
                    const chunk = session.chunks[message.chunkIndex];
                    const resumeAt = chunk ? chunk.start : 0;
                    neuralSession = null;
                    startLocalPlayback(session.text, resumeAt, session.tabId, session.sessionId, session.voice, session.rate, session.pitch);
                } else {
                    console.warn('Audio Cursor: chunk playback error', message.error);
                    playNeuralChunk(session, message.chunkIndex + 1);
                }
            }
            break;

        case 'AC_CHUNK_PROGRESS':
            if (neuralSession && message.sessionId === neuralSession.sessionId) {
                const chunk = neuralSession.chunks[message.chunkIndex];
                if (chunk) {
                    const span = chunk.end - chunk.start;
                    const charIndex = chunk.start + Math.floor((message.fraction || 0) * span);
                    sendToTab(neuralSession.tabId, { type: 'TTS_PROGRESS', charIndex });
                }
            }
            break;

        case 'PREVIEW_VOICE':
            ensureOffscreenDocument()
                .then(() => {
                    chrome.runtime.sendMessage({
                        type: 'AC_PREVIEW',
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
    }
});
