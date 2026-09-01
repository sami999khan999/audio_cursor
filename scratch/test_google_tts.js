async function testGoogleTts() {
    console.log('Testing Google Translate TTS endpoint...');
    try {
        const url = 'https://translate.google.com/translate_tts?ie=UTF-8&q=Hello%20from%20Audio%20Cursor%20extension&tl=en&client=tw-ob';
        const resp = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0'
            }
        });
        console.log('Google TTS status:', resp.status, resp.statusText);
        if (resp.ok) {
            const buf = await resp.arrayBuffer();
            console.log('Google TTS SUCCESS! MP3 bytes received:', buf.byteLength);
        }
    } catch (e) {
        console.log('Google TTS error:', e.message);
    }
}

testGoogleTts();
