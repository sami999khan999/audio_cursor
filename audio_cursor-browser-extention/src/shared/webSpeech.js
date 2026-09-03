// Audio Cursor — Chrome default voices (Web Speech API)
//
// These are the voices Chrome itself exposes through window.speechSynthesis:
// the OS voices plus Chrome's bundled "Google …" network voices. They are NOT
// the same list chrome.tts.getVoices() returns — on desktop Chrome the Google
// ones are usually missing there — so they are surfaced as their own engine.
//
// speechSynthesis only exists in a document, never in a service worker, so this
// module is loaded by the popup and by the offscreen document. The background
// worker drives it by message.

(function (root) {
    'use strict';

    const synth = root.speechSynthesis;

    function rawVoices() {
        if (!synth) return [];
        try {
            return synth.getVoices() || [];
        } catch (_) {
            return [];
        }
    }

    // Chrome populates the voice list asynchronously the first time it is asked,
    // so an immediate getVoices() on a fresh document often returns []. The
    // 'voiceschanged' event is the documented signal, but it does not fire on
    // every Chrome build once the list is already warm elsewhere in the profile,
    // so poll alongside it and take whichever arrives first.
    function listVoices(timeoutMs = 3000) {
        return new Promise((resolve) => {
            if (!synth) {
                resolve([]);
                return;
            }
            const immediate = rawVoices();
            if (immediate.length > 0) {
                resolve(immediate);
                return;
            }

            let settled = false;
            let pollTimer = null;

            const finish = () => {
                if (settled) return;
                settled = true;
                if (pollTimer !== null) clearInterval(pollTimer);
                synth.removeEventListener('voiceschanged', finish);
                resolve(rawVoices());
            };

            synth.addEventListener('voiceschanged', finish);
            pollTimer = setInterval(() => {
                if (rawVoices().length > 0) finish();
            }, 100);
            setTimeout(finish, timeoutMs);
        });
    }

    function findVoice(id) {
        if (!id) return null;
        const voices = rawVoices();
        return voices.find(v => v.voiceURI === id) ||
               voices.find(v => v.name === id) ||
               null;
    }

    function clamp(value, min, max, fallback) {
        const n = parseFloat(value);
        if (!isFinite(n)) return fallback;
        return Math.min(max, Math.max(min, n));
    }

    // Chrome silently stops any utterance that runs longer than ~15 seconds.
    // Pausing and immediately resuming resets that timer.
    let keepAliveTimer = null;

    function startKeepAlive() {
        stopKeepAlive();
        keepAliveTimer = setInterval(() => {
            if (!synth || !synth.speaking || synth.paused) return;
            synth.pause();
            synth.resume();
        }, 10000);
    }

    function stopKeepAlive() {
        if (keepAliveTimer !== null) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
        }
    }

    let activeToken = 0;

    function cancel() {
        activeToken++;
        stopKeepAlive();
        if (!synth) return;
        try { synth.cancel(); } catch (_) {}
    }

    function pause() {
        if (!synth) return;
        try { synth.pause(); } catch (_) {}
    }

    function resume() {
        if (!synth) return;
        try { synth.resume(); } catch (_) {}
    }

    // opts: { text, voice, rate, pitch, onStart, onBoundary(charIndex), onEnd, onError(message, fatal) }
    function speak(opts) {
        cancel();
        const token = ++activeToken;

        if (!synth) {
            if (opts.onError) opts.onError('Web Speech API unavailable', true);
            return;
        }

        const utterance = new SpeechSynthesisUtterance(opts.text);
        const voice = findVoice(opts.voice);
        if (voice) {
            utterance.voice = voice;
            utterance.lang = voice.lang;
        } else if (opts.voice) {
            // The saved voice is gone (uninstalled, or another profile/machine).
            // Report it so the caller can fall back to another engine.
            if (opts.onError) opts.onError(`Chrome voice "${opts.voice}" is not available`, true);
            return;
        }
        utterance.rate = clamp(opts.rate, 0.1, 10, 1.0);
        utterance.pitch = clamp(opts.pitch, 0, 2, 1.0);

        utterance.onstart = () => {
            if (token !== activeToken) return;
            startKeepAlive();
            if (opts.onStart) opts.onStart();
        };

        utterance.onboundary = (event) => {
            if (token !== activeToken) return;
            if (opts.onBoundary) opts.onBoundary(event.charIndex || 0);
        };

        utterance.onend = () => {
            if (token !== activeToken) return;
            stopKeepAlive();
            if (opts.onEnd) opts.onEnd();
        };

        utterance.onerror = (event) => {
            if (token !== activeToken) return;
            stopKeepAlive();
            const reason = (event && event.error) || 'unknown';
            // Cancelling on purpose surfaces here too — that is not a failure.
            if (reason === 'interrupted' || reason === 'canceled') return;
            if (opts.onError) opts.onError(`Web Speech error: ${reason}`, true);
        };

        // Chrome drops an utterance queued in the same tick as the cancel() above,
        // so let the queue drain first when something was actually speaking.
        if (synth.speaking || synth.pending) {
            setTimeout(() => {
                if (token === activeToken) synth.speak(utterance);
            }, 60);
        } else {
            synth.speak(utterance);
        }
    }

    root.WebSpeech = { listVoices, rawVoices, findVoice, speak, cancel, pause, resume };
})(typeof window !== 'undefined' ? window : globalThis);
