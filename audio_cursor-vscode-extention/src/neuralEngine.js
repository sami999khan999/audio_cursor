const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');
const log = require('./log');
const defaultVoices = require('./voices.json');

/**
 * Escapes XML special characters for safe inclusion in SSML.
 * @param {string} text
 * @returns {string}
 */
function escapeXml(text) {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

class NeuralSpeechEngine {
  constructor() {
    this._tts = new MsEdgeTTS();
    this._voicesCache = defaultVoices;
    this._voicesPromise = null;
  }

  /**
   * Synchronously return cached neural voices (available instantly on startup)
   * @returns {Array<Object>}
   */
  getVoicesSync() {
    return this._voicesCache || defaultVoices;
  }

  /**
   * Fetch and format all available Edge Natural Neural voices
   * @returns {Promise<Array<Object>>}
   */
  async getVoices() {
    if (this._voicesCache && this._voicesCache.length > 0) {
      return this._voicesCache;
    }

    if (this._voicesPromise) {
      return this._voicesPromise;
    }

    this._voicesPromise = (async () => {
      try {
        const rawVoices = await this._tts.getVoices();
        const formatted = rawVoices.map(v => {
          const isFemale = v.Gender === 'Female';
          const locale = v.Locale || 'en-US';
          const displayName = v.FriendlyName || v.ShortName;
          const shortName = v.ShortName;

          return {
            name: shortName,
            displayName: `${shortName} (${v.Gender})`,
            friendlyName: displayName,
            lang: locale,
            gender: v.Gender,
            isNeural: true,
            default: shortName === 'en-US-JennyNeural',
            localService: false,
            voiceURI: shortName
          };
        });

        formatted.sort((a, b) => {
          const aEn = a.lang.startsWith('en-');
          const bEn = b.lang.startsWith('en-');
          if (aEn && !bEn) return -1;
          if (!aEn && bEn) return 1;
          if (a.lang !== b.lang) return a.lang.localeCompare(b.lang);
          return a.name.localeCompare(b.name);
        });

        this._voicesCache = formatted;
        log.info(`Loaded ${formatted.length} Natural Neural voices from Edge TTS engine`);
        return formatted;
      } catch (err) {
        log.warn('Using bundled Edge Neural voices:', err);
        return defaultVoices;
      } finally {
        this._voicesPromise = null;
      }
    })();

    return this._voicesPromise;
  }

  /**
   * Synthesize text chunk to base64 MP3 audio with automatic XML escaping and retries
   * @param {string} text
   * @param {string} voice
   * @param {number} [rate=1.0]
   * @param {number} [pitch=1.0]
   * @param {number} [retries=2]
   * @returns {Promise<{ audioBase64: string }>}
   */
  async synthesize(text, voice = 'en-US-JennyNeural', rate = 1.0, pitch = 1.0, retries = 2) {
    if (!text || !text.trim()) {
      return { audioBase64: '' };
    }

    const safeText = escapeXml(text);
    const ratePercent = rate >= 1.0 ? `+${Math.round((rate - 1.0) * 100)}%` : `-${Math.round((1.0 - rate) * 100)}%`;
    const pitchHz = pitch >= 1.0 ? `+${Math.round((pitch - 1.0) * 50)}Hz` : `-${Math.round((1.0 - pitch) * 50)}Hz`;

    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const tts = new MsEdgeTTS();
        await tts.setMetadata(voice || 'en-US-JennyNeural', OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);

        const { audioStream } = tts.toStream(safeText, {
          rate: ratePercent,
          pitch: pitchHz
        });

        const chunks = [];
        const base64 = await new Promise((resolve, reject) => {
          audioStream.on('data', chunk => chunks.push(chunk));
          audioStream.on('end', () => {
            const totalBuffer = Buffer.concat(chunks);
            resolve(totalBuffer.toString('base64'));
          });
          audioStream.on('error', err => reject(err));
        });

        return { audioBase64: base64 };
      } catch (err) {
        if (attempt < retries) {
          log.warn(`Synthesis attempt ${attempt + 1} failed, retrying... Error: ${err.message}`);
          await new Promise(r => setTimeout(r, 250));
        } else {
          log.error(`Neural synthesis failed after ${retries + 1} attempts for voice ${voice}:`, err.message);
          throw err;
        }
      }
    }
  }
}

const neuralEngine = new NeuralSpeechEngine();

module.exports = {
  escapeXml,
  neuralEngine,
  NeuralSpeechEngine
};
