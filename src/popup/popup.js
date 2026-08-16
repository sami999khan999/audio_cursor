document.addEventListener('DOMContentLoaded', () => {
    const app = document.getElementById('app');
    const enabledToggle = document.getElementById('enabled-toggle');
    const statusLabel = document.getElementById('status-label');
    const voiceSelect = document.getElementById('voice-select');
    const rateRange = document.getElementById('rate-range');
    const rateValue = document.getElementById('rate-value');
    const pitchRange = document.getElementById('pitch-range');
    const pitchValue = document.getElementById('pitch-value');
    const testButton = document.getElementById('test-speech');
    const testLabel = testButton.querySelector('span');
    const keybindList = document.getElementById('keybind-list');
    const keybindResetBtn = document.getElementById('keybind-reset');

    const customVoiceSelect = document.getElementById('custom-voice-select');
    const voiceTrigger = document.getElementById('voice-trigger');
    const voiceOptionsContainer = document.getElementById('voice-options');
    const selectedVoiceLabel = document.getElementById('selected-voice-label');

    const PREVIEW_TEXT = 'Hi! Select any text on a page, and I will read it out loud for you.';

    // ── Enabled state ──────────────────────────────────

    function updateStatusUI(enabled) {
        statusLabel.textContent = enabled ? 'On' : 'Off';
        app.classList.toggle('off', !enabled);
    }

    enabledToggle.addEventListener('change', () => {
        const enabled = enabledToggle.checked;
        chrome.storage.sync.set({ enabled });
        updateStatusUI(enabled);
    });

    // ── Sliders ────────────────────────────────────────

    function paintRange(input) {
        const min = parseFloat(input.min);
        const max = parseFloat(input.max);
        const val = parseFloat(input.value);
        input.style.setProperty('--val', ((val - min) / (max - min)) * 100 + '%');
    }

    rateRange.addEventListener('input', () => {
        rateValue.textContent = `${parseFloat(rateRange.value).toFixed(1)}×`;
        paintRange(rateRange);
    });
    rateRange.addEventListener('change', () => {
        chrome.storage.sync.set({ rate: rateRange.value });
    });

    pitchRange.addEventListener('input', () => {
        pitchValue.textContent = parseFloat(pitchRange.value).toFixed(1);
        paintRange(pitchRange);
    });
    pitchRange.addEventListener('change', () => {
        chrome.storage.sync.set({ pitch: pitchRange.value });
    });

    // ── Load saved settings ────────────────────────────

    chrome.storage.sync.get(['enabled', 'rate', 'pitch'], (data) => {
        const enabled = data.enabled !== undefined ? data.enabled : true;
        enabledToggle.checked = enabled;
        updateStatusUI(enabled);

        if (data.rate) {
            rateRange.value = data.rate;
            rateValue.textContent = `${parseFloat(data.rate).toFixed(1)}×`;
        }
        if (data.pitch) {
            pitchRange.value = data.pitch;
            pitchValue.textContent = parseFloat(data.pitch).toFixed(1);
        }
        paintRange(rateRange);
        paintRange(pitchRange);
    });

    // ── Voice picker ───────────────────────────────────

    function selectVoice(value, label) {
        selectedVoiceLabel.textContent = label;
        voiceSelect.value = value;
        chrome.storage.sync.set({ voice: value });

        Array.from(voiceOptionsContainer.children).forEach((child) => {
            child.classList.toggle('selected', child.dataset.value === value);
        });
    }

    let voiceRetryDone = false;

    function populateVoices() {
        chrome.tts.getVoices((voices) => {
            if ((!voices || voices.length === 0) && !voiceRetryDone) {
                voiceRetryDone = true;
                setTimeout(populateVoices, 300);
            }
            voices = voices || [];
            voiceOptionsContainer.innerHTML = '';
            voiceSelect.innerHTML = '';

            const allVoices = [
                { voiceName: 'default', label: 'System default', lang: '' },
                ...voices
                    .filter((v) => v.voiceName)
                    .map((v) => ({ voiceName: v.voiceName, label: v.voiceName, lang: v.lang || '' }))
            ];

            allVoices.forEach((v) => {
                const option = document.createElement('option');
                option.value = v.voiceName;
                option.textContent = v.label;
                voiceSelect.appendChild(option);

                const div = document.createElement('div');
                div.className = 'voice-option';
                div.dataset.value = v.voiceName;

                const name = document.createElement('span');
                name.className = 'voice-name';
                name.textContent = v.label;
                div.appendChild(name);

                if (v.lang) {
                    const lang = document.createElement('span');
                    lang.className = 'voice-lang';
                    lang.textContent = v.lang;
                    div.appendChild(lang);
                }

                div.addEventListener('click', () => {
                    selectVoice(v.voiceName, v.label);
                    customVoiceSelect.classList.remove('open');
                });

                voiceOptionsContainer.appendChild(div);
            });

            chrome.storage.sync.get(['voice'], (data) => {
                const currentVoice = data.voice || 'default';
                const current =
                    allVoices.find((v) => v.voiceName === currentVoice) || allVoices[0];
                selectedVoiceLabel.textContent = current.label;
                voiceSelect.value = current.voiceName;

                Array.from(voiceOptionsContainer.children).forEach((child) => {
                    child.classList.toggle('selected', child.dataset.value === current.voiceName);
                });
            });
        });
    }

    populateVoices();

    voiceTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        customVoiceSelect.classList.toggle('open');
    });

    document.addEventListener('click', () => {
        customVoiceSelect.classList.remove('open');
    });

    // ── Preview ────────────────────────────────────────

    let previewing = false;

    testButton.addEventListener('click', () => {
        if (previewing) {
            chrome.tts.stop();
            return;
        }

        chrome.tts.speak(PREVIEW_TEXT, {
            voiceName: voiceSelect.value === 'default' ? undefined : voiceSelect.value,
            rate: parseFloat(rateRange.value) || 1.0,
            pitch: parseFloat(pitchRange.value) || 1.0,
            onEvent: (event) => {
                if (event.type === 'start') {
                    previewing = true;
                    testButton.classList.add('speaking');
                    testLabel.textContent = 'Stop preview';
                }
                if (event.type === 'end' || event.type === 'interrupted' || event.type === 'cancelled' || event.type === 'error') {
                    previewing = false;
                    testButton.classList.remove('speaking');
                    testLabel.textContent = event.type === 'error' ? 'Voice unavailable' : 'Preview voice';
                }
            }
        });
    });

    // ── Keyboard shortcuts (recordable, in-extension) ──

    const DEFAULT_KEYBINDS = { togglePlayback: 'Alt+P', keyboardSelect: 'Alt+S' };
    const KEYBIND_ACTIONS = [
        { id: 'togglePlayback', label: 'Play / pause' },
        { id: 'keyboardSelect', label: 'Text cursor' }
    ];

    let keybindSettings = { ...DEFAULT_KEYBINDS };
    let isRecordingKeybind = false;
    const keybindDisplays = {};

    function buildKeybindRows() {
        keybindList.innerHTML = '';
        KEYBIND_ACTIONS.forEach((action) => {
            const row = document.createElement('div');
            row.className = 'keybind-row';

            const label = document.createElement('span');
            label.className = 'hint-text';
            label.textContent = action.label;

            const display = document.createElement('div');
            display.className = 'keybind-display';
            display.title = 'Click to remap';
            display.addEventListener('click', () => recordKeybind(action.id, display));

            row.appendChild(label);
            row.appendChild(display);
            keybindList.appendChild(row);

            keybindDisplays[action.id] = display;
        });
    }

    function renderKeybinds() {
        KEYBIND_ACTIONS.forEach((action) => {
            keybindDisplays[action.id].textContent = keybindSettings[action.id] || 'None';
        });
    }

    buildKeybindRows();
    renderKeybinds();

    chrome.storage.sync.get(['keybinds'], (data) => {
        if (data.keybinds) keybindSettings = { ...DEFAULT_KEYBINDS, ...data.keybinds };
        renderKeybinds();
    });

    function getReadableKeyName(e) {
        const modifiers = {
            ShiftLeft: 'Shift', ShiftRight: 'Shift',
            ControlLeft: 'Ctrl', ControlRight: 'Ctrl',
            AltLeft: 'Alt', AltRight: 'Alt',
            MetaLeft: 'Meta', MetaRight: 'Meta'
        };
        if (modifiers[e.code]) return modifiers[e.code];
        if (e.key === ' ') return 'Space';
        // Alt composes characters on some layouts — name the physical key
        if (/^(Key|Digit)/.test(e.code)) return e.code.replace(/^(Key|Digit)/, '');
        if (e.key.length === 1) return e.key.toUpperCase();
        return e.key;
    }

    function recordKeybind(actionId, keybindDisplay) {
        if (isRecordingKeybind) return;
        isRecordingKeybind = true;

        const originalText = keybindDisplay.textContent;
        keybindDisplay.classList.add('recording');
        keybindDisplay.textContent = 'Press keys...';

        let activeKeys = [];
        const pressedCodes = new Set();

        const handleKeyDown = (e) => {
            e.preventDefault();
            e.stopPropagation();

            if (e.key === 'Escape') {
                cancelRecording();
                return;
            }

            const keyName = getReadableKeyName(e);
            if (!pressedCodes.has(e.code)) {
                pressedCodes.add(e.code);
                if (!activeKeys.includes(keyName)) activeKeys.push(keyName);
                keybindDisplay.textContent = activeKeys.join('+');
            }
        };

        const handleKeyUp = (e) => {
            e.preventDefault();
            e.stopPropagation();
            pressedCodes.delete(e.code);
            if (pressedCodes.size === 0 && activeKeys.length > 0) {
                finalizeRecording();
            }
        };

        const finalizeRecording = () => {
            const combination = activeKeys.join('+');

            // A combo can only drive one action — free it from any other row
            KEYBIND_ACTIONS.forEach((other) => {
                if (other.id !== actionId && keybindSettings[other.id] === combination) {
                    keybindSettings[other.id] = '';
                }
            });

            keybindSettings[actionId] = combination;
            chrome.storage.sync.set({ keybinds: keybindSettings });
            renderKeybinds();
            cleanup();
        };

        const cancelRecording = () => {
            keybindDisplay.textContent = originalText;
            cleanup();
        };

        const cleanup = () => {
            isRecordingKeybind = false;
            keybindDisplay.classList.remove('recording');
            window.removeEventListener('keydown', handleKeyDown, true);
            window.removeEventListener('keyup', handleKeyUp, true);
            window.removeEventListener('blur', cancelRecording);
        };

        window.addEventListener('keydown', handleKeyDown, true);
        window.addEventListener('keyup', handleKeyUp, true);
        window.addEventListener('blur', cancelRecording);
    }

    keybindResetBtn.addEventListener('click', () => {
        keybindSettings = { ...DEFAULT_KEYBINDS };
        chrome.storage.sync.set({ keybinds: keybindSettings });
        renderKeybinds();
    });
});
