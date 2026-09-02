/**
 * Audio Cursor Text Chunking
 * Splits text into TTS-friendly chunks respecting sentence, paragraph, and word boundaries.
 */

function sanitizeForSpeech(text) {
  if (!text) return '';
  return text
    .replace(/===\s*/g, ' strictly equals ')
    .replace(/!==\s*/g, ' not strictly equals ')
    .replace(/==\s*/g, ' equals ')
    .replace(/!=\s*/g, ' not equals ')
    .replace(/=>\s*/g, ' arrow ')
    .replace(/&&/g, ' and ')
    .replace(/\|\|/g, ' or ')
    .replace(/\+\+/g, ' plus plus ')
    .replace(/--/g, ' minus minus ')
    .replace(/\/\/\s*/g, ' comment: ')
    .replace(/[{}\[\]()<>]/g, ' ')
    .replace(/[-_]{3,}/g, ' ')
    .replace(/\s+/g, ' ');
}

/**
 * @typedef {Object} Chunk
 * @property {number} index
 * @property {string} text
 * @property {number} start
 * @property {number} end
 * @property {string} [spokenText]
 */

/**
 * Split text into chunks <= maxChunkSize characters.
 * Guarantees that chunks cover the full span from 0 to text.length.
 *
 * @param {string} text
 * @param {number} [maxChunkSize=300]
 * @param {boolean} [sanitize=false]
 * @returns {Chunk[]}
 */
function chunkText(text, maxChunkSize = 300, sanitize = false) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const limit = Math.max(50, maxChunkSize || 300);
  const chunks = [];
  let offset = 0;
  const totalLength = text.length;

  while (offset < totalLength) {
    const remaining = totalLength - offset;
    if (remaining <= limit) {
      const chunkStr = text.substring(offset, totalLength);
      chunks.push({
        index: chunks.length,
        text: chunkStr,
        spokenText: sanitize ? sanitizeForSpeech(chunkStr) : chunkStr,
        start: offset,
        end: totalLength
      });
      break;
    }

    const windowText = text.substring(offset, offset + limit);
    let splitIndex = -1;

    // 1. Try sentence break: period/exclamation/question followed by space or newline
    const sentenceRegex = /[.!?]+(?:\s+|\r?\n+)/g;
    let match;
    let lastSentenceEnd = -1;
    while ((match = sentenceRegex.exec(windowText)) !== null) {
      lastSentenceEnd = match.index + match[0].length;
    }
    if (lastSentenceEnd > 20) {
      splitIndex = lastSentenceEnd;
    }

    // 2. Try line break
    if (splitIndex === -1) {
      const lineBreakRegex = /\r?\n+/g;
      let lastLineBreak = -1;
      while ((match = lineBreakRegex.exec(windowText)) !== null) {
        lastLineBreak = match.index + match[0].length;
      }
      if (lastLineBreak > 10) {
        splitIndex = lastLineBreak;
      }
    }

    // 3. Try word break (whitespace)
    if (splitIndex === -1) {
      const spaceRegex = /\s+/g;
      let lastSpace = -1;
      while ((match = spaceRegex.exec(windowText)) !== null) {
        lastSpace = match.index + match[0].length;
      }
      if (lastSpace > 0) {
        splitIndex = lastSpace;
      }
    }

    // 4. Fallback: hard cut
    if (splitIndex === -1 || splitIndex <= 0) {
      splitIndex = limit;
    }

    const chunkEnd = offset + splitIndex;
    const chunkStr = text.substring(offset, chunkEnd);

    chunks.push({
      index: chunks.length,
      text: chunkStr,
      spokenText: sanitize ? sanitizeForSpeech(chunkStr) : chunkStr,
      start: offset,
      end: chunkEnd
    });

    offset = chunkEnd;
  }

  return chunks;
}

module.exports = {
  chunkText,
  sanitizeForSpeech
};
