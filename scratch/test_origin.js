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

async function testWithOrigin(origin, label) {
    const secMsGec = await generateSecMsGec();
    const connId = '1234567890abcdef1234567890abcdef';
    const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=1-143.0.3650.96&ConnectionId=${connId}`;

    const headers = {};
    if (origin !== undefined) {
        headers['Origin'] = origin;
    }
    headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';

    return new Promise((resolve) => {
        try {
            const ws = new WebSocket(wsUrl, { headers });
            ws.onopen = () => {
                console.log(`[${label}] SUCCESS! (Origin: ${origin})`);
                ws.close();
                resolve(true);
            };
            ws.onerror = (e) => {
                console.log(`[${label}] FAILED! (Origin: ${origin})`);
                resolve(false);
            };
        } catch (e) {
            console.log(`[${label}] Constructor Error:`, e.message);
            resolve(false);
        }
    });
}

async function run() {
    console.log('Testing Origins:');
    await testWithOrigin('chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold', 'Edge Extension Origin');
    await testWithOrigin('chrome-extension://abcdefghijklmnopabcdefghijklmnop', 'Random Extension Origin');
    await testWithOrigin('', 'Empty Origin');
    await testWithOrigin('https://www.bing.com', 'Bing Origin');
    await testWithOrigin(undefined, 'No Origin Header');
}

run();
