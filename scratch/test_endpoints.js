const crypto = require('crypto');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WINDOWS_FILE_TIME_EPOCH = 11644473600n;

async function generateSecMsGec() {
    const ticks = BigInt(Math.floor(Date.now() / 1000) + Number(WINDOWS_FILE_TIME_EPOCH));
    const roundedTicks = (ticks - (ticks % 300n)) * 10000000n;
    const strToHash = `${roundedTicks}${TRUSTED_CLIENT_TOKEN}`;
    const hash = crypto.createHash('sha256').update(strToHash).digest('hex').toUpperCase();
    return hash;
}

async function testVariousEndpoints() {
    const secMsGec = await generateSecMsGec();
    const connId = '1234567890abcdef1234567890abcdef';
    
    // Test 1: standard query params
    const url1 = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=1-143.0.3650.96&ConnectionId=${connId}`;
    console.log('Testing url1:', url1);
    
    // Let's test with WebSocket
    try {
        const ws = new WebSocket(url1, {
            headers: {
                'Origin': 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0'
            }
        });
        
        ws.onopen = () => {
            console.log('Test 1 WS Connected!');
            ws.close();
        };
        ws.onerror = (e) => console.log('Test 1 WS Error:', e.message || e);
    } catch (e) {
        console.log('Test 1 failed to construct:', e.message);
    }
}

testVariousEndpoints();
