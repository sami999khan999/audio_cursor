const test = require('node:test');
const assert = require('node:assert');
const { chunkText, findMarkdownRegions, markdownForSpeech } = require('../src/chunk');

const PARA = 'Alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu. ';

/**
 * Chunk offsets drive the editor highlight and the scrub bar, so every chunk
 * list must tile the snapshot exactly once with no gaps and no overlaps.
 */
function assertCoversText(chunks, text) {
  if (chunks.length === 0) {
    assert.strictEqual(text.length, 0, 'only empty text may produce no chunks');
    return;
  }
  assert.strictEqual(chunks[0].start, 0, 'first chunk starts at 0');
  assert.strictEqual(chunks[chunks.length - 1].end, text.length, 'last chunk ends at text end');
  chunks.forEach((chunk, i) => {
    assert.strictEqual(chunk.index, i, 'indexes are sequential');
    assert.ok(chunk.end > chunk.start, 'chunks are non-empty');
    assert.strictEqual(chunk.text, text.substring(chunk.start, chunk.end), 'text matches its span');
    if (i > 0) {
      assert.strictEqual(chunk.start, chunks[i - 1].end, 'chunks are contiguous');
    }
  });
}

const spokenOf = (chunks) => chunks.map(c => c.spokenText).join('');

test('plain text is tiled exactly, with no silent chunks', () => {
  const text = 'The quick brown fox jumps over the lazy dog. '.repeat(60);
  const chunks = chunkText(text, 300, false, false);
  assertCoversText(chunks, text);
  assert.ok(chunks.length > 1, 'long text is split');
  assert.strictEqual(chunks.filter(c => !c.spokenText.trim()).length, 0);
});

test('terminal-style output survives chunking unchanged', () => {
  const text = '$ npm run build\nBuilt in 3.2s\nDone.\n';
  const chunks = chunkText(text, 300, false, false);
  assertCoversText(chunks, text);
  assert.strictEqual(spokenOf(chunks), text);
});

test('a chunk starting at a horizontal rule keeps the text after it', () => {
  // Regression: the front-matter rule had no `m` flag, so `^` matched the start
  // of the *chunk*. A chunk beginning at a `---` rule swallowed everything up
  // to the next one, silently dropping whole paragraphs.
  const md = [
    '# Guide', '', PARA.repeat(4), '', '---', '',
    PARA.repeat(2) + 'IMPORTANT SENTENCE ONE.', '', '---', '',
    PARA.repeat(2) + 'IMPORTANT SENTENCE TWO.'
  ].join('\n');

  const chunks = chunkText(md, 300, false, true);
  assertCoversText(chunks, md);
  const spoken = spokenOf(chunks);
  assert.match(spoken, /IMPORTANT SENTENCE ONE\./);
  assert.match(spoken, /IMPORTANT SENTENCE TWO\./);
});

test('a code block longer than the chunk size is announced once, never read out', () => {
  const code = 'const x = compute(1,2,3); // padding padding padding padding padding\n'.repeat(6);
  const md = 'Intro prose sentence.\n\n```js\n' + code + '```\n\nOutro prose sentence.';

  const chunks = chunkText(md, 300, false, true);
  assertCoversText(chunks, md);
  const spoken = spokenOf(chunks);
  assert.doesNotMatch(spoken, /compute\(1,2,3\)/, 'raw code is never spoken');
  assert.strictEqual(spoken.match(/Code block\./g).length, 1, 'announced exactly once');
  assert.match(spoken, /Intro prose sentence\./);
  assert.match(spoken, /Outro prose sentence\./);
});

test('an unterminated code fence runs to the end of the document', () => {
  const md = 'Intro.\n\n```js\nconst a = 1;\nconst b = 2;\n';
  const chunks = chunkText(md, 300, false, true);
  assertCoversText(chunks, md);
  assert.doesNotMatch(spokenOf(chunks), /const a = 1/);
});

test('front matter is dropped only at the top of the document', () => {
  const md = '---\ntitle: Doc\ntags: [a, b]\n---\n\nBody sentence that must be read.';
  const regions = findMarkdownRegions(md);
  assert.strictEqual(regions[0].start, 0);
  assert.strictEqual(regions[0].spoken, ' ');

  const chunks = chunkText(md, 300, false, true);
  assertCoversText(chunks, md);
  const spoken = spokenOf(chunks);
  assert.doesNotMatch(spoken, /title: Doc/);
  assert.match(spoken, /Body sentence that must be read\./);
});

test('a `<!-- -->` comment is dropped but code containing one is not', () => {
  const md = 'Before. <!-- hidden --> After.\n\n```\n<!-- this is code -->\n```\n';
  const chunks = chunkText(md, 300, false, true);
  assertCoversText(chunks, md);
  const spoken = spokenOf(chunks);
  assert.doesNotMatch(spoken, /hidden/);
  assert.match(spoken, /Before\./);
  assert.match(spoken, /After\./);
  assert.match(spoken, /Code block\./);
});

test('silent chunks are folded away so the queue is always audible', () => {
  const md = [
    '---', 'title: x', '---', '',
    PARA.repeat(3), '', '---', '', PARA.repeat(3), '',
    '| a | b |', '|---|---|', '| 1 | 2 |', '',
    PARA.repeat(3)
  ].join('\n');

  const chunks = chunkText(md, 300, false, true);
  assertCoversText(chunks, md);
  assert.strictEqual(
    chunks.filter(c => !c.spokenText.trim()).length,
    0,
    'no chunk is queued that would produce no audio'
  );
});

test('CRLF documents behave like LF ones', () => {
  const md = 'Line one.\r\nLine two.\r\n\r\n---\r\n\r\nLine three must survive.\r\n';
  const chunks = chunkText(md, 300, false, true);
  assertCoversText(chunks, md);
  assert.match(spokenOf(chunks), /Line three must survive\./);
});

test('an all-silent document still yields ordered, covering spans', () => {
  const md = '---\ntitle: only front matter\n---\n';
  const chunks = chunkText(md, 300, false, true);
  assertCoversText(chunks, md);
});

test('markdownForSpeech is safe on an arbitrary slice', () => {
  // It now runs per chunk with no whole-document rules left in it, so a slice
  // starting mid-construct must never delete surrounding prose.
  const slice = '---\nSection two must be read.\n\n---\n\nSection three must be read.\n';
  const out = markdownForSpeech(slice);
  assert.match(out, /Section two must be read\./);
  assert.match(out, /Section three must be read\./);
});

test('inline markdown is spoken as prose', () => {
  const out = markdownForSpeech('## A **bold** [link](http://x.y) and `code` and *em*.');
  assert.strictEqual(out.trim(), 'A bold link and code and em.');
});

test('chunkText tolerates junk input', () => {
  assert.deepStrictEqual(chunkText('', 300, false, true), []);
  assert.deepStrictEqual(chunkText(null, 300, false, true), []);
  assert.deepStrictEqual(chunkText(undefined), []);
});

test('no prose is lost from the repository\'s own Markdown', () => {
  // A canary over real documents: everything outside a region the rewriting is
  // *meant* to drop must still be spoken.
  const fs = require('fs');
  const path = require('path');
  const { findMarkdownRegions } = require('../src/chunk');

  for (const file of ['README.md', 'CHANGELOG.md']) {
    const text = fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

    let prose = '';
    let cursor = 0;
    for (const region of findMarkdownRegions(text)) {
      prose += text.slice(cursor, region.start);
      cursor = region.end;
    }
    prose += text.slice(cursor);
    // Link targets are deliberately reshaped into just their text.
    prose = prose.replace(/\]\([^)]*\)/g, ' ');

    const chunks = chunkText(text, 300, false, true);
    assertCoversText(chunks, text);

    const spoken = spokenOf(chunks);
    const lost = [...new Set(prose.match(/[A-Za-z]{5,}/g) || [])]
      .filter(word => !spoken.includes(word));
    assert.deepStrictEqual(lost, [], `${file}: words dropped from the spoken text`);
  }
});
