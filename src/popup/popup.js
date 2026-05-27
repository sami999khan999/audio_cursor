document.addEventListener('DOMContentLoaded', () => {
    const enabledToggle = document.getElementById('enabled-toggle');
    const statusText = document.getElementById('status-text');
    const voiceSelect = document.getElementById('voice-select');
    const rateRange = document.getElementById('rate-range');
    const rateValue = document.getElementById('rate-value');
    const pitchRange = document.getElementById('pitch-range');
    const pitchValue = document.getElementById('pitch-value');
    const testButton = document.getElementById('test-speech');
    const lastSpoken = document.getElementById('last-spoken');
    const container = document.querySelector('.container');

    const voiceTrigger = document.getElementById('voice-trigger');
    const customVoiceSelect = document.getElementById('custom-voice-select');
    const voiceOptionsContainer = document.getElementById('voice-options');
    const selectedVoiceLabel = document.getElementById('selected-voice-label');

    function updateStatusUI(enabled) {
        statusText.textContent = enabled ? 'CONNECTED' : 'DISCONNECTED';
        
        if (enabled) {
            container.classList.add('protocol-active');
        } else {
            container.classList.remove('protocol-active');
        }
    }

    // Load saved settings
    chrome.storage.sync.get(['enabled', 'voice', 'rate', 'pitch'], (data) => {
        const enabled = data.enabled !== undefined ? data.enabled : true;
        enabledToggle.checked = enabled;
        updateStatusUI(enabled);

        if (data.voice) {
            voiceSelect.value = data.voice;
            // The label will be updated in populateVoices or by a direct mapping
        }
        if (data.rate) {
            rateRange.value = data.rate;
            rateValue.textContent = `${data.rate}x`;
        }
        if (data.pitch) {
            pitchRange.value = data.pitch;
            pitchValue.textContent = data.pitch;
        }
    });

    // Populate voices
    function populateVoices() {
        chrome.tts.getVoices((voices) => {
            // Clear current custom options
            voiceOptionsContainer.innerHTML = '';
            voiceSelect.innerHTML = '';

            const allVoices = [
                { voiceName: 'default', label: 'CORE_ENGINE_DEFAULT' },
                ...voices.map(v => ({ voiceName: v.voiceName, label: v.voiceName.toUpperCase() }))
            ];

            allVoices.forEach((v) => {
                // Update hidden select
                const option = document.createElement('option');
                option.value = v.voiceName;
                option.textContent = v.label;
                voiceSelect.appendChild(option);

                // Create custom option
                const div = document.createElement('div');
                div.className = 'voice-option';
                div.textContent = v.label;
                div.dataset.value = v.voiceName;
                
                div.addEventListener('click', () => {
                    selectVoice(v.voiceName, v.label);
                    customVoiceSelect.classList.remove('open');
                });

                voiceOptionsContainer.appendChild(div);
            });

            // Set initial label
            chrome.storage.sync.get(['voice'], (data) => {
                const currentVoice = data.voice || 'default';
                const currentOption = allVoices.find(v => v.voiceName === currentVoice) || allVoices[0];
                selectedVoiceLabel.textContent = currentOption.label;
                voiceSelect.value = currentOption.voiceName;
                
                // Mark as selected in UI
                Array.from(voiceOptionsContainer.children).forEach(child => {
                    if (child.dataset.value === currentVoice) {
                        child.classList.add('selected');
                    }
                });
            });
        });
    }

    function selectVoice(value, label) {
        selectedVoiceLabel.textContent = label;
        voiceSelect.value = value;
        chrome.storage.sync.set({ voice: value });

        // Update selected class
        Array.from(voiceOptionsContainer.children).forEach(child => {
            child.classList.toggle('selected', child.dataset.value === value);
        });
    }

    populateVoices();
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.onvoiceschanged = populateVoices;
    }

    // Custom Dropdown Logic
    voiceTrigger.addEventListener('click', (e) => {
        e.stopPropagation();
        customVoiceSelect.classList.toggle('open');
    });

    document.addEventListener('click', () => {
        customVoiceSelect.classList.remove('open');
    });

    // Event Listeners
    enabledToggle.addEventListener('change', () => {
        const enabled = enabledToggle.checked;
        chrome.storage.sync.set({ enabled });
        updateStatusUI(enabled);
    });

    voiceSelect.addEventListener('change', () => {
        // This is still here for compatibility if something else triggers it
        const label = voiceSelect.options[voiceSelect.selectedIndex].text;
        selectVoice(voiceSelect.value, label);
    });

    rateRange.addEventListener('input', () => {
        rateValue.textContent = `${rateRange.value}x`;
    });

    rateRange.addEventListener('change', () => {
        chrome.storage.sync.set({ rate: rateRange.value });
    });

    pitchRange.addEventListener('input', () => {
        pitchValue.textContent = pitchRange.value;
    });

    pitchRange.addEventListener('change', () => {
        chrome.storage.sync.set({ pitch: pitchRange.value });
    });

    testButton.addEventListener('click', () => {
        const text = "DIAGNOSTIC_CORE_ACTIVE. SENSOR_SYSTEMS_CALIBRATED.";
        const display = document.getElementById('last-spoken');
        if (!display) return;

        const statusPara = display.querySelector('p') || display;
        
        statusPara.textContent = "RUNNING_DIAGNOSTIC...";
        testButton.classList.add('diagnosing');
        
        // Debugging logs to help identify failures in the background
        const params = {
            voiceName: voiceSelect.value === 'default' ? undefined : voiceSelect.value,
            rate: parseFloat(rateRange.value) || 1.0,
            pitch: parseFloat(pitchRange.value) || 1.0
        };
        console.log('Synthesizing speech with params:', params);

        try {
            chrome.tts.speak(text, {
                ...params,
                onEvent: (event) => {
                    console.log('TTS Event:', event.type);
                    if (event.type === 'start') {
                        statusPara.textContent = text;
                        statusPara.style.color = 'var(--accent-primary)';
                    }
                    if (event.type === 'end' || event.type === 'interrupted' || event.type === 'error') {
                        testButton.classList.remove('diagnosing');
                        if (event.type === 'error') {
                            statusPara.textContent = `ERROR: ${event.errorMessage || 'INTERNAL_TTS_ERROR'}`;
                            statusPara.style.color = '#ff4b2b'; // High visibility error red
                        } else if (event.type !== 'start') {
                             setTimeout(() => {
                                statusPara.textContent = "SYSTEM_IDLE... AWAITING_INPUT";
                                statusPara.style.color = '';
                             }, 2000);
                        }
                    }
                }
            });
        } catch (err) {
            console.error('Fatal TTS Error:', err);
            statusPara.textContent = "FATAL: CORE_SYNTH_UNAVAILABLE";
            statusPara.style.color = '#ff4b2b';
            testButton.classList.remove('diagnosing');
        }
    });
});
