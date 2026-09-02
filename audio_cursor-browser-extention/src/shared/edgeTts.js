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

/**
 * Synthesize text using Edge TTS WebSocket.
 * Returns a Promise<{ base64: string, bytes: Uint8Array }> of MP3 audio.
 *
 * @param {string} text
 * @param {string} voice  e.g. 'en-US-JennyNeural'
 * @param {number} rate   0.5-2.0
 * @param {number} pitch  0.0-2.0
 * @returns {Promise<{ base64: string, bytes: Uint8Array }>}
 */
async function synthesize(text, voice = 'en-US-JennyNeural', rate = 1.0, pitch = 1.0) {
    const secMsGec = await generateSecMsGec();
    const connId = uuid().replace(/-/g, '');
    const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=1-143.0.3650.96&ConnectionId=${connId}`;

    return new Promise((resolve, reject) => {
        let ws;
        try {
            ws = new WebSocket(wsUrl);
        } catch (err) {
            return reject(new Error(`WebSocket open failed: ${err.message}`));
        }

        ws.binaryType = 'arraybuffer';

        const requestId = uuid().replace(/-/g, '');
        const audioChunks = [];
        let done = false;

        const AUDIO_SEPARATOR = new TextEncoder().encode('Path:audio\r\n');

        function cleanup() {
            try { ws.close(); } catch (_) {}
        }

        ws.onopen = () => {
            const ts = timestamp();
            const configMsg =
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
                });
            ws.send(configMsg);

            const ssml = buildSsml(text, voice, rate, pitch);
            const ssmlMsg =
                `X-RequestId:${requestId}\r\n` +
                `Content-Type:application/ssml+xml\r\n` +
                `X-Timestamp:${ts}\r\n` +
                `Path:ssml\r\n\r\n` +
                ssml;
            ws.send(ssmlMsg);
        };

        ws.onmessage = async (event) => {
            if (done) return;

            let data = event.data;
            if (typeof Blob !== 'undefined' && data instanceof Blob) {
                data = await data.arrayBuffer();
            }

            if (typeof data === 'string') {
                if (data.includes('Path:turn.end')) {
                    done = true;
                    cleanup();
                    const totalLength = audioChunks.reduce((s, c) => s + c.byteLength, 0);
                    const merged = new Uint8Array(totalLength);
                    let offset = 0;
                    for (const chunk of audioChunks) {
                        merged.set(new Uint8Array(chunk), offset);
                        offset += chunk.byteLength;
                    }
                    const base64 = uint8ToBase64(merged);
                    resolve({ base64, bytes: merged });
                }
                return;
            }

            if (data instanceof ArrayBuffer) {
                const bytes = new Uint8Array(data);
                const textHeader = new TextDecoder().decode(bytes.subarray(0, Math.min(256, bytes.length)));

                if (textHeader.includes('Path:turn.end')) {
                    done = true;
                    cleanup();
                    const totalLength = audioChunks.reduce((s, c) => s + c.byteLength, 0);
                    const merged = new Uint8Array(totalLength);
                    let offset = 0;
                    for (const chunk of audioChunks) {
                        merged.set(new Uint8Array(chunk), offset);
                        offset += chunk.byteLength;
                    }
                    const base64 = uint8ToBase64(merged);
                    resolve({ base64, bytes: merged });
                    return;
                }

                // Check for binary audio delimiter
                let sepIdx = -1;
                for (let i = 0; i <= bytes.length - AUDIO_SEPARATOR.length; i++) {
                    let match = true;
                    for (let j = 0; j < AUDIO_SEPARATOR.length; j++) {
                        if (bytes[i + j] !== AUDIO_SEPARATOR[j]) {
                            match = false;
                            break;
                        }
                    }
                    if (match) {
                        sepIdx = i + AUDIO_SEPARATOR.length;
                        break;
                    }
                }

                if (sepIdx !== -1 && sepIdx < bytes.length) {
                    audioChunks.push(data.slice(sepIdx));
                }
            }
        };

        ws.onerror = () => {
            if (!done) {
                done = true;
                cleanup();
                reject(new Error('Edge TTS WebSocket error'));
            }
        };

        ws.onclose = (event) => {
            if (!done) {
                done = true;
                if (audioChunks.length > 0) {
                    const totalLength = audioChunks.reduce((s, c) => s + c.byteLength, 0);
                    const merged = new Uint8Array(totalLength);
                    let offset = 0;
                    for (const chunk of audioChunks) {
                        merged.set(new Uint8Array(chunk), offset);
                        offset += chunk.byteLength;
                    }
                    const base64 = uint8ToBase64(merged);
                    resolve({ base64, bytes: merged });
                } else {
                    reject(new Error(`Edge TTS closed unexpectedly (code ${event.code})`));
                }
            }
        };
    });
}

globalThis.EdgeTTS = { synthesize, escapeXml, generateSecMsGec, uint8ToBase64, buildSsml };
