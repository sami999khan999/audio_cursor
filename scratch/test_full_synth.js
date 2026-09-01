const crypto = require('crypto');
const fs = require('fs');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WINDOWS_FILE_TIME_EPOCH = 11644473600n;

async function generateSecMsGec() {
    const ticks = BigInt(Math.floor(Date.now() / 1000) + Number(WINDOWS_FILE_TIME_EPOCH));
    const roundedTicks = (ticks - (ticks % 300n)) * 10000000n;
    const strToHash = `${roundedTicks}${TRUSTED_CLIENT_TOKEN}`;
    const hash = crypto.createHash('sha256').update(strToHash).digest('hex').toUpperCase();
    return hash;
}

function buildSsml(text, voice = 'en-US-JennyNeural', rate = '+0%', pitch = '+0Hz') {
    const langMatch = voice.match(/^[a-z]{2,3}-[A-Z]{2,4}/);
    const locale = langMatch ? langMatch[0] : 'en-US';
    return `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${locale}">
    <voice name="${voice}">
        <prosody pitch="${pitch}" rate="${rate}" volume="+0%">
            ${text}
        </prosody>
    </voice>
</speak>`;
}

async function runFullSynthesis() {
    const secMsGec = await generateSecMsGec();
    const connId = '1234567890abcdef1234567890abcdef';
    const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=1-143.0.3650.96&ConnectionId=${connId}`;

    const ws = new WebSocket(wsUrl, {
        headers: {
            'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'
        }
    });
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        const ts = new Date().toISOString();
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
                            outputFormat: 'audio-24khz-48kbitrate-mono-mp3'
                        }
                    }
                }
            })
        );

        const ssml = buildSsml('Hello from Audio Cursor! Natural voices are working perfectly.');
        ws.send(
            `X-RequestId:12345678901234567890123456789012\r\n` +
            `Content-Type:application/ssml+xml\r\n` +
            `X-Timestamp:${ts}\r\n` +
            `Path:ssml\r\n\r\n` +
            ssml
        );
    };

    const audioBuffers = [];
    const AUDIO_DELIM = Buffer.from('Path:audio\r\n');

    ws.onmessage = async (e) => {
        let raw = e.data;
        if (raw instanceof Blob) {
            raw = await raw.arrayBuffer();
        }
        const buf = Buffer.from(raw);
        const str = buf.toString();

        if (str.includes('Path:turn.end')) {
            const totalAudio = Buffer.concat(audioBuffers);
            console.log('SUCCESS! Complete MP3 generated! Bytes:', totalAudio.length);
            fs.writeFileSync('scratch/test_out.mp3', totalAudio);
            console.log('Saved to scratch/test_out.mp3');
            ws.close();
        } else if (buf.includes(AUDIO_DELIM)) {
            const idx = buf.indexOf(AUDIO_DELIM) + AUDIO_DELIM.length;
            const audioData = buf.subarray(idx);
            audioBuffers.push(audioData);
        }
    };

    ws.onerror = (e) => console.log('WS error:', e);
}

runFullSynthesis();
