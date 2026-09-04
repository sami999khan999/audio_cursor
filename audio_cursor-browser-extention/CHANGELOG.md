# Changelog

All notable changes to the Audio Cursor browser extension are documented here.

## [2.2.1]

### Changed
- **One mark for both extensions.** The browser extension drew a mouse-pointer arrow with sound
  arcs while the VS Code extension used an I-beam text cursor with a waveform — two different
  logos for one product, on the same dark squircle in the same indigo-to-sky palette, so they read
  as related but not the same. The I-beam mark is now used in both: the toolbar and store icons
  (16/32/48/128 and the 512 listing logo, all re-rendered from `src/icons/icon.svg`) and the
  popup header. It is the artwork already shipping as the VS Code extension's Marketplace icon,
  down to the framing, so the two listings show one icon at two sizes.

### Fixed
- **A voice preview from the Voice Library gave no sign it was playing.** Pressing *Preview* on a
  row started audio and changed nothing on screen: no way to tell which of 325 voices was
  speaking, and nothing to press to stop it. The row's button now shows the state and turns into
  the stop control, matching the header *Preview* button, and a second press stops it. Starting
  another preview — from either place — clears the previous indicator, since only one plays at a
  time. The state survives the list being re-filtered, because it is tracked by voice rather than
  by the button element the list rebuilds.
- **"Stop preview" no longer appears while the preview is still silent.** The header button turned
  red the instant it was pressed, but a Natural AI voice is synthesized over the network and takes
  a moment, so the button offered to stop something that had not started. Both buttons now show
  *Loading…* until sound actually begins. The offscreen document reports the real start of audio —
  `onplaying` for a neural voice, the utterance's own start event for a system one — rather than
  the popup guessing from the acknowledgement that the request was received, which arrives before
  synthesis has even been asked for.
- **A stopped preview can no longer wipe the indicator of the one that replaced it.** A
  `chrome.tts` callback cannot be cancelled, so stopping one preview to start another fired the
  old *interrupted* event after the new one was already set up, clearing the state that had just
  been put in place. Each preview now carries a token and a late callback from a superseded one is
  ignored.

## [2.2.0] — 2026-09-04

### Fixed
- **Exporting a long text as MP3 now works, at any length.** `Alt+D` on more than a few
  paragraphs used to show the spinner and then quietly give up. The export looked for the text
  chunker under the wrong name, so the *entire* selection went to the speech service as one
  request, which it refuses past a few thousand characters. The finished file also travelled back
  as a base64 `data:` URL, which Chrome will not download once it is more than a couple of
  megabytes. The export now runs entirely in the offscreen document and hands Chrome a `blob:`
  URL: no base64, no size ceiling. Measured end to end on a 120-part selection: one 37 MB file,
  about an hour and a half of audio, in 35 seconds.
- **The export no longer stalls partway with the counter frozen.** Each synthesis was wrapped in
  a timeout that sat *outside* an operation which retried internally. When the timeout fired it
  abandoned that work rather than stopping it: the retries kept running unwatched, each opening
  another connection that nobody would ever close. Those orphaned handshakes pile up against the
  browser's limit on concurrent WebSocket connections to one address, so the visible export
  stopped dead while the leaked ones churned. Every attempt is now bounded by exactly one
  timeout, owned by the code that can actually close the socket, and a failed attempt discards
  its connection instead of reusing it.
- **Exports no longer crawl to a halt part way through a long text.** This is what a counter
  frozen at "103 / 247" actually was. The speech service serves a connection progressively more
  slowly the more audio that connection has produced, so an export that held its connections open
  fell off a cliff around the hundredth part and never recovered. Each connection is now retired
  after twenty-five parts, which resets it; a handshake costs about half a second, so it is nearly
  free. Measured on a 247-part export: 51 seconds with recycling against 112 without, and the
  pace stays flat instead of degrading fourfold.
- **Exports are also several times faster outright.** The old code opened a fresh connection for
  every sentence, where the handshake costs more than the speech does. Parts now travel over four
  connections, reused and recycled. On a 99-part export: 18 seconds, against 81 seconds over two
  connections and 73 seconds over sixty-one.
- **There is no longer a size ceiling.** Every part used to be held in memory as a raw byte array
  and then copied again to join them, so peak memory grew with the length of the text and a long
  enough export could exhaust the document that was building it. Audio is now kept as Blobs, whose
  data lives in the browser's own store rather than the JavaScript heap. Measured end to end: a
  400-part selection produced a 121 MB file — about five and a half hours of speech — in two and a
  half minutes, with peak memory of 43 MB, the same as a 247-part export needed.
- **One unreadable passage no longer costs you the whole export.** A part that cannot be
  synthesized within its budget is now skipped, and the count of skipped parts is reported on the
  saved file, rather than the entire export failing after minutes of retrying.
- **The export is never silent.** The toast keeps its own clock, so the elapsed time ticks up
  even when no message arrives, and it says outright how long it has been since it last heard
  anything. If nothing has completed for a few seconds it also says what it is waiting on. A slow
  service can no longer be mistaken for a dead one.
  If nothing completes for two minutes the export stops and explains; if the page hears nothing
  at all for two minutes it says so.
- **The document doing the work no longer goes to sleep mid-export.** Chrome hosts the export in
  an offscreen document declared for audio playback, and it ties both that document's lifetime and
  the rate its timers run at to audio actually coming out of it. An export plays nothing for
  minutes on end, so Chrome was free to throttle or retire it part way through — which is what an
  export that fell silent with no error, no retries and no waiting notices actually was. The
  document now holds an inaudible tone open for as long as an export runs, so it stays genuinely
  active, and it is declared for building blobs as well as for playing audio, which is equally
  true of it and does not carry that timeout.
- **An export now resumes instead of starting over, so there is no length it cannot reach.** Each
  finished part is written to storage as it is made, rather than being held in the memory of the
  document producing it. If that document is taken away mid-export, the page notices within
  twenty-five seconds — it asks the extension how the export is doing every few seconds, which
  also keeps the service worker awake — and the export starts again, picking up from the parts
  already stored rather than repeating them. Several such restarts are allowed, because each one
  makes progress. Parts from an abandoned export are kept for a day, so pressing `Alt+D` again on
  the same text carries on from where it stopped.
- **Progress and results can no longer be lost in transit.** They travelled as one-shot messages
  to the service worker, which Chrome may have asleep, starting, or shutting down — and a
  dropped result means audio that was made and then thrown away, which looks exactly like a hang.
  The offscreen document now reports over a port, which keeps the worker awake for the duration,
  and repeats a result that was never acknowledged.
- **The export explains itself.** Its progress, retries, skips and failures are logged to the
  page's own console under `[Audio Cursor export]`, instead of only to the offscreen document's
  console, which is buried in `chrome://extensions`.
- **You can stop it.** The ✕ cancels and now genuinely closes the connections in flight rather
  than waiting for them to time out.
- **The Chrome-level `Alt+D` shortcut did nothing.** The `download-selection` command sent a
  message the page never listened for; only the in-page keybind worked. Both now start an export,
  and a keypress that reaches both paths starts exactly one.
- **Offline and Chrome voices exported only the first sentence.** They are recorded through the
  cloud voice for their language, whose endpoint takes about 180 characters per request; the whole
  text was being sent in one request and silently truncated. It is now split to fit, and those
  requests are bounded by a timeout too.
- **A dropped connection no longer silently shortens the file.** Playback still prefers a clipped
  tail to a failure, but an export treats a truncated response as a failure and retries it, so
  words cannot go missing from a saved MP3.
- **Success now means saved.** It was reported when the download was handed to Chrome; it is
  reported when Chrome confirms the file completed, and an interrupted download says why.

### Removed
- Dead code for a popup **Export MP3** button that no longer exists in the popup.
