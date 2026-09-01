const crypto = require('crypto');

const TRUSTED_CLIENT_TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';

function generateSecMsGec() {
    const ticks = Math.floor(Date.now() / 1000) + 11644473600;
    const rounded = ticks - (ticks % 300);
    const windowsTicks = rounded * 10000000;
    const str = `${windowsTicks}${TRUSTED_CLIENT_TOKEN}`;
    const hash = crypto.createHash('sha256').update(str).digest('hex').toUpperCase();
    return hash;
}

const VERSIONS = [
    '1-143.0.3650.96',
    '1-130.0.2849.68',
    '1-131.0.2903.86',
    '1-129.0.2792.89',
    '1-128.0.2739.79',
    '1-127.0.2651.105'
];

async function testVersion(version) {
    const secMsGec = generateSecMsGec();
    const connId = '1234567890abcdef1234567890abcdef';
    const wsUrl = `wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=${TRUSTED_CLIENT_TOKEN}&Sec-MS-GEC=${secMsGec}&Sec-MS-GEC-Version=${version}&ConnectionId=${connId}`;

    return new Promise((resolve) => {
        try {
            const ws = new WebSocket(wsUrl);
            ws.onopen = () => {
                console.log(`[Version ${version}] -> SUCCESS (200/101 Connected)`);
                ws.close();
                resolve(true);
            };
            ws.onerror = (e) => {
                console.log(`[Version ${version}] -> FAILED 403 or Error`);
                resolve(false);
            };
        } catch (e) {
            console.log(`[Version ${version}] -> Exception:`, e.message);
            resolve(false);
        }
    });
}

async function run() {
    console.log('Testing Edge TTS versions:');
    for (const v of VERSIONS) {
        await testVersion(v);
    }
}

run();
