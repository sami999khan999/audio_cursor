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
 * Rewrite Markdown so it reads as prose instead of spelling out syntax.
 * Chunks are cut on the original text (offsets must stay valid for editor
 * highlighting), so this runs per chunk and also tolerates fences that were
 * split across a chunk boundary.
 *
 * @param {string} text
 * @returns {string}
 */
function markdownForSpeech(text) {
  if (!text) return '';
  return text
    // Front matter and comments carry nothing worth hearing
    .replace(/^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<!--[\s\S]*$/g, ' ')
    // Fenced code, whole or partial
    .replace(/```[\s\S]*?```/g, ' Code block. ')
    .replace(/~~~[\s\S]*?~~~/g, ' Code block. ')
    .replace(/```+[^\n]*/g, ' Code block. ')
    .replace(/~~~+[^\n]*/g, ' Code block. ')
    // Images and links: keep the words, drop the targets
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, (_m, alt) => (alt ? ` Image: ${alt}. ` : ' Image. '))
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
    .replace(/<https?:\/\/[^>]+>/g, ' link ')
    // Reference definitions and footnote markers
    .replace(/^\s{0,3}\[[^\]]+\]:\s*\S+.*$/gm, ' ')
    .replace(/\[\^[^\]]+\]/g, '')
    // Block syntax
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/[ \t]+#{1,6}[ \t]*$/gm, '')
    .replace(/^\s*(?:={3,}|-{3,})\s*$/gm, ' ')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/gm, ' ')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+[.)]\s+/gm, '')
    .replace(/^\s*\[[ xX]\]\s+/gm, '')
    // Tables read as comma-separated cells
    .replace(/^\s*\|?[\s:|-]{5,}\|?\s*$/gm, ' ')
    .replace(/[ 	]*\|[ 	]*/g, ', ')
    .replace(/^[ 	]*,[ 	]*/gm, '')
    .replace(/,[ 	]*$/gm, '')
    // Inline emphasis and code
    .replace(/`([^`]+)`/g, '$1')
    .replace(/(\*\*\*|___)(.+?)\1/g, '$2')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(?<![\w*])\*(?!\s)([^*\n]+?)(?<!\s)\*(?![\w*])/g, '$1')
    .replace(/~~(.+?)~~/g, '$1')
    // Leftover HTML and entities
    .replace(/<\/?[a-zA-Z][^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, ' and ')
    .replace(/&[a-z]+;/g, ' ')
    // A backslash escape keeps its character, not the backslash
    .replace(/\\([\\`*_{}\[\]()#+\-.!|>~])/g, '$1')
    // Whatever survived would be spelled out loud rather than spoken. Only
    // markers attached to words go: a lone " * " is arithmetic, not markup.
    .replace(/(?<=\S)[*#`~]+|[*#`~]+(?=\S)/g, '')
    .replace(/(^|\s)_+/g, '$1')
    .replace(/_+(?=\s|$)/g, '')
    // Tidy up
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
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
 * @param {boolean} [markdown=false] Speak Markdown as prose
 * @returns {Chunk[]}
 */
function chunkText(text, maxChunkSize = 300, sanitize = false, markdown = false) {
  if (!text || typeof text !== 'string') {
    return [];
  }

  const limit = Math.max(50, maxChunkSize || 300);
  const spoken = (chunkStr) => {
    let out = markdown ? markdownForSpeech(chunkStr) : chunkStr;
    if (sanitize) out = sanitizeForSpeech(out);
    return out;
  };
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
        spokenText: spoken(chunkStr),
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
      spokenText: spoken(chunkStr),
      start: offset,
      end: chunkEnd
    });

    offset = chunkEnd;
  }

  return chunks;
}

module.exports = {
  chunkText,
  sanitizeForSpeech,
  markdownForSpeech
};
