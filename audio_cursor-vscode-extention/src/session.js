const { chunkText } = require('./chunk');

let nextSessionSeq = 1;

class Session {
  /**
   * @param {Object} snapshot Text snapshot
   * @param {Object} [options]
   * @param {number} [options.chunkSize=300]
   * @param {boolean} [options.sanitizeCode=false]
   * @param {boolean} [options.markdownProse=false] Speak markdown as prose
   */
  constructor(snapshot, options = {}) {
    this.id = String(Date.now()) + '-' + String(nextSessionSeq++);
    this.snapshot = snapshot;
    this.chunkSize = options.chunkSize || 300;
    this.sanitizeCode = options.sanitizeCode || false;
    this.markdownProse = options.markdownProse || false;

    this.chunks = chunkText(snapshot.text, this.chunkSize, this.sanitizeCode, this.markdownProse);
    this.queueHead = 0;
    this.cursorChunk = 0;
    this.cursorChar = 0;
    this.status = 'idle'; // 'idle' | 'starting' | 'playing' | 'paused' | 'stopped'
    this._sentenceStarts = null;
  }

  /**
   * Check if a message sessionId is stale
   * @param {string} sessionId
   * @returns {boolean}
   */
  isStale(sessionId) {
    return this.id !== sessionId;
  }

  /**
   * Retrieve the next `n` chunks for speech synthesis queue and advance queueHead.
   * @param {number} [n=12]
   * @returns {Array<import('./chunk').Chunk>}
   */
  nextWindow(n = 12) {
    if (this.queueHead >= this.chunks.length) {
      return [];
    }
    const end = Math.min(this.chunks.length, this.queueHead + n);
    const windowChunks = this.chunks.slice(this.queueHead, end);
    this.queueHead = end;
    return windowChunks;
  }

  /**
   * Seek playback to a specific snapshot char offset.
   * Finds the containing chunk, resets queue head, and generates a new sessionId.
   * @param {number} charIndex
   * @returns {{ chunkIndex: number, newSessionId: string }}
   */
  seekTo(charIndex) {
    const targetChar = Math.max(0, Math.min(charIndex, this.snapshot.text.length));
    let targetChunkIndex = 0;

    for (let i = 0; i < this.chunks.length; i++) {
      const c = this.chunks[i];
      if (targetChar >= c.start && targetChar <= c.end) {
        targetChunkIndex = i;
        break;
      }
      if (targetChar < c.start) {
        targetChunkIndex = Math.max(0, i - 1);
        break;
      }
    }

    this.cursorChar = targetChar;
    this.cursorChunk = targetChunkIndex;
    this.queueHead = targetChunkIndex;
    this.id = String(Date.now()) + '-' + String(nextSessionSeq++);

    return {
      chunkIndex: targetChunkIndex,
      newSessionId: this.id
    };
  }

  /**
   * Percentage progress (0.0 to 100.0)
   * @returns {number}
   */
  percent() {
    const total = this.snapshot.text.length;
    if (total <= 0) return 0;
    const p = (this.cursorChar / total) * 100;
    return Math.max(0, Math.min(100, Math.round(p * 10) / 10));
  }

  /**
   * Returns sorted list of sentence start character offsets in the snapshot text.
   * @returns {number[]}
   */
  sentenceBoundaries() {
    if (this._sentenceStarts !== null) {
      return this._sentenceStarts;
    }

    const text = this.snapshot.text;
    const starts = [0];
    const regex = /[.!?]+(?:\s+|\r?\n+)/g;
    let match;

    while ((match = regex.exec(text)) !== null) {
      const nextStart = match.index + match[0].length;
      if (nextStart < text.length && !starts.includes(nextStart)) {
        starts.push(nextStart);
      }
    }

    this._sentenceStarts = starts;
    return starts;
  }

  /**
   * Find next sentence start character offset after current position.
   * @param {number} [currentChar]
   * @returns {number}
   */
  findNextSentence(currentChar = this.cursorChar) {
    const bounds = this.sentenceBoundaries();
    for (let i = 0; i < bounds.length; i++) {
      if (bounds[i] > currentChar + 2) {
        return bounds[i];
      }
    }
    return this.snapshot.text.length;
  }

  /**
   * Find previous sentence start character offset before current position.
   * @param {number} [currentChar]
   * @returns {number}
   */
  findPreviousSentence(currentChar = this.cursorChar) {
    const bounds = this.sentenceBoundaries();
    for (let i = bounds.length - 1; i >= 0; i--) {
      if (bounds[i] < currentChar - 2) {
        return bounds[i];
      }
    }
    return 0;
  }
}

module.exports = {
  Session
};
