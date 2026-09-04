/**
 * Speech pipeline that runs entirely in the extension host: synthesize each
 * chunk, hand the audio to the host player, map its position back to a
 * character offset. It is the counterpart of the queue inside the webview
 * player, for the platforms where audio can be played out here — which is
 * what lets the first read of a window start without a click in the panel.
 *
 * Events: `started` {chunkIndex}, `progress` {charIndex, chunkIndex},
 * `chunkEnded` {chunkIndex}, `ended`, `failure` {message}.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');
const log = require('./log');

// Back-off between attempts to delete a finished chunk's audio file.
const UNLINK_RETRY_MS = [150, 600, 2500];
// Audio older than this in the temp directory belongs to no live session.
const STALE_AUDIO_MS = 10 * 60 * 1000;

class HostSpeechEngine extends EventEmitter {
  /**
   * @param {import('./hostPlayer').HostAudioPlayer} player
   * @param {{ synthesize: (text: string, voice: string, rate: number, pitch: number) => Promise<{ audioBase64: string }> }} synthesizer
   */
  constructor(player, synthesizer) {
    super();
    this._player = player;
    this._synth = synthesizer;
    this._dir = path.join(os.tmpdir(), 'audio-cursor');

    /** @type {import('./session').Session | null} */
    this._session = null;
    this._voice = () => ({ voice: '', rate: 1.0, pitch: 1.0 });
    this._chunkIndex = 0;
    /** Token of the file the player is (or is about to be) playing. */
    this._activeToken = null;
    /** chunkIndex -> { token, file } for audio that is synthesized and on disk. */
    this._ready = new Map();
    /** chunkIndex -> Promise for synthesis in flight. */
    this._pending = new Map();
    this._paused = false;
    this._generation = 0;

    this._onStarted = (e) => this._handleStarted(e);
    this._onProgress = (e) => this._handleProgress(e);
    this._onEnded = (e) => this._handleEnded(e);
    this._onFailure = (e) => this._handleFailure(e);
    player.on('started', this._onStarted);
    player.on('progress', this._onProgress);
    player.on('ended', this._onEnded);
    player.on('failure', this._onFailure);
  }

  get isActive() {
    return this._session !== null;
  }

  /**
   * Begin reading `session` from its current cursor chunk.
   * @param {import('./session').Session} session
   * @param {() => { voice: string, rate: number, pitch: number }} getVoice
   *   Read at synthesis time, so a speed change applies from the next chunk.
   */
  start(session, getVoice) {
    this._reset();
    this._session = session;
    this._voice = getVoice;
    this._chunkIndex = session.cursorChunk || 0;
    this._playChunk(this._chunkIndex);
  }

  pause() {
    if (!this._session || this._paused) return;
    this._paused = true;
    this._player.pause();
  }

  resume() {
    if (!this._session || !this._paused) return;
    this._paused = false;
    this._player.resume();
  }

  stop() {
    if (!this._session) return;
    this._reset();
    this._player.stop();
  }

  /**
   * Jump to a character offset and continue from the chunk that contains it.
   * @param {number} charIndex
   */
  seek(charIndex) {
    const session = this._session;
    if (!session) return;
    const { chunkIndex } = session.seekTo(charIndex);
    const generation = ++this._generation;
    this._paused = false;
    this._activeToken = null;
    this._player.stop();
    this._chunkIndex = chunkIndex;
    // Anything synthesized for the old position is still valid — it is keyed
    // by chunk index — so keep it, and only start the new chunk.
    this._playChunk(chunkIndex, generation);
  }

  dispose() {
    this._reset();
    this._player.removeListener('started', this._onStarted);
    this._player.removeListener('progress', this._onProgress);
    this._player.removeListener('ended', this._onEnded);
    this._player.removeListener('failure', this._onFailure);
    this.removeAllListeners();
  }

  // --- internals -----------------------------------------------------------

  _reset() {
    this._generation++;
    this._session = null;
    this._activeToken = null;
    this._paused = false;
    for (const { file } of this._ready.values()) this._unlink(file);
    this._ready.clear();
    this._pending.clear();
  }

  /**
   * Delete an audio file, retrying a few times: WPF releases the file handle a
   * moment after `Close()`, so the first attempt right after `ended` can fail
   * with EBUSY on Windows.
   */
  _unlink(file, attempt = 0) {
    if (!file) return;
    fs.promises.unlink(file).catch((err) => {
      if (err && err.code === 'ENOENT') return;
      if (attempt >= UNLINK_RETRY_MS.length) {
        log.warn(`Could not remove temporary audio ${path.basename(file)}: ${err && err.message}`);
        return;
      }
      setTimeout(() => this._unlink(file, attempt + 1), UNLINK_RETRY_MS[attempt]);
    });
  }

  /**
   * Remove audio left behind by an earlier window that did not get to clean
   * up (a crash, a kill). Anything older than a few minutes cannot belong to a
   * live session.
   */
  async sweepStale() {
    let names;
    try {
      names = await fs.promises.readdir(this._dir);
    } catch (_) {
      return;
    }
    const cutoff = Date.now() - STALE_AUDIO_MS;
    for (const name of names) {
      if (!name.endsWith('.mp3')) continue;
      const file = path.join(this._dir, name);
      try {
        const stat = await fs.promises.stat(file);
        if (stat.mtimeMs < cutoff) await fs.promises.unlink(file);
      } catch (_) {}
    }
  }

  /** Text-to-speech for one chunk, written to disk; cached per chunk index. */
  _synthesize(index) {
    if (this._ready.has(index)) return Promise.resolve(this._ready.get(index));
    if (this._pending.has(index)) return this._pending.get(index);

    const session = this._session;
    const chunk = session && session.chunks[index];
    if (!chunk) return Promise.resolve(null);

    const text = chunk.spokenText || chunk.text;
    const generation = this._generation;
    const { voice, rate, pitch } = this._voice();

    const job = (async () => {
      if (!text || !text.trim()) return { token: null, file: null, silent: true };
      const { audioBase64 } = await this._synth.synthesize(text, voice, rate, pitch);
      if (generation !== this._generation) return null;
      if (!audioBase64) return { token: null, file: null, silent: true };

      await fs.promises.mkdir(this._dir, { recursive: true });
      const file = path.join(this._dir, `${session.id}-${index}.mp3`);
      await fs.promises.writeFile(file, Buffer.from(audioBase64, 'base64'));
      if (generation !== this._generation) {
        this._unlink(file);
        return null;
      }
      const entry = { token: this._player.nextToken(), file, silent: false };
      this._ready.set(index, entry);
      return entry;
    })();

    this._pending.set(index, job);
    // Not `.finally`: that derives a second promise which rejects along with
    // the job, and nobody would be there to catch it.
    const forget = () => { if (this._pending.get(index) === job) this._pending.delete(index); };
    job.then(forget, forget);
    return job;
  }

  async _playChunk(index, generation = this._generation) {
    const session = this._session;
    if (!session) return;

    if (index >= session.chunks.length) {
      this._reset();
      this.emit('ended');
      return;
    }

    let entry;
    try {
      entry = await this._synthesize(index);
    } catch (err) {
      if (generation !== this._generation) return;
      this._fail('Synthesis failed: ' + (err && err.message ? err.message : String(err)));
      return;
    }
    if (generation !== this._generation) return;
    if (!entry) return;

    if (entry.silent) {
      // Nothing to say here — move on, but keep the highlight honest.
      this.emit('chunkEnded', { chunkIndex: index });
      this._chunkIndex = index + 1;
      this._playChunk(index + 1, generation);
      return;
    }

    this._chunkIndex = index;
    this._activeToken = entry.token;
    if (!this._player.play(entry.token, entry.file)) {
      this._fail('The host audio player is not running.');
      return;
    }

    // Get the next chunk ready while this one speaks, and hand it to the
    // standby player as soon as it is on disk.
    this._prepareNext(index + 1, generation);
  }

  async _prepareNext(index, generation) {
    const session = this._session;
    if (!session || index >= session.chunks.length) return;
    let entry;
    try {
      entry = await this._synthesize(index);
    } catch (err) {
      // The chunk's own turn will retry and report properly.
      log.warn(`Pre-synthesis of chunk ${index} failed; will retry when it is due.`, err && err.message);
      return;
    }
    if (generation !== this._generation || !entry || entry.silent) return;
    if (this._chunkIndex === index - 1) {
      this._player.preload(entry.token, entry.file);
    }
  }

  _handleStarted(e) {
    if (!this._session || e.token !== this._activeToken) return;
    this.emit('started', { chunkIndex: this._chunkIndex });
  }

  _handleProgress(e) {
    const session = this._session;
    if (!session || e.token !== this._activeToken) return;
    // The player keeps ticking for a moment after `pause` is sent.
    if (this._paused) return;
    const chunk = session.chunks[this._chunkIndex];
    if (!chunk) return;
    const frac = e.duration > 0 ? Math.min(1, Math.max(0, e.position / e.duration)) : 0;
    const charIndex = chunk.start + Math.floor(frac * (chunk.end - chunk.start));
    session.cursorChar = charIndex;
    session.cursorChunk = this._chunkIndex;
    this.emit('progress', { charIndex, chunkIndex: this._chunkIndex });
  }

  _handleEnded(e) {
    const session = this._session;
    if (!session || e.token !== this._activeToken) return;
    const index = this._chunkIndex;
    const entry = this._ready.get(index);
    if (entry) {
      this._ready.delete(index);
      this._unlink(entry.file);
    }
    this._activeToken = null;
    this.emit('chunkEnded', { chunkIndex: index });
    this._playChunk(index + 1);
  }

  _handleFailure(e) {
    if (!this._session) return;
    if (e.token && e.token !== this._activeToken) return;
    this._fail(e.message || 'Audio playback failed.');
  }

  _fail(message) {
    this._reset();
    this._player.stop();
    this.emit('failure', { message });
  }
}

module.exports = { HostSpeechEngine };
