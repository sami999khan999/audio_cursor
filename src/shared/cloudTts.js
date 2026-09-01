// Audio Cursor — Cloud & Natural Speech Engine for Browser Extension
// Provides fast, reliable Natural Cloud speech synthesis with MP3 streaming.

const NATURAL_CLOUD_VOICES = [
    { name: 'cloud-en-US-1', cleanName: 'Google Natural (US)', lang: 'en-US', country: 'United States', flag: '🇺🇸', gender: 'Female', isNeural: true, langCode: 'en-US' },
    { name: 'cloud-en-GB-1', cleanName: 'Google Natural (UK)', lang: 'en-GB', country: 'United Kingdom', flag: '🇬🇧', gender: 'Female', isNeural: true, langCode: 'en-GB' },
    { name: 'cloud-en-AU-1', cleanName: 'Google Natural (AU)', lang: 'en-AU', country: 'Australia', flag: '🇦🇺', gender: 'Female', isNeural: true, langCode: 'en-AU' },
    { name: 'cloud-en-CA-1', cleanName: 'Google Natural (CA)', lang: 'en-CA', country: 'Canada', flag: '🇨🇦', gender: 'Female', isNeural: true, langCode: 'en-CA' },
    { name: 'cloud-en-IN-1', cleanName: 'Google Natural (IN)', lang: 'en-IN', country: 'India', flag: '🇮🇳', gender: 'Female', isNeural: true, langCode: 'en-IN' },
    { name: 'cloud-es-ES-1', cleanName: 'Google Natural (ES)', lang: 'es-ES', country: 'Spain', flag: '🇪🇸', gender: 'Female', isNeural: true, langCode: 'es-ES' },
    { name: 'cloud-es-MX-1', cleanName: 'Google Natural (MX)', lang: 'es-MX', country: 'Mexico', flag: '🇲🇽', gender: 'Female', isNeural: true, langCode: 'es-MX' },
    { name: 'cloud-fr-FR-1', cleanName: 'Google Natural (FR)', lang: 'fr-FR', country: 'France', flag: '🇫🇷', gender: 'Female', isNeural: true, langCode: 'fr-FR' },
    { name: 'cloud-fr-CA-1', cleanName: 'Google Natural (CA)', lang: 'fr-CA', country: 'Canada', flag: '🇨🇦', gender: 'Female', isNeural: true, langCode: 'fr-CA' },
    { name: 'cloud-de-DE-1', cleanName: 'Google Natural (DE)', lang: 'de-DE', country: 'Germany', flag: '🇩🇪', gender: 'Female', isNeural: true, langCode: 'de-DE' },
    { name: 'cloud-ja-JP-1', cleanName: 'Google Natural (JA)', lang: 'ja-JP', country: 'Japan', flag: '🇯🇵', gender: 'Female', isNeural: true, langCode: 'ja' },
    { name: 'cloud-zh-CN-1', cleanName: 'Google Natural (CN)', lang: 'zh-CN', country: 'China (Mandarin)', flag: '🇨🇳', gender: 'Female', isNeural: true, langCode: 'zh-CN' },
    { name: 'cloud-zh-TW-1', cleanName: 'Google Natural (TW)', lang: 'zh-TW', country: 'Taiwan', flag: '🇹🇼', gender: 'Female', isNeural: true, langCode: 'zh-TW' },
    { name: 'cloud-ko-KR-1', cleanName: 'Google Natural (KO)', lang: 'ko-KR', country: 'South Korea', flag: '🇰🇷', gender: 'Female', isNeural: true, langCode: 'ko' },
    { name: 'cloud-it-IT-1', cleanName: 'Google Natural (IT)', lang: 'it-IT', country: 'Italy', flag: '🇮🇹', gender: 'Female', isNeural: true, langCode: 'it' },
    { name: 'cloud-pt-BR-1', cleanName: 'Google Natural (BR)', lang: 'pt-BR', country: 'Brazil', flag: '🇧🇷', gender: 'Female', isNeural: true, langCode: 'pt-BR' },
    { name: 'cloud-pt-PT-1', cleanName: 'Google Natural (PT)', lang: 'pt-PT', country: 'Portugal', flag: '🇵🇹', gender: 'Female', isNeural: true, langCode: 'pt-PT' },
    { name: 'cloud-ru-RU-1', cleanName: 'Google Natural (RU)', lang: 'ru-RU', country: 'Russia', flag: '🇷🇺', gender: 'Female', isNeural: true, langCode: 'ru' },
    { name: 'cloud-hi-IN-1', cleanName: 'Google Natural (HI)', lang: 'hi-IN', country: 'India', flag: '🇮🇳', gender: 'Female', isNeural: true, langCode: 'hi' },
    { name: 'cloud-ar-SA-1', cleanName: 'Google Natural (AR)', lang: 'ar-SA', country: 'Arabic', flag: '🇸🇦', gender: 'Female', isNeural: true, langCode: 'ar' },
    { name: 'cloud-nl-NL-1', cleanName: 'Google Natural (NL)', lang: 'nl-NL', country: 'Netherlands', flag: '🇳🇱', gender: 'Female', isNeural: true, langCode: 'nl' },
    { name: 'cloud-pl-PL-1', cleanName: 'Google Natural (PL)', lang: 'pl-PL', country: 'Poland', flag: '🇵🇱', gender: 'Female', isNeural: true, langCode: 'pl' },
    { name: 'cloud-sv-SE-1', cleanName: 'Google Natural (SV)', lang: 'sv-SE', country: 'Sweden', flag: '🇸🇪', gender: 'Female', isNeural: true, langCode: 'sv' },
    { name: 'cloud-tr-TR-1', cleanName: 'Google Natural (TR)', lang: 'tr-TR', country: 'Turkey', flag: '🇹🇷', gender: 'Female', isNeural: true, langCode: 'tr' },
    { name: 'cloud-uk-UA-1', cleanName: 'Google Natural (UKR)', lang: 'uk-UA', country: 'Ukraine', flag: '🇺🇦', gender: 'Female', isNeural: true, langCode: 'uk' },
    { name: 'cloud-vi-VN-1', cleanName: 'Google Natural (VI)', lang: 'vi-VN', country: 'Vietnam', flag: '🇻🇳', gender: 'Female', isNeural: true, langCode: 'vi' },
    { name: 'cloud-id-ID-1', cleanName: 'Google Natural (ID)', lang: 'id-ID', country: 'Indonesia', flag: '🇮🇩', gender: 'Female', isNeural: true, langCode: 'id' },
    { name: 'cloud-th-TH-1', cleanName: 'Google Natural (TH)', lang: 'th-TH', country: 'Thailand', flag: '🇹🇭', gender: 'Female', isNeural: true, langCode: 'th' }
];

function uint8ToBase64(bytes) {
    let binary = '';
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

/**
 * Synthesize text using Google Cloud TTS endpoint.
 * Returns base64 MP3 string.
 * @param {string} text 
 * @param {string} langCode e.g. 'en-US' or 'es'
 * @returns {Promise<{ base64: string }>}
 */
async function synthesizeCloudAudio(text, langCode = 'en') {
    if (!text || !text.trim()) return { base64: '' };
    const clean = encodeURIComponent(text.trim().slice(0, 200));
    const url = `https://translate.google.com/translate_tts?ie=UTF-8&q=${clean}&tl=${langCode}&client=tw-ob`;
    
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Cloud TTS fetch failed: ${resp.status}`);
    const arrayBuffer = await resp.arrayBuffer();
    const base64 = uint8ToBase64(new Uint8Array(arrayBuffer));
    return { base64 };
}

globalThis.CloudTTS = {
    NATURAL_CLOUD_VOICES,
    synthesizeCloudAudio,
    uint8ToBase64
};
