const crypto = require('crypto');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WINDOWS_FILE_TIME_EPOCH = 11644473600n;

async function generateSecMsGec() {
    const ticks = BigInt(Math.floor((Date.now() / 1000) + Number(WINDOWS_FILE_TIME_EPOCH))) * 10000000n;
    const roundedTicks = ticks - (ticks % 3000000000n);
    const strToHash = `${roundedTicks}${TRUSTED_CLIENT_TOKEN}`;
    const hash = crypto.createHash('sha256').update(strToHash).digest('hex').toUpperCase();
    return hash;
}

async function testWS() {
    const secMsGec = await generateSecMsGec();
    const connId = '1234567890abcdef1234567890abcdef';
    const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=1-130.0.2849.68&ConnectionId=${connId}`;
    console.log('Testing WebSocket URL:', wsUrl);

    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
        console.log('WebSocket connected successfully!');
        const ts = new Date().toISOString();
        ws.send('X-Timestamp:' + ts + '\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n' + JSON.stringify({
            context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: false, wordBoundaryEnabled: true }, outputFormat: 'audio-24khz-48kbitrate-mono-mp3' } } }
        }));

        const ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='en-US'><voice name='en-US-JennyNeural'><prosody rate='+0%' pitch='+0Hz'>Hello from browser extension!</prosody></voice></speak>";
        ws.send('X-RequestId:req123\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:' + ts + '\r\nPath:ssml\r\n\r\n' + ssml);
    };

    let audioLen = 0;
    ws.onmessage = (event) => {
        if (event.data instanceof ArrayBuffer) {
            audioLen += event.data.byteLength;
        } else if (typeof event.data === 'string') {
            if (event.data.includes('Path:turn.end')) {
                console.log('SUCCESS! Audio received, total raw bytes:', audioLen);
                ws.close();
            }
        }
    };

    ws.onerror = (err) => console.error('WS Error:', err);
}

testWS();
