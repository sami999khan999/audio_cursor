// Audio Cursor — content script
// Floating player pinned to a screen edge. Appears on text selection,
// shows a sliding word ticker + progress while playing, stops on deselect.
(() => {
    'use strict';

    const PLAYER_ID = 'audio-cursor-player';
    const AVG_CHARS_PER_SEC = 16;  // initial pace guess until we measure the real one
    const EDGE_MARGIN = 20;
    const TICKER_WINDOW = 28;      // words rendered around the current one
    const TICKER_ANCHOR = 0.35;    // current word sits at 35% from the left

    let player = null;
    let toggleBtn, tickerEl, stripEl, pctEl, trackEl, fillEl, thumbEl;

    let selectedText = '';
    let wordMap = [];
    let totalLength = 0;

    let status = 'idle'; // idle | playing | paused
    let currentCharIndex = 0;
    let lastWordIndex = -1;
    let playbackRate = 1;

    // Progress anchors + measured speaking pace (for voices without word events)
    let anchorChar = 0;
    let anchorTime = 0;
    let lastRealEvent = 0;
    let observedCps = 0;   // EMA of measured chars/sec
    let emaEventGap = 0;   // EMA of ms between real word events
    let estimatorTimer = null;
    let keepAliveTimer = null;

    let scrubbing = false;
    let awaitingSeek = false; // ignore stale progress between a seek and the restarted playback
    let seekGuardTimer = null;
    let dragging = false;
    let interactingWithPlayer = false;
    let hasCustomPosition = false;
    let snapSide = 'right';
    let snapTimer = null;
    let hideTimer = null;
    let selectionDebounce = null;

    let raf = 0;
    let pendingChar = -1;

    // Ticker window state
    let winStart = -1;
    let winEnd = -1;
    let curSpan = null;

    // ── Keybind settings ────────────────────────────────────────────

    const DEFAULT_KEYBINDS = { togglePlayback: 'Alt+P' };
    let keybindSettings = { ...DEFAULT_KEYBINDS };

    chrome.storage.sync.get(['keybinds'], (data) => {
        if (data.keybinds) keybindSettings = { ...DEFAULT_KEYBINDS, ...data.keybinds };
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes.keybinds) {
            keybindSettings = { ...DEFAULT_KEYBINDS, ...(changes.keybinds.newValue || {}) };
        }
    });

    function parseKeybind(bindString) {
        const parts = bindString.split('+');
        return {
            key: parts[parts.length - 1].toLowerCase(),
            alt: parts.includes('Alt'),
            shift: parts.includes('Shift'),
            ctrl: parts.includes('Ctrl') || parts.includes('Control'),
            meta: parts.includes('Meta') || parts.includes('Command')
        };
    }

    function matchesKeybind(e, bindString) {
        if (!bindString) return false;
        const bind = parseKeybind(bindString);
        if (e.key.toLowerCase() !== bind.key) return false;
        if (e.altKey !== bind.alt) return false;
        if (e.shiftKey !== bind.shift) return false;
        if (e.ctrlKey !== bind.ctrl) return false;
        if (e.metaKey !== bind.meta) return false;
        return true;
    }

    window.addEventListener('keydown', (e) => {
        // Ignore while typing in an input/textarea
        const tag = e.target.tagName ? e.target.tagName.toLowerCase() : '';
        if (tag === 'input' || tag === 'textarea' || e.target.isContentEditable) return;

        if (matchesKeybind(e, keybindSettings.togglePlayback)) {
            e.preventDefault();
            e.stopImmediatePropagation();
            togglePlayback();
        }
    }, true);

    // ── Text utilities ─────────────────────────────────────────────

    function tokenize(text) {
        const map = [];
        const re = /\S+/g;
        let m;
        while ((m = re.exec(text)) !== null) {
            map.push({ text: m[0], start: m.index, end: m.index + m[0].length });
        }
        return map;
    }

    // Word being spoken at charIndex. TTS word events can point at the
    // whitespace before a word, so if charIndex is past a word's end we
    // are already on the next one (fixes the display lagging one word behind).
    function wordIndexAt(charIndex) {
        let lo = 0, hi = wordMap.length - 1, ans = 0;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (wordMap[mid].start <= charIndex) {
                ans = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }
        if (wordMap[ans] && charIndex >= wordMap[ans].end && ans < wordMap.length - 1) {
            ans++;
        }
        return ans;
    }

    function sendMessage(msg) {
        try {
            chrome.runtime.sendMessage(msg);
        } catch (_) {
            // Extension was reloaded; this content script instance is orphaned
        }
    }

    // ── Player DOM ─────────────────────────────────────────────────

    function ensurePlayer() {
        if (player) return;

        player = document.createElement('div');
        player.id = PLAYER_ID;
        player.innerHTML = `
            <div class="ac-row">
                <button class="ac-toggle" type="button" aria-label="Play">
                    <svg class="ac-icon-play" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M8 5.5v13a1 1 0 0 0 1.52.86l10.2-6.5a1 1 0 0 0 0-1.72L9.52 4.64A1 1 0 0 0 8 5.5z" fill="currentColor"/>
                    </svg>
                    <svg class="ac-icon-pause" viewBox="0 0 24 24" aria-hidden="true">
                        <rect x="6.5" y="5" width="4" height="14" rx="1.4" fill="currentColor"/>
                        <rect x="13.5" y="5" width="4" height="14" rx="1.4" fill="currentColor"/>
                    </svg>
                </button>
                <div class="ac-ticker"><div class="ac-strip"></div></div>
                <div class="ac-pct">0%</div>
            </div>
            <div class="ac-trackwrap">
                <div class="ac-track" role="slider" aria-label="Playback position">
                    <div class="ac-rail"></div>
                    <div class="ac-fill"></div>
                    <div class="ac-thumb"></div>
                </div>
            </div>
        `;
        document.documentElement.appendChild(player);

        toggleBtn = player.querySelector('.ac-toggle');
        tickerEl = player.querySelector('.ac-ticker');
        stripEl = player.querySelector('.ac-strip');
        pctEl = player.querySelector('.ac-pct');
        trackEl = player.querySelector('.ac-track');
        fillEl = player.querySelector('.ac-fill');
        thumbEl = player.querySelector('.ac-thumb');

        // Keep the page selection alive when interacting with the player
        player.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            interactingWithPlayer = true;

            if (e.target.closest('.ac-track')) {
                startScrub(e);
            } else {
                // Drag can start anywhere else, including the play button —
                // a >4px move is a drag, otherwise the click toggles playback
                startDrag(e);
            }

            window.addEventListener('mouseup', () => {
                setTimeout(() => { interactingWithPlayer = false; }, 100);
            }, { once: true });
        });

        toggleBtn.addEventListener('click', () => {
            if (dragging || scrubbing) return;
            togglePlayback();
        });
    }

    function showPlayer() {
        ensurePlayer();
        clearTimeout(hideTimer);
        player.style.display = 'flex';
        if (!hasCustomPosition) {
            player.style.left = 'auto';
            player.style.top = 'auto';
            player.style.right = EDGE_MARGIN + 'px';
            player.style.bottom = EDGE_MARGIN + 'px';
            snapSide = 'right';
        }
        // Force reflow so the entrance transition runs
        void player.offsetWidth;
        player.classList.add('ac-visible');
    }

    function hidePlayer() {
        if (!player) return;
        player.classList.remove('ac-visible');
        clearTimeout(hideTimer);
        hideTimer = setTimeout(() => {
            if (player) player.style.display = 'none';
        }, 200);
    }

    // ── Playback control ───────────────────────────────────────────

    function arm(text) {
        if (status !== 'idle') {
            sendMessage({ type: 'STOP_TTS' });
        }
        selectedText = text;
        wordMap = tokenize(text);
        totalLength = text.length;
        currentCharIndex = 0;
        lastWordIndex = -1;
        observedCps = 0;
        emaEventGap = 0;
        winStart = -1;
        winEnd = -1;
        curSpan = null;

        setStatus('idle');
        showPlayer();
        renderChar(0);
    }

    function disarm() {
        if (status !== 'idle') {
            sendMessage({ type: 'STOP_TTS' });
        }
        selectedText = '';
        wordMap = [];
        totalLength = 0;
        currentCharIndex = 0;
        setStatus('idle');
        hidePlayer();
    }

    function playFrom(charIndex) {
        if (!selectedText) return;
        const clamped = Math.max(0, Math.min(charIndex, totalLength - 1));
        sendMessage({ type: 'PLAY_TEXT', text: selectedText, offset: clamped });
    }

    function togglePlayback() {
        if (status === 'playing') {
            sendMessage({ type: 'PAUSE_TTS' });
        } else if (status === 'paused') {
            sendMessage({ type: 'RESUME_TTS' });
        } else if (selectedText) {
            playFrom(currentCharIndex);
        }
    }

    function setStatus(next) {
        status = next;
        if (!player) return;

        player.classList.toggle('ac-playing', next === 'playing');
        player.classList.toggle('ac-paused', next === 'paused');
        player.classList.toggle('ac-active', next !== 'idle');
        toggleBtn.setAttribute('aria-label', next === 'playing' ? 'Pause' : 'Play');

        if (next === 'playing') {
            startEstimator();
            startKeepAlive();
        } else {
            stopEstimator();
            if (next === 'idle') {
                stopKeepAlive();
                currentCharIndex = 0;
                lastWordIndex = -1;
                renderChar(0);
            }
        }
    }

    // ── Word ticker ────────────────────────────────────────────────

    function rebuildTickerWindow(center) {
        winStart = Math.max(0, center - 10);
        winEnd = Math.min(wordMap.length, winStart + TICKER_WINDOW);

        const frag = document.createDocumentFragment();
        for (let i = winStart; i < winEnd; i++) {
            const span = document.createElement('span');
            span.className = 'ac-w';
            span.textContent = wordMap[i].text;
            frag.appendChild(span);
        }
        stripEl.textContent = '';
        stripEl.appendChild(frag);
        curSpan = null;
    }

    function updateTicker(wi, instant) {
        if (!wordMap.length) {
            stripEl.textContent = '';
            winStart = winEnd = -1;
            curSpan = null;
            return;
        }

        // Re-window when the current word drifts near the rendered edge
        if (winStart < 0 || wi < winStart || wi >= winEnd - 6) {
            if (winEnd >= wordMap.length && wi >= winStart && wi < winEnd) {
                // tail of the text: window can't advance further, keep it
            } else {
                rebuildTickerWindow(wi);
                instant = true;
            }
        }

        const span = stripEl.children[wi - winStart];
        if (!span) return;

        if (curSpan !== span) {
            if (curSpan) curSpan.classList.remove('ac-cur');
            span.classList.add('ac-cur');
            curSpan = span;
        }

        const viewW = tickerEl.clientWidth;
        if (!viewW) return;
        let tx = viewW * TICKER_ANCHOR - (span.offsetLeft + span.offsetWidth / 2);
        tx = Math.min(0, tx);

        if (instant || scrubbing) {
            stripEl.classList.add('ac-noanim');
            stripEl.style.transform = `translateX(${tx}px)`;
            void stripEl.offsetWidth;
            stripEl.classList.remove('ac-noanim');
        } else {
            stripEl.style.transform = `translateX(${tx}px)`;
        }
    }

    // ── Rendering (rAF-batched for large text) ─────────────────────

    function renderChar(charIndex) {
        pendingChar = Math.max(0, Math.min(charIndex, totalLength));
        currentCharIndex = pendingChar;
        if (!raf) raf = requestAnimationFrame(applyRender);
    }

    function applyRender() {
        raf = 0;
        if (!player) return;

        const pct = totalLength ? (pendingChar / totalLength) * 100 : 0;
        fillEl.style.width = pct + '%';
        thumbEl.style.left = pct + '%';
        pctEl.textContent = Math.round(pct) + '%';

        if (wordMap.length) {
            const wi = wordIndexAt(pendingChar);
            if (wi !== lastWordIndex) {
                const jumped = lastWordIndex < 0 || Math.abs(wi - lastWordIndex) > 3;
                lastWordIndex = wi;
                updateTicker(wi, jumped);
            }
        }
    }

    // ── Progress estimator (fallback for voices without word events) ──

    function startEstimator() {
        stopEstimator();
        anchorChar = currentCharIndex;
        anchorTime = performance.now();
        estimatorTimer = setInterval(() => {
            if (status !== 'playing' || scrubbing || !totalLength) return;
            const now = performance.now();
            // Only estimate when real events have gone quiet
            const quietThreshold = Math.max(1200, emaEventGap * 4);
            if (now - lastRealEvent < quietThreshold) return;
            const cps = observedCps || AVG_CHARS_PER_SEC * playbackRate;
            const est = anchorChar + ((now - anchorTime) / 1000) * cps;
            renderChar(Math.min(est, totalLength - 1));
        }, 120);
    }

    function stopEstimator() {
        if (estimatorTimer) {
            clearInterval(estimatorTimer);
            estimatorTimer = null;
        }
    }

    function onRealProgress(charIndex) {
        const now = performance.now();
        // Measure the actual speaking pace so the estimator stays honest
        if (lastRealEvent && charIndex > anchorChar) {
            const dt = now - lastRealEvent;
            if (dt > 30 && dt < 3000) {
                const cps = (charIndex - anchorChar) / (dt / 1000);
                observedCps = observedCps ? observedCps * 0.8 + cps * 0.2 : cps;
                emaEventGap = emaEventGap ? emaEventGap * 0.8 + dt * 0.2 : dt;
            }
        }
        lastRealEvent = now;
        anchorChar = charIndex;
        anchorTime = now;
    }

    function startKeepAlive() {
        stopKeepAlive();
        keepAliveTimer = setInterval(() => sendMessage({ type: 'KEEPALIVE' }), 15000);
    }

    function stopKeepAlive() {
        if (keepAliveTimer) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
        }
    }

    // ── Scrubbing ──────────────────────────────────────────────────

    function charFromEvent(e) {
        const rect = trackEl.getBoundingClientRect();
        const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
        return (x / rect.width) * totalLength;
    }

    function startScrub(e) {
        if (!selectedText || !wordMap.length) return;
        scrubbing = true;
        player.classList.add('ac-scrubbing');
        renderChar(charFromEvent(e));

        const onMove = (ev) => renderChar(charFromEvent(ev));
        const onUp = (ev) => {
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);

            const wi = wordIndexAt(charFromEvent(ev));
            const target = wordMap[wi] ? wordMap[wi].start : 0;
            renderChar(target);

            // Re-anchor the estimator at the seek target so it can't pull
            // the bar back to the pre-seek position while TTS restarts.
            anchorChar = target;
            anchorTime = performance.now();
            lastRealEvent = anchorTime;

            if (status === 'playing' || status === 'paused') {
                awaitingSeek = true;
                clearTimeout(seekGuardTimer);
                seekGuardTimer = setTimeout(() => { awaitingSeek = false; }, 1200);
                playFrom(target);
            } else {
                currentCharIndex = target;
            }

            setTimeout(() => {
                scrubbing = false;
                if (player) player.classList.remove('ac-scrubbing');
            }, 120);
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }

    // ── Dragging + edge snap ───────────────────────────────────────

    function startDrag(e) {
        if (e.button !== 0) return;
        const rect = player.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const offsetY = e.clientY - rect.top;
        let moved = false;
        let frame = 0;

        const onMove = (ev) => {
            if (!moved && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 4) return;
            if (!moved) {
                moved = true;
                dragging = true;
                hasCustomPosition = true;
                clearTimeout(snapTimer);
                player.classList.remove('ac-snap');
                player.classList.add('ac-dragging');
            }

            if (frame) cancelAnimationFrame(frame);
            frame = requestAnimationFrame(() => {
                const x = ev.clientX - offsetX;
                const y = ev.clientY - offsetY;
                player.style.left = x + 'px';
                player.style.top = y + 'px';
                player.style.right = 'auto';
                player.style.bottom = 'auto';
            });
        };

        const onUp = () => {
            if (frame) cancelAnimationFrame(frame);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
            player.classList.remove('ac-dragging');
            if (moved) snapToEdge();
            setTimeout(() => { dragging = false; }, 50);
        };

        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
    }

    function snapToEdge() {
        const rect = player.getBoundingClientRect();
        snapSide = rect.left + rect.width / 2 < window.innerWidth / 2 ? 'left' : 'right';

        const targetLeft = snapSide === 'left'
            ? EDGE_MARGIN
            : window.innerWidth - rect.width - EDGE_MARGIN;
        const targetTop = Math.max(
            EDGE_MARGIN,
            Math.min(rect.top, window.innerHeight - rect.height - EDGE_MARGIN)
        );

        player.classList.add('ac-snap'); // springy left/top transition
        player.style.left = targetLeft + 'px';
        player.style.top = targetTop + 'px';

        clearTimeout(snapTimer);
        snapTimer = setTimeout(() => {
            if (!player) return;
            player.classList.remove('ac-snap');
            if (snapSide === 'right') {
                // Anchor to the right edge so the player grows leftward when it expands
                player.style.right = EDGE_MARGIN + 'px';
                player.style.left = 'auto';
            }
        }, 520);
    }

    // ── Selection tracking ─────────────────────────────────────────

    document.addEventListener('selectionchange', () => {
        clearTimeout(selectionDebounce);
        selectionDebounce = setTimeout(onSelectionSettled, 180);
    });

    function onSelectionSettled() {
        if (interactingWithPlayer || scrubbing || dragging) return;

        const sel = window.getSelection();
        const text = sel ? sel.toString().trim() : '';

        if (text) {
            if (text !== selectedText) arm(text);
        } else if (selectedText) {
            disarm(); // deselected → stop playback and hide
        }
    }

    // ── Messages from background ───────────────────────────────────

    chrome.runtime.onMessage.addListener((message) => {
        if (!player) return;

        if (message.type === 'TTS_STATUS') {
            if (message.rate) playbackRate = message.rate;

            if (message.status === 'playing') {
                if (typeof message.offset === 'number') {
                    // Chunk boundary or seek restart: hard re-anchor
                    awaitingSeek = false;
                    clearTimeout(seekGuardTimer);
                    lastRealEvent = performance.now();
                    anchorChar = message.offset;
                    anchorTime = lastRealEvent;
                    if (!scrubbing && (message.offset > currentCharIndex || status !== 'playing')) {
                        renderChar(message.offset);
                    }
                } else {
                    anchorChar = currentCharIndex;
                    anchorTime = performance.now();
                }
                setStatus('playing');
            } else if (message.status === 'paused') {
                setStatus('paused');
            } else {
                setStatus('idle');
            }
        } else if (message.type === 'TTS_PROGRESS') {
            if (scrubbing || awaitingSeek) return;
            onRealProgress(message.charIndex);
            renderChar(message.charIndex);
        }
    });
})();
