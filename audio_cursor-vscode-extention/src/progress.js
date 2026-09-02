/**
 * Exponential Moving Average (EMA) Progress Interpolator
 * Provides smooth progress estimation when TTS boundary events are sparse or absent.
 */

class ProgressTracker {
  constructor(alpha = 0.2) {
    this.alpha = alpha;
    this.reset();
  }

  reset() {
    this.lastCharIndex = 0;
    this.lastEventTime = 0;
    this.emaCps = 15; // default ~15 chars per second (~180 wpm)
    this.emaGap = 200; // default ~200ms between boundary events
    this.hasEvents = false;
    this.isPaused = false;
    this.pauseTime = 0;
  }

  /**
   * Called on every real boundary event from the speech engine.
   * @param {number} charIndex Current snapshot-global character offset.
   * @param {number} [now=Date.now()]
   */
  onEvent(charIndex, now = Date.now()) {
    if (this.lastEventTime > 0 && charIndex > this.lastCharIndex) {
      const dt = (now - this.lastEventTime) / 1000; // in seconds
      const dChar = charIndex - this.lastCharIndex;

      if (dt > 0.02 && dt < 5.0) {
        const instantCps = dChar / dt;
        this.emaCps = this.alpha * instantCps + (1 - this.alpha) * this.emaCps;

        const instantGap = (now - this.lastEventTime);
        this.emaGap = this.alpha * instantGap + (1 - this.alpha) * this.emaGap;
      }
    }

    this.lastCharIndex = charIndex;
    this.lastEventTime = now;
    this.hasEvents = true;
  }

  pause(now = Date.now()) {
    this.isPaused = true;
    this.pauseTime = now;
  }

  resume(now = Date.now()) {
    if (this.isPaused && this.lastEventTime > 0) {
      const pausedDuration = now - this.pauseTime;
      this.lastEventTime += pausedDuration;
    }
    this.isPaused = false;
  }

  /**
   * Get estimated character position at current timestamp.
   * @param {number} maxChar Total character count of snapshot.
   * @param {number} [now=Date.now()]
   * @returns {number}
   */
  getEstimatedChar(maxChar, now = Date.now()) {
    if (this.isPaused || this.lastEventTime === 0) {
      return this.lastCharIndex;
    }

    const elapsed = (now - this.lastEventTime) / 1000;
    const estimatedDelta = elapsed * this.emaCps;
    const estimatedChar = Math.floor(this.lastCharIndex + estimatedDelta);

    return Math.min(estimatedChar, maxChar);
  }
}

module.exports = {
  ProgressTracker
};
