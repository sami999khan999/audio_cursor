async function testBingHttp() {
    console.log('Testing Bing HTTP endpoints...');
    
    // Test 1: Bing Translator TTS
    try {
        const url = 'https://www.bing.com/tfettts?isVertical=1&&IG=0123456789ABCDEF0123456789ABCDEF&IID=translator.5028';
        const ssml = `<speak version='1.0' xml:lang='en-US'><voice xml:lang='en-US' name='en-US-JennyNeural'><prosody rate='0%' pitch='0%'>Hello this is a test</prosody></voice></speak>`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/ssml+xml',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
            },
            body: ssml
        });
        console.log('Bing tfettts response status:', resp.status, resp.statusText);
        if (resp.ok) {
            const buf = await resp.arrayBuffer();
            console.log('Bing tfettts SUCCESS! Bytes:', buf.byteLength);
        }
    } catch (e) {
        console.log('Bing tfettts error:', e.message);
    }
}

testBingHttp();
