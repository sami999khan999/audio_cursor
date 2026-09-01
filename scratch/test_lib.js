const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

async function testLib() {
    const tts = new MsEdgeTTS({ enableLogger: true });
    await tts.setMetadata('en-US-JennyNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = tts.toStream('Testing msedge-tts connection');
    audioStream.on('data', (d) => console.log('Received chunk:', d.length));
    audioStream.on('end', () => console.log('Synthesis finished!'));
    audioStream.on('error', (e) => console.error('Synthesis error:', e));
}

testLib();
