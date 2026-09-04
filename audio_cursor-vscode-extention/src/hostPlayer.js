/**
 * Audio playback in the extension host, outside any webview.
 *
 * VS Code creates its window with Chromium's `autoplayPolicy` set to
 * `user-gesture-required`, so a webview may not make a sound until its
 * document has been clicked — and Alt+P, handled by the workbench, never
 * counts. That made the first read of every window silent until the sidebar
 * was clicked. Nothing an extension does inside the panel can lift that.
 *
 * So on Windows the audio is played here instead, by a small PowerShell
 * process hosting two WPF `MediaPlayer`s. It is started once and kept alive:
 * it reads one JSON command per line on stdin and reports one JSON event per
 * line on stdout, including a position tick every ~40 ms while playing, which
 * is what drives the word highlight. Two players so the next chunk can be
 * opened while the current one is still speaking; opening takes a few hundred
 * milliseconds, which would otherwise be a gap between every chunk.
 *
 * The webview stays the UI; it just no longer owns the speaker. Other
 * platforms fall back to the webview engine (see `isSupported`).
 */

const { spawn } = require('child_process');
const { EventEmitter } = require('events');
const log = require('./log');

// The stdin reader is a real StreamReader over the raw handle, because
// Console.In's ReadLineAsync is synchronous on .NET Framework and would stall
// the loop. The script itself is passed as an encoded command, not on stdin:
// with `-Command -` PowerShell keeps reading stdin as *script* and swallows
// every command sent after it.
const DAEMON_SCRIPT = `
$ErrorActionPreference = 'Continue'
Add-Type -AssemblyName PresentationCore
$out = [Console]::Out
function Emit($obj) { $out.WriteLine((ConvertTo-Json -Compress -InputObject $obj)); $out.Flush() }
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$pending = $stdin.ReadLineAsync()
$players = @((New-Object System.Windows.Media.MediaPlayer), (New-Object System.Windows.Media.MediaPlayer))
foreach ($pl in $players) { $pl.Volume = 1.0 }
$cur = 0
$p = $players[0]
$token = ''
$preToken = ''
$playing = $false
$dur = 0.0
Emit @{ event = 'ready' }
while ($true) {
  if ($pending.IsCompleted) {
    $line = $pending.Result
    if ($null -eq $line) { break }
    $pending = $stdin.ReadLineAsync()
    try {
      $cmd = ConvertFrom-Json $line
      switch ($cmd.op) {
        'preload' {
          $sb = $players[1 - $cur]
          $sb.Stop(); $sb.Close()
          $preToken = [string]$cmd.token
          $sb.Open([Uri]::new([string]$cmd.file))
        }
        'play' {
          $p.Stop(); $p.Close()
          $token = [string]$cmd.token
          if ($preToken -ne '' -and $token -eq $preToken) {
            $cur = 1 - $cur
            $p = $players[$cur]
          } else {
            $p.Open([Uri]::new([string]$cmd.file))
          }
          $preToken = ''
          $sw = [Diagnostics.Stopwatch]::StartNew()
          while (-not $p.NaturalDuration.HasTimeSpan -and $sw.ElapsedMilliseconds -lt 8000) { Start-Sleep -Milliseconds 5 }
          if (-not $p.NaturalDuration.HasTimeSpan) {
            Emit @{ event = 'failure'; token = $token; message = 'The audio file could not be opened.' }
            $token = ''
          } else {
            $dur = $p.NaturalDuration.TimeSpan.TotalSeconds
            $p.Position = [TimeSpan]::Zero
            $p.Play()
            $playing = $true
            Emit @{ event = 'started'; token = $token; duration = $dur; openMs = $sw.ElapsedMilliseconds }
          }
        }
        'pause'  { if ($token) { $p.Pause(); $playing = $false; Emit @{ event = 'paused'; token = $token; position = $p.Position.TotalSeconds } } }
        'resume' { if ($token) { $p.Play(); $playing = $true; Emit @{ event = 'resumed'; token = $token } } }
        'stop'   {
          foreach ($pl in $players) { $pl.Stop(); $pl.Close() }
          if ($token) { Emit @{ event = 'stopped'; token = $token } }
          $token = ''; $preToken = ''; $playing = $false
        }
        'volume' { foreach ($pl in $players) { $pl.Volume = [double]$cmd.value } }
        'quit'   { break }
      }
    } catch {
      Emit @{ event = 'failure'; token = $token; message = $_.Exception.Message }
    }
  }
  if ($playing -and $token) {
    $pos = $p.Position.TotalSeconds
    if ($dur -gt 0 -and $pos -ge ($dur - 0.03)) {
      $playing = $false
      $t = $token
      $token = ''
      $p.Stop(); $p.Close()
      Emit @{ event = 'ended'; token = $t }
    } else {
      Emit @{ event = 'progress'; token = $token; position = $pos; duration = $dur }
    }
  }
  Start-Sleep -Milliseconds 40
}
foreach ($pl in $players) { $pl.Stop(); $pl.Close() }
`;

const READY_TIMEOUT_MS = 15000;

/**
 * Events (all carry `token`): `started` {duration}, `progress` {position,
 * duration}, `paused` {position}, `resumed`, `stopped`, `ended`, `failure`
 * {message}. Named `failure` rather than `error` on purpose: Node throws on an
 * unhandled `error` event, and a late one from a process that is being torn
 * down must never take the extension host down with it.
 */
class HostAudioPlayer extends EventEmitter {
  /** Whether this platform has a host-side player at all. */
  static isSupported() {
    return process.platform === 'win32';
  }

  constructor() {
    super();
    /** @type {import('child_process').ChildProcess | null} */
    this._proc = null;
    /** @type {Promise<boolean> | null} */
    this._starting = null;
    this._ready = false;
    this._disposed = false;
    this._buffer = '';
    this._tokenSeq = 0;
    this._currentToken = null;
  }

  isReady() {
    return this._ready && this._proc !== null;
  }

  /**
   * Start the daemon if it is not running. Resolves false if it cannot be
   * started, in which case the caller falls back to the webview engine.
   * @returns {Promise<boolean>}
   */
  ensureStarted() {
    if (this._disposed) return Promise.resolve(false);
    if (this.isReady()) return Promise.resolve(true);
    if (this._starting) return this._starting;

    this._starting = new Promise((resolve) => {
      let settled = false;
      const done = (ok) => {
        if (settled) return;
        settled = true;
        this._starting = null;
        resolve(ok);
      };

      let proc;
      try {
        // Windows PowerShell is always present; -STA because WPF objects must
        // live on a single-threaded apartment.
        const encoded = Buffer.from(DAEMON_SCRIPT, 'utf16le').toString('base64');
        proc = spawn('powershell.exe', [
          '-NoProfile', '-NonInteractive', '-NoLogo', '-STA', '-ExecutionPolicy', 'Bypass',
          '-EncodedCommand', encoded
        ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (err) {
        log.warn('Host audio player could not be spawned:', err);
        done(false);
        return;
      }

      this._proc = proc;
      this._ready = false;
      this._buffer = '';

      const timer = setTimeout(() => {
        log.warn(`Host audio player did not report ready within ${READY_TIMEOUT_MS}ms; using the panel engine.`);
        this._kill();
        done(false);
      }, READY_TIMEOUT_MS);

      proc.stdout.setEncoding('utf8');
      proc.stdout.on('data', (chunk) => {
        this._buffer += chunk;
        let nl;
        while ((nl = this._buffer.indexOf('\n')) >= 0) {
          const line = this._buffer.slice(0, nl).trim();
          this._buffer = this._buffer.slice(nl + 1);
          if (!line) continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch (_) {
            log.warn('Host audio player said something that was not JSON: ' + line);
            continue;
          }
          if (msg.event === 'ready') {
            clearTimeout(timer);
            this._ready = true;
            log.info('Host audio player is ready (PowerShell + WPF MediaPlayer).');
            done(true);
            continue;
          }
          if (msg.event === 'ended' || msg.event === 'stopped' || msg.event === 'failure') {
            if (msg.token === this._currentToken) this._currentToken = null;
          }
          this.emit(msg.event, msg);
        }
      });

      proc.stderr.setEncoding('utf8');
      proc.stderr.on('data', (text) => {
        const line = String(text).trim();
        if (line) log.warn('Host audio player stderr: ' + line);
      });

      proc.on('error', (err) => {
        log.warn('Host audio player process error:', err);
        clearTimeout(timer);
        this._proc = null;
        this._ready = false;
        done(false);
      });

      proc.on('exit', (code) => {
        log.info(`Host audio player exited (code ${code}).`);
        clearTimeout(timer);
        this._proc = null;
        this._ready = false;
        const token = this._currentToken;
        this._currentToken = null;
        if (token && !this._disposed) {
          this.emit('failure', { token, message: 'The audio player process exited.' });
        }
        done(false);
      });
    });

    return this._starting;
  }

  _send(cmd) {
    if (!this._proc || !this._proc.stdin.writable) return false;
    try {
      this._proc.stdin.write(JSON.stringify(cmd) + '\n');
      return true;
    } catch (err) {
      log.warn('Could not send to the host audio player:', err);
      return false;
    }
  }

  /** A fresh token for a file that is about to be preloaded or played. */
  nextToken() {
    return 't' + (++this._tokenSeq);
  }

  /**
   * Open a file on the standby player so that a later `play` with the same
   * token starts instantly.
   * @param {string} token
   * @param {string} filePath
   */
  preload(token, filePath) {
    this._send({ op: 'preload', token, file: filePath });
  }

  /**
   * Play a file. Events for it carry the token, so a late event from a
   * superseded file can be told apart from the current one.
   * @param {string} token
   * @param {string} filePath
   * @returns {boolean} whether the command could be sent
   */
  play(token, filePath) {
    this._currentToken = token;
    return this._send({ op: 'play', token, file: filePath });
  }

  pause() { this._send({ op: 'pause' }); }
  resume() { this._send({ op: 'resume' }); }

  stop() {
    this._currentToken = null;
    this._send({ op: 'stop' });
  }

  _kill() {
    const proc = this._proc;
    this._proc = null;
    this._ready = false;
    if (!proc) return;
    try { proc.stdin.end(); } catch (_) {}
    try { proc.kill(); } catch (_) {}
  }

  dispose() {
    this._disposed = true;
    this._send({ op: 'quit' });
    this._kill();
    this.removeAllListeners();
  }
}

module.exports = { HostAudioPlayer };
