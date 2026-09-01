const https = require('https');

async function testFetch(url, options = {}) {
    try {
        const resp = await fetch(url, options);
        console.log(`URL: ${url} -> Status: ${resp.status} ${resp.statusText}`);
        const text = await resp.text();
        console.log(`Response (first 200 chars):`, text.slice(0, 200));
        return resp.status;
    } catch (e) {
        console.log(`URL: ${url} -> Error: ${e.message}`);
    }
}

async function run() {
    console.log('Testing HTTP endpoints for Edge / Bing TTS...');
    await testFetch('https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=6A5AA1D4EAFF4E9FB37E23D68491D6F4');
}

run();
