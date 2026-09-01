async function synthesizeGoogle(text, lang = 'en') {
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${encodeURIComponent(text)}&tl=${lang}&client=tw-ob`;
    const resp = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return Buffer.from(await resp.arrayBuffer());
}

async function testFullText() {
    const chunks = [
        'Welcome to Audio Cursor for your browser.',
        'This natural cloud voice reads text aloud seamlessly.',
        'Enjoy reading any article or documentation with zero errors.'
    ];
    
    console.log('Testing streaming synthesis for', chunks.length, 'chunks...');
    for (let i = 0; i < chunks.length; i++) {
        const buf = await synthesizeGoogle(chunks[i], 'en');
        console.log(`Chunk ${i} synthesized: ${buf.length} bytes`);
    }
    console.log('ALL CHUNKS SYNTHESIZED SUCCESSFULLY!');
}

testFullText();
