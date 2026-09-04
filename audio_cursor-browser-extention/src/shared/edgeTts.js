// Audio Cursor — Edge TTS WebSocket Client
// Connects to Microsoft Edge TTS cloud service and streams MP3 audio.
// Runs natively in Chrome MV3 service worker, popup, and offscreen document.

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WINDOWS_FILE_TIME_EPOCH = 11644473600n;
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';

function uuid() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

function timestamp() {
    return new Date().toISOString();
}

function escapeXml(text) {
    if (!text) return '';
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

function rateToPercent(rate) {
    const pct = Math.round((rate - 1.0) * 100);
    return pct >= 0 ? `+${pct}%` : `${pct}%`;
}

function pitchToHz(pitch) {
    const hz = Math.round((pitch - 1.0) * 50);
    return hz >= 0 ? `+${hz}Hz` : `${hz}Hz`;
}

async function generateSecMsGec() {
    try {
        const ticks = BigInt(Math.floor(Date.now() / 1000) + Number(WINDOWS_FILE_TIME_EPOCH));
        const roundedTicks = (ticks - (ticks % 300n)) * 10000000n;
        const strToHash = `${roundedTicks}${TRUSTED_CLIENT_TOKEN}`;
        const encoder = new TextEncoder();
        const data = encoder.encode(strToHash);
        const hashBuffer = await crypto.subtle.digest('SHA-256', data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
    } catch (e) {
        return '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
    }
}

function buildSsml(text, voice = 'en-US-JennyNeural', rate = 1.0, pitch = 1.0) {
    const safeText = escapeXml(text);
    const rateStr = rateToPercent(rate);
    const pitchStr = pitchToHz(pitch);
    const langMatch = voice.match(/^[a-z]{2,3}-[A-Z]{2,4}/);
    const locale = langMatch ? langMatch[0] : 'en-US';

    return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${locale}">
    <voice name="${voice}">
        <prosody pitch="${pitchStr}" rate="${rateStr}" volume="+0%">
            ${safeText}
        </prosody>
    </voice>
</speak>`;
}

function uint8ToBase64(bytes) {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

const AUDIO_SEPARATOR = new TextEncoder().encode('Path:audio\r\n');

/** Offset just past `Path:audio\r\n`, or -1 when this frame is not audio. */
function audioBodyOffset(bytes) {
    outer:
    for (let i = 0; i <= bytes.length - AUDIO_SEPARATOR.length; i++) {
        for (let j = 0; j < AUDIO_SEPARATOR.length; j++) {
            if (bytes[i + j] !== AUDIO_SEPARATOR[j]) continue outer;
        }
        return i + AUDIO_SEPARATOR.length;
    }
    return -1;
}

function mergeChunks(chunks) {
    const total = chunks.reduce((n, c) => n + c.byteLength, 0);
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(new Uint8Array(chunk), offset);
        offset += chunk.byteLength;
    }
    return merged;
}

/**
 * Open one connection to the speech service and keep it, so many syntheses can
 * be spoken over it in turn. Opening a socket per sentence is what made a long
 * export slow and fragile: the handshake costs more than the synthesis, and a
 * burst of them runs into the browser's own limit on concurrent WebSocket
 * handshakes to one address.
 *
 * The returned session speaks one request at a time. Anything that goes wrong
 * mid-request — a timeout, an abort, the service hanging up — closes the whole
 * connection, because a half-delivered response cannot be told apart from the
 * start of the next one. The caller opens a fresh session and tries again.
 *
 * @param {{ connectTimeoutMs?: number }} [options]
 * @returns {Promise<{ speak: Function, close: Function, readonly closed: boolean }>}
 */
function createSession(options = {}) {
    const connectTimeoutMs = options.connectTimeoutMs || 15000;

    return generateSecMsGec().then((secMsGec) => new Promise((resolve, reject) => {
        const connId = uuid().replace(/-/g, '');
        const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=1-143.0.3650.96&ConnectionId=${connId}`;

        let ws;
        try {
            ws = new WebSocket(wsUrl);
        } catch (err) {
            reject(new Error(`WebSocket open failed: ${err.message}`));
            return;
        }
        ws.binaryType = 'arraybuffer';

        let opened = false;
        let closed = false;
        /** @type {null | { resolve, reject, chunks, timer, signal, onAbort, partialOk }} */
        let pending = null;

        const connectTimer = setTimeout(() => {
            if (opened || closed) return;
            closed = true;
            try { ws.close(); } catch (_) {}
            reject(new Error(`Speech service did not answer within ${Math.round(connectTimeoutMs / 1000)} s`));
        }, connectTimeoutMs);

        function detach(p) {
            clearTimeout(p.timer);
            if (p.signal && p.onAbort) p.signal.removeEventListener('abort', p.onAbort);
        }

        function finishPending(bytes) {
            const p = pending;
            if (!p) return;
            pending = null;
            detach(p);
            p.resolve(bytes);
        }

        function failPending(message) {
            const p = pending;
            if (!p) return;
            pending = null;
            detach(p);
            // Playback would rather have a clipped tail than nothing; an export
            // must not, or the file quietly loses words.
            if (p.partialOk && p.chunks.length > 0) p.resolve(mergeChunks(p.chunks));
            else p.reject(new Error(message));
        }

        function shutdown(message) {
            closed = true;
            clearTimeout(connectTimer);
            try { ws.close(); } catch (_) {}
            failPending(message);
        }

        ws.onopen = () => {
            if (closed) return;
            opened = true;
            clearTimeout(connectTimer);
            const ts = timestamp();
            ws.send(
                `X-Timestamp:${ts}\r\n` +
                `Content-Type:application/json; charset=utf-8\r\n` +
                `Path:speech.config\r\n\r\n` +
                JSON.stringify({
                    context: {
                        synthesis: {
                            audio: {
                                metadataoptions: {
                                    sentenceBoundaryEnabled: "false",
                                    wordBoundaryEnabled: "false"
                                },
                                outputFormat: OUTPUT_FORMAT
                            }
                        }
                    }
                })
            );
            resolve(session);
        };

        ws.onerror = () => {
            if (!opened) {
                closed = true;
                clearTimeout(connectTimer);
                reject(new Error('Edge TTS WebSocket error'));
                return;
            }
            shutdown('Edge TTS WebSocket error');
        };

        ws.onclose = (event) => {
            if (!opened) {
                closed = true;
                clearTimeout(connectTimer);
                reject(new Error(`Edge TTS closed unexpectedly (code ${event && event.code})`));
                return;
            }
            closed = true;
            failPending(`Edge TTS closed unexpectedly (code ${event && event.code})`);
        };

        ws.onmessage = async (event) => {
            if (!pending) return;
            let data = event.data;
            if (typeof Blob !== 'undefined' && data instanceof Blob) {
                data = await data.arrayBuffer();
                if (!pending) return;
            }

            if (typeof data === 'string') {
                if (data.includes('Path:turn.end')) finishPending(mergeChunks(pending.chunks));
                return;
            }

            if (data instanceof ArrayBuffer) {
                const bytes = new Uint8Array(data);
                const header = new TextDecoder().decode(bytes.subarray(0, Math.min(256, bytes.length)));
                if (header.includes('Path:turn.end')) {
                    finishPending(mergeChunks(pending.chunks));
                    return;
                }
                const start = audioBodyOffset(bytes);
                if (start !== -1 && start < bytes.length) pending.chunks.push(data.slice(start));
            }
        };

        const session = {
            get closed() {
                return closed;
            },

            /**
             * Speak one text over this connection.
             * @param {string} text
             * @param {string} voice
             * @param {number} rate
             * @param {number} pitch
             * @param {{ timeoutMs?: number, signal?: AbortSignal, resolvePartialOnClose?: boolean }} [opts]
             * @returns {Promise<Uint8Array>}
             */
            speak(text, voice = 'en-US-JennyNeural', rate = 1.0, pitch = 1.0, opts = {}) {
                if (closed) return Promise.reject(new Error('Speech connection is closed'));
                if (pending) return Promise.reject(new Error('This connection is already speaking'));

                const { timeoutMs = 0, signal = null, resolvePartialOnClose = false } = opts;
                if (signal && signal.aborted) return Promise.reject(new Error('Cancelled'));

                return new Promise((res, rej) => {
                    const p = {
                        resolve: res,
                        reject: rej,
                        chunks: [],
                        timer: null,
                        signal,
                        onAbort: null,
                        partialOk: resolvePartialOnClose
                    };
                    pending = p;

                    if (timeoutMs > 0) {
                        p.timer = setTimeout(() => {
                            // Close the socket too: an abandoned request would
                            // otherwise keep the connection and its audio
                            // arriving with nobody to receive it.
                            shutdown(`Speech service timed out after ${Math.round(timeoutMs / 1000)} s`);
                        }, timeoutMs);
                    }
                    if (signal) {
                        p.onAbort = () => shutdown('Cancelled');
                        signal.addEventListener('abort', p.onAbort, { once: true });
                    }

                    const requestId = uuid().replace(/-/g, '');
                    try {
                        ws.send(
                            `X-RequestId:${requestId}\r\n` +
                            `Content-Type:application/ssml+xml\r\n` +
                            `X-Timestamp:${timestamp()}\r\n` +
                            `Path:ssml\r\n\r\n` +
                            buildSsml(text, voice, rate, pitch)
                        );
                    } catch (err) {
                        shutdown(`Could not send to the speech service: ${err.message}`);
                    }
                });
            },

            close() {
                if (closed) return;
                closed = true;
                clearTimeout(connectTimer);
                try { ws.close(); } catch (_) {}
                failPending('Speech connection closed');
            }
        };
    }));
}

/**
 * Synthesize one text on a connection of its own.
 * Returns a Promise<{ base64: string, bytes: Uint8Array }> of MP3 audio.
 *
 * @param {string} text
 * @param {string} voice  e.g. 'en-US-JennyNeural'
 * @param {number} rate   0.5-2.0
 * @param {number} pitch  0.0-2.0
 * @param {{ timeoutMs?: number, signal?: AbortSignal, resolvePartialOnClose?: boolean }} [options]
 * @returns {Promise<{ base64: string, bytes: Uint8Array }>}
 */
async function synthesize(text, voice = 'en-US-JennyNeural', rate = 1.0, pitch = 1.0, options = {}) {
    const session = await createSession({ connectTimeoutMs: options.connectTimeoutMs || options.timeoutMs || 15000 });
    try {
        const bytes = await session.speak(text, voice, rate, pitch, {
            timeoutMs: options.timeoutMs || 0,
            signal: options.signal,
            // Playback has always preferred a clipped tail to a failure.
            resolvePartialOnClose: options.resolvePartialOnClose !== false
        });
        return { base64: uint8ToBase64(bytes), bytes };
    } finally {
        session.close();
    }
}

globalThis.EdgeTTS = { synthesize, createSession, escapeXml, generateSecMsGec, uint8ToBase64, buildSsml };
if (typeof module !== 'undefined' && module.exports) module.exports = globalThis.EdgeTTS;
