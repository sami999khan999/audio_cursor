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
 *
 * Chunks are cut on the original text (offsets must stay valid for editor
 * highlighting), so this runs per chunk — which means every rule in here must
 * be safe to apply to an arbitrary slice of a document. Constructs that can
 * only be recognised with whole-document context (front matter, fenced code,
 * HTML comments) are NOT handled here: `findMarkdownRegions` finds them across
 * the full text and `chunkText` keeps each one inside a chunk of its own.
 *
 * @param {string} text
 * @returns {string}
 */
function markdownForSpeech(text) {
  if (!text) return '';
  return text
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
 * @typedef {Object} MarkdownRegion
 * @property {number} start Inclusive offset into the full text
 * @property {number} end Exclusive offset into the full text
 * @property {string} spoken What is said in place of the region
 */

const FENCE_OPEN = /^[ \t]{0,3}(`{3,}|~{3,})(.*)$/;
const FRONT_MATTER_FENCE = /^---[ \t]*$/;
const FRONT_MATTER_CLOSE = /^(?:---|\.\.\.)[ \t]*$/;

/**
 * Find the spans of a Markdown document that can only be recognised with
 * whole-document context, and say what should be spoken in their place.
 *
 * These have to be found across the full text rather than per chunk: a fence
 * that opens in one chunk closes in another, and a `---` line is a horizontal
 * rule everywhere except at the very top of the document, where it opens front
 * matter. Applying either rule to an isolated slice silently deletes text or
 * reads a code block out loud — both of which it used to do.
 *
 * Regions are returned in order and never overlap.
 *
 * @param {string} text
 * @returns {MarkdownRegion[]}
 */
function findMarkdownRegions(text) {
  if (!text) return [];

  /** @type {MarkdownRegion[]} */
  const regions = [];

  // Offsets of the start of every line, plus a virtual line past the end.
  /** @type {Array<{ start: number, end: number, body: string }>} */
  const lines = [];
  {
    let lineStart = 0;
    for (let i = 0; i <= text.length; i++) {
      if (i === text.length || text[i] === '\n') {
        const raw = text.substring(lineStart, i);
        lines.push({
          start: lineStart,
          // `end` includes the newline, so regions consume their own line break.
          end: i === text.length ? i : i + 1,
          body: raw.endsWith('\r') ? raw.slice(0, -1) : raw
        });
        lineStart = i + 1;
      }
    }
  }

  let index = 0;

  // 1. Front matter, and only at the very top of the document.
  if (lines.length > 1 && FRONT_MATTER_FENCE.test(lines[0].body)) {
    for (let i = 1; i < lines.length; i++) {
      if (FRONT_MATTER_CLOSE.test(lines[i].body)) {
        regions.push({ start: 0, end: lines[i].end, spoken: ' ' });
        index = i + 1;
        break;
      }
    }
  }

  // 2. Fenced code blocks, including one left unterminated at the end of file.
  for (; index < lines.length; index++) {
    const open = FENCE_OPEN.exec(lines[index].body);
    if (!open) continue;

    const marker = open[1];
    const char = marker[0];
    const startOffset = lines[index].start;
    let endOffset = text.length;

    for (let j = index + 1; j < lines.length; j++) {
      const close = FENCE_OPEN.exec(lines[j].body);
      // A closing fence is the same character, at least as long, and carries
      // no info string of its own.
      if (close && close[1][0] === char && close[1].length >= marker.length && !close[2].trim()) {
        endOffset = lines[j].end;
        index = j;
        break;
      }
      if (j === lines.length - 1) {
        index = j;
      }
    }

    regions.push({ start: startOffset, end: endOffset, spoken: ' Code block. ' });
  }

  // 3. HTML comments, but only in the gaps left by the regions above — a
  //    `<!--` inside a code block is code, not a comment.
  /** @type {MarkdownRegion[]} */
  const comments = [];
  let gapStart = 0;
  const gaps = [];
  for (const region of regions) {
    if (region.start > gapStart) gaps.push([gapStart, region.start]);
    gapStart = region.end;
  }
  if (gapStart < text.length) gaps.push([gapStart, text.length]);

  for (const [from, to] of gaps) {
    let cursor = from;
    while (cursor < to) {
      const open = text.indexOf('<!--', cursor);
      if (open === -1 || open >= to) break;
      const close = text.indexOf('-->', open + 4);
      // An unterminated comment swallows the rest of its gap, which is what a
      // Markdown renderer does with it too.
      const end = close === -1 || close + 3 > to ? to : close + 3;
      comments.push({ start: open, end, spoken: ' ' });
      cursor = end;
    }
  }

  return [...regions, ...comments].sort((a, b) => a.start - b.start);
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
 * Pick the best place to cut `text` within [from, from + limit).
 * @returns {number} An absolute offset strictly greater than `from`.
 */
function findSplitPoint(text, from, to, limit) {
  const windowText = text.substring(from, Math.min(to, from + limit));
  let match;

  // 1. Sentence break: period/exclamation/question followed by space or newline
  const sentenceRegex = /[.!?]+(?:\s+|\r?\n+)/g;
  let lastSentenceEnd = -1;
  while ((match = sentenceRegex.exec(windowText)) !== null) {
    lastSentenceEnd = match.index + match[0].length;
  }
  if (lastSentenceEnd > 20) return from + lastSentenceEnd;

  // 2. Line break
  const lineBreakRegex = /\r?\n+/g;
  let lastLineBreak = -1;
  while ((match = lineBreakRegex.exec(windowText)) !== null) {
    lastLineBreak = match.index + match[0].length;
  }
  if (lastLineBreak > 10) return from + lastLineBreak;

  // 3. Word break
  const spaceRegex = /\s+/g;
  let lastSpace = -1;
  while ((match = spaceRegex.exec(windowText)) !== null) {
    lastSpace = match.index + match[0].length;
  }
  if (lastSpace > 0) return from + lastSpace;

  // 4. Hard cut
  return Math.min(to, from + limit);
}

/**
 * A chunk that would be silent adds a round trip to the synthesizer and a
 * needless hand-off in the player queue, and an empty synthesis result used to
 * be mistaken for a decode failure. Fold every silent chunk into a neighbour so
 * the queue only ever carries audible work, while the spans stay contiguous and
 * still cover the whole snapshot.
 *
 * @param {Chunk[]} chunks
 * @param {string} text
 * @returns {Chunk[]}
 */
function absorbSilentChunks(chunks, text) {
  if (chunks.length < 2) return chunks;

  const isSilent = (c) => !c.spokenText || !c.spokenText.trim();
  // Nothing here is audible; leave the list alone so the caller still sees a
  // complete, ordered set of spans rather than an empty read.
  if (chunks.every(isSilent)) return chunks;

  /** @type {Chunk[]} */
  const out = [];
  /** @type {Chunk | null} */
  let carried = null;

  for (const chunk of chunks) {
    if (isSilent(chunk)) {
      if (out.length > 0) {
        // Extend the previous audible chunk over the silence.
        const prev = out[out.length - 1];
        prev.end = chunk.end;
        prev.text = text.substring(prev.start, prev.end);
      } else {
        // Leading silence has no previous chunk: hand it to the next one.
        carried = carried || chunk;
      }
      continue;
    }

    if (carried) {
      chunk.start = carried.start;
      chunk.text = text.substring(chunk.start, chunk.end);
      carried = null;
    }
    out.push(chunk);
  }

  return out.map((chunk, index) => ({ ...chunk, index }));
}

/**
 * Split text into chunks <= maxChunkSize characters.
 * Guarantees that chunks cover the full span from 0 to text.length, because
 * `start`/`end` are offsets into the snapshot that the editor highlight and the
 * scrub bar are both driven from.
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

  /** @type {Chunk[]} */
  const chunks = [];
  const push = (start, end, spokenText) => {
    if (end <= start) return;
    chunks.push({
      index: chunks.length,
      text: text.substring(start, end),
      spokenText,
      start,
      end
    });
  };

  // Whole-document constructs become chunks of their own, so no ordinary chunk
  // ever contains half a code fence or half a front-matter block.
  const regions = markdown ? findMarkdownRegions(text) : [];
  let cursor = 0;

  const chunkPlainSpan = (from, to) => {
    let offset = from;
    while (offset < to) {
      const end = (to - offset <= limit) ? to : findSplitPoint(text, offset, to, limit);
      const safeEnd = end > offset ? end : Math.min(to, offset + limit);
      push(offset, safeEnd, spoken(text.substring(offset, safeEnd)));
      offset = safeEnd;
    }
  };

  for (const region of regions) {
    if (region.start > cursor) chunkPlainSpan(cursor, region.start);
    push(region.start, region.end, region.spoken);
    cursor = Math.max(cursor, region.end);
  }
  chunkPlainSpan(cursor, text.length);

  return absorbSilentChunks(chunks, text);
}

module.exports = {
  chunkText,
  findMarkdownRegions,
  sanitizeForSpeech,
  markdownForSpeech
};
