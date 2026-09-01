document.addEventListener('DOMContentLoaded', () => {
    const app = document.getElementById('app');
    const enabledToggle = document.getElementById('enabled-toggle');
    const statusLabel = document.getElementById('status-label');
    const rateRange = document.getElementById('rate-range');
    const rateValue = document.getElementById('rate-value');
    const pitchRange = document.getElementById('pitch-range');
    const pitchValue = document.getElementById('pitch-value');
    const repeatToggle = document.getElementById('repeat-toggle');
    const testButton = document.getElementById('test-speech');
    const testLabel = testButton ? testButton.querySelector('span') : null;
    const readClipboardBtn = document.getElementById('read-clipboard');
    const keybindList = document.getElementById('keybind-list');

    // Voice Card & Modal elements
    const voiceCardTrigger = document.getElementById('voice-card-trigger');
    const currentVoiceFlag = document.getElementById('current-voice-flag');
    const currentVoiceName = document.getElementById('current-voice-name');
    const currentVoiceBadge = document.getElementById('current-voice-badge');
    const currentVoiceCountry = document.getElementById('current-voice-country');
    const currentVoiceGender = document.getElementById('current-voice-gender');
    const voiceCountMeta = document.getElementById('voice-count-meta');

    const voiceModal = document.getElementById('voice-modal');
    const btnCloseVoiceModal = document.getElementById('btn-close-voice-modal');
    const voiceSearchInput = document.getElementById('voice-search-input');
    const voiceModalList = document.getElementById('voice-modal-list');
    const modalVoiceCount = document.getElementById('modal-voice-count');

    let allVoices = [];
    let systemVoicesList = [];
    let currentVoice = 'en-US-JennyNeural';
    let voiceSearchQuery = '';
    let activeLangFilter = 'all';
    let activeGenderFilter = 'all';
    let activeTypeFilter = 'all';
    let isSpeakingPreview = false;

    // ── Enabled state ──────────────────────────────────

    function updateStatusUI(enabled) {
        if (statusLabel) statusLabel.textContent = enabled ? 'On' : 'Off';
        if (app) app.classList.toggle('off', !enabled);
    }

    if (enabledToggle) {
        enabledToggle.addEventListener('change', () => {
            const enabled = enabledToggle.checked;
            chrome.storage.sync.set({ enabled });
            updateStatusUI(enabled);
        });
    }

    if (repeatToggle) {
        repeatToggle.addEventListener('change', () => {
            chrome.storage.sync.set({ repeat: repeatToggle.checked });
        });
    }

    // ── Sliders & Speed Pills ──────────────────────────

    function paintRange(input) {
        if (!input) return;
        const min = parseFloat(input.min);
        const max = parseFloat(input.max);
        const val = parseFloat(input.value);
        input.style.setProperty('--val', ((val - min) / (max - min)) * 100 + '%');
    }

    function setRate(val) {
        val = Math.round(val * 10) / 10;
        if (rateRange) rateRange.value = val;
        if (rateValue) rateValue.textContent = `${val.toFixed(1)}×`;
        document.querySelectorAll('.speed-pill').forEach(p => {
            p.classList.toggle('active', parseFloat(p.dataset.speed) === val);
        });
        paintRange(rateRange);
        chrome.storage.sync.set({ rate: String(val) });
    }

    if (rateRange) {
        rateRange.addEventListener('input', () => {
            const val = parseFloat(rateRange.value);
            if (rateValue) rateValue.textContent = `${val.toFixed(1)}×`;
            document.querySelectorAll('.speed-pill').forEach(p => {
                p.classList.toggle('active', parseFloat(p.dataset.speed) === val);
            });
            paintRange(rateRange);
        });
        rateRange.addEventListener('change', () => {
            chrome.storage.sync.set({ rate: rateRange.value });
        });
    }

    document.querySelectorAll('.speed-pill').forEach(pill => {
        pill.addEventListener('click', () => {
            const speed = parseFloat(pill.dataset.speed);
            if (!isNaN(speed)) {
                setRate(speed);
            }
        });
    });

    if (pitchRange) {
        pitchRange.addEventListener('input', () => {
            if (pitchValue) pitchValue.textContent = parseFloat(pitchRange.value).toFixed(1);
            paintRange(pitchRange);
        });
        pitchRange.addEventListener('change', () => {
            chrome.storage.sync.set({ pitch: pitchRange.value });
        });
    }

    // ── Load Voices & Enriched Data ────────────────────

    const COUNTRY_MAP = {
        'en-US': { name: 'United States', flag: '🇺🇸', lang: 'English' },
        'en-GB': { name: 'United Kingdom', flag: '🇬🇧', lang: 'English' },
        'en-AU': { name: 'Australia', flag: '🇦🇺', lang: 'English' },
        'en-CA': { name: 'Canada', flag: '🇨🇦', lang: 'English' },
        'en-IN': { name: 'India', flag: '🇮🇳', lang: 'English' },
        'es-ES': { name: 'Spain', flag: '🇪🇸', lang: 'Spanish' },
        'es-MX': { name: 'Mexico', flag: '🇲🇽', lang: 'Spanish' },
        'fr-FR': { name: 'France', flag: '🇫🇷', lang: 'French' },
        'de-DE': { name: 'Germany', flag: '🇩🇪', lang: 'German' },
        'ja-JP': { name: 'Japan', flag: '🇯🇵', lang: 'Japanese' },
        'zh-CN': { name: 'China', flag: '🇨🇳', lang: 'Chinese' },
        'ko-KR': { name: 'South Korea', flag: '🇰🇷', lang: 'Korean' },
        'it-IT': { name: 'Italy', flag: '🇮🇹', lang: 'Italian' },
        'pt-BR': { name: 'Brazil', flag: '🇧🇷', lang: 'Portuguese' }
    };

    function findBestVoiceName(vObj, systemVoices) {
        if (!systemVoices || systemVoices.length === 0) return undefined;

        // 1. Match friendlyName (e.g. 'Microsoft Jenny Online (Natural)...')
        if (vObj.friendlyName) {
            const m = systemVoices.find(s => s.voiceName === vObj.friendlyName);
            if (m) return m.voiceName;
        }

        // 2. Match exact name or voiceURI
        let m = systemVoices.find(s => s.voiceName === vObj.name || s.voiceName === vObj.voiceURI);
        if (m) return m.voiceName;

        // 3. Partial match on cleanName
        if (vObj.cleanName) {
            m = systemVoices.find(s => s.voiceName.toLowerCase().includes(vObj.cleanName.toLowerCase()));
            if (m) return m.voiceName;
        }

        // 4. Match lang + gender
        if (vObj.lang) {
            const sameLangList = systemVoices.filter(s => s.lang && s.lang.toLowerCase().replace('_', '-').startsWith(vObj.lang.slice(0, 2).toLowerCase()));
            if (sameLangList.length > 0) {
                if (vObj.gender === 'Male') {
                    const maleVoice = sameLangList.find(s => s.voiceName.toLowerCase().includes('male') || s.voiceName.toLowerCase().includes('david') || s.voiceName.toLowerCase().includes('guy'));
                    if (maleVoice) return maleVoice.voiceName;
                } else if (vObj.gender === 'Female') {
                    const femaleVoice = sameLangList.find(s => s.voiceName.toLowerCase().includes('female') || s.voiceName.toLowerCase().includes('zira') || s.voiceName.toLowerCase().includes('jenny'));
                    if (femaleVoice) return femaleVoice.voiceName;
                }
                return sameLangList[0].voiceName;
            }
        }

        return systemVoices[0].voiceName;
    }

    async function loadAllVoices() {
        let neuralVoices = [];
        try {
            const url = chrome.runtime.getURL('dist/voices.json');
            const resp = await fetch(url);
            neuralVoices = await resp.json();
        } catch (e) {
            try {
                const url2 = chrome.runtime.getURL('src/shared/voices.json');
                const resp2 = await fetch(url2);
                neuralVoices = await resp2.json();
            } catch (err) {
                console.warn('Could not load voices.json:', err);
            }
        }

        chrome.tts.getVoices((localVoices) => {
            systemVoicesList = (localVoices || []).filter(v => v.voiceName);

            const formattedLocal = systemVoicesList.map(v => {
                const isOnline = v.voiceName.toLowerCase().includes('natural') || v.voiceName.toLowerCase().includes('online');
                const isFemale = v.voiceName.toLowerCase().includes('female') || v.voiceName.toLowerCase().includes('zira');
                const isMale = v.voiceName.toLowerCase().includes('male') || v.voiceName.toLowerCase().includes('david');
                const gender = isFemale ? 'Female' : (isMale ? 'Male' : 'Local');

                const clean = v.voiceName
                    .replace(/^Microsoft /, '')
                    .replace(/ Online \(Natural\)/, '')
                    .replace(/ - English \([^)]+\)/, '')
                    .replace(/ Desktop/, '');

                const loc = COUNTRY_MAP[v.lang] || {
                    name: v.lang || 'System',
                    flag: '💻',
                    lang: v.lang ? v.lang.split('-')[0].toUpperCase() : 'System'
                };

                return {
                    name: v.voiceName,
                    cleanName: clean,
                    displayName: v.voiceName,
                    friendlyName: v.voiceName,
                    country: loc.name,
                    flag: loc.flag,
                    lang: v.lang || 'en-US',
                    languageName: loc.lang,
                    gender,
                    isNeural: isOnline,
                    voiceURI: v.voiceName
                };
            });

            const map = new Map();
            neuralVoices.forEach(v => map.set(v.name, v));
            formattedLocal.forEach(v => {
                if (!map.has(v.name)) map.set(v.name, v);
            });

            allVoices = Array.from(map.values());
            if (voiceCountMeta) voiceCountMeta.textContent = `${allVoices.length} voices`;

            chrome.storage.sync.get(['voice'], (data) => {
                currentVoice = data.voice || (allVoices.length > 0 ? allVoices[0].name : 'en-US-JennyNeural');
                updateVoiceCardUI();
            });
        });
    }

    function getVoiceInfo(voiceName) {
        if (!voiceName || voiceName === 'default') {
            return {
                name: 'default',
                cleanName: 'System Default Voice',
                country: 'Operating System',
                flag: '💻',
                gender: 'Local',
                isNeural: false
            };
        }
        const found = allVoices.find(v => v.name === voiceName || v.voiceURI === voiceName);
        if (found) return found;

        return {
            name: voiceName,
            cleanName: voiceName.replace(/^[a-z]{2,3}-[A-Z]{2,4}-/, '').replace(/Neural$/, ''),
            country: 'Natural Voice',
            flag: '✨',
            gender: 'AI',
            isNeural: true
        };
    }

    function updateVoiceCardUI() {
        const v = getVoiceInfo(currentVoice);
        if (currentVoiceFlag) currentVoiceFlag.textContent = (v.flag && v.flag.length > 2) ? v.flag : (v.isNeural ? '✨' : '🎙️');
        if (currentVoiceName) currentVoiceName.textContent = v.cleanName || v.name;
        if (currentVoiceCountry) currentVoiceCountry.textContent = v.country || v.lang || '';
        if (currentVoiceGender) currentVoiceGender.textContent = v.gender || (v.isNeural ? 'Natural' : 'Local');

        if (currentVoiceBadge) {
            currentVoiceBadge.textContent = v.isNeural ? 'Natural AI' : 'Local';
            currentVoiceBadge.className = 'pill-badge ' + (v.isNeural ? 'badge-ai' : '');
        }
    }

    // ── Voice Browser Modal ────────────────────────────

    function openVoiceModal() {
        if (voiceModal) {
            voiceModal.style.display = 'flex';
            if (voiceSearchInput) {
                voiceSearchInput.value = voiceSearchQuery;
                voiceSearchInput.focus();
            }
            renderVoiceModalList();
        }
    }

    function closeVoiceModal() {
        if (voiceModal) voiceModal.style.display = 'none';
        stopPreview();
    }

    function getFilteredVoices() {
        return allVoices.filter(v => {
            if (voiceSearchQuery) {
                const q = voiceSearchQuery.toLowerCase();
                const matchName = (v.cleanName || v.name || '').toLowerCase().includes(q);
                const matchCountry = (v.country || '').toLowerCase().includes(q);
                const matchLang = (v.languageName || v.lang || '').toLowerCase().includes(q);
                const matchGender = (v.gender || '').toLowerCase().includes(q);
                if (!matchName && !matchCountry && !matchLang && !matchGender) {
                    return false;
                }
            }

            if (activeLangFilter !== 'all') {
                if (activeLangFilter === 'en-US' && v.lang !== 'en-US') return false;
                if (activeLangFilter === 'en-GB' && v.lang !== 'en-GB') return false;
                if (activeLangFilter === 'en-AU' && v.lang !== 'en-AU') return false;
                if (activeLangFilter === 'en-CA' && v.lang !== 'en-CA') return false;
                if (activeLangFilter === 'en-IN' && v.lang !== 'en-IN') return false;
                if (activeLangFilter === 'es' && !v.lang.startsWith('es-')) return false;
                if (activeLangFilter === 'fr' && !v.lang.startsWith('fr-')) return false;
                if (activeLangFilter === 'de' && !v.lang.startsWith('de-')) return false;
                if (activeLangFilter === 'ja' && !v.lang.startsWith('ja-')) return false;
                if (activeLangFilter === 'zh' && !v.lang.startsWith('zh-')) return false;
                if (activeLangFilter === 'it' && !v.lang.startsWith('it-')) return false;
                if (activeLangFilter === 'pt' && !v.lang.startsWith('pt-')) return false;
                if (activeLangFilter === 'ko' && !v.lang.startsWith('ko-')) return false;
            }

            if (activeGenderFilter !== 'all') {
                if (v.gender && v.gender !== activeGenderFilter) return false;
            }

            if (activeTypeFilter === 'neural' && !v.isNeural) return false;
            if (activeTypeFilter === 'local' && v.isNeural) return false;

            return true;
        });
    }

    function renderVoiceModalList() {
        if (!voiceModalList) return;
        const filtered = getFilteredVoices();
        if (modalVoiceCount) modalVoiceCount.textContent = `${filtered.length} of ${allVoices.length}`;

        voiceModalList.innerHTML = '';

        if (filtered.length === 0) {
            voiceModalList.innerHTML = `
                <div style="text-align: center; padding: 36px 12px; color: var(--text-muted);">
                    <div style="font-weight: 700; font-size: 13px; color: var(--text-primary);">No matching voices</div>
                    <div style="font-size: 12px; margin-top: 5px;">Try searching for a different language, country, or accent.</div>
                </div>
            `;
            return;
        }

        const fragment = document.createDocumentFragment();

        filtered.forEach(v => {
            const isSelected = v.name === currentVoice;
            const itemEl = document.createElement('div');
            itemEl.className = 'voice-item' + (isSelected ? ' selected' : '');

            const genderClass = v.gender === 'Female' ? 'badge-female' : (v.gender === 'Male' ? 'badge-male' : '');
            const typeBadge = v.isNeural ? '<span class="pill-badge badge-ai">Natural AI</span>' : '<span class="pill-badge">Local</span>';
            const genderBadge = v.gender ? `<span class="pill-badge ${genderClass}">${v.gender}</span>` : '';

            itemEl.innerHTML = `
                <div class="voice-item-left">
                    <span style="font-size: 16px; font-family: 'Segoe UI Emoji', 'Apple Color Emoji', sans-serif;">${v.flag || '✨'}</span>
                    <div class="voice-item-details">
                        <div class="voice-item-name">
                            <span>${v.cleanName || v.name}</span>
                            ${typeBadge}
                            ${genderBadge}
                        </div>
                        <div class="voice-item-sub">
                            ${v.country || v.lang || ''} • ${v.languageName || v.lang}
                        </div>
                    </div>
                </div>
                <div class="voice-item-actions">
                    <button class="btn-item-preview" data-voice="${v.name}" type="button">▶ Preview</button>
                </div>
            `;

            itemEl.addEventListener('click', (e) => {
                if (e.target && e.target.closest('.btn-item-preview')) return;
                selectVoice(v.name);
            });

            const prevBtn = itemEl.querySelector('.btn-item-preview');
            if (prevBtn) {
                prevBtn.addEventListener('click', (e) => {
                    e.stopPropagation();
                    previewVoice(v);
                });
            }

            fragment.appendChild(itemEl);
        });

        voiceModalList.appendChild(fragment);
    }

    function selectVoice(voiceName) {
        currentVoice = voiceName;
        chrome.storage.sync.set({ voice: voiceName });
        updateVoiceCardUI();
        closeVoiceModal();
    }

    // Neural previews are synthesized and played by the offscreen document.
    let pendingPreviewOnEnd = null;

    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'AC_PREVIEW_ENDED' || message.type === 'AC_PREVIEW_ERROR') {
            if (message.type === 'AC_PREVIEW_ERROR') {
                console.warn('Voice preview failed:', message.error);
            }
            const cb = pendingPreviewOnEnd;
            pendingPreviewOnEnd = null;
            if (cb) cb();
        }
    });

    function stopNeuralPreviewAudio() {
        pendingPreviewOnEnd = null;
        chrome.runtime.sendMessage({ type: 'STOP_PREVIEW' }, () => void chrome.runtime.lastError);
    }

    function stopPreview() {
        chrome.tts.stop();
        stopNeuralPreviewAudio();
        isSpeakingPreview = false;
        if (testButton) {
            testButton.classList.remove('speaking');
            if (testLabel) testLabel.textContent = 'Preview';
        }
    }

    function speakPreview(voice, sampleText, onStart, onEnd) {
        const isNeural = voice.isNeural !== false && /Neural$/.test(voice.name || '');

        if (isNeural) {
            pendingPreviewOnEnd = onEnd || null;
            chrome.runtime.sendMessage({
                type: 'PREVIEW_VOICE',
                text: sampleText,
                voice: voice.name,
                rate: parseFloat(rateRange ? rateRange.value : 1.0) || 1.0,
                pitch: parseFloat(pitchRange ? pitchRange.value : 1.0) || 1.0
            }, (resp) => {
                if (chrome.runtime.lastError || !resp || !resp.ok) {
                    console.warn('Voice preview failed:', resp && resp.error);
                    pendingPreviewOnEnd = null;
                    if (onEnd) onEnd();
                    return;
                }
                if (onStart) onStart();
            });
            return;
        }

        const systemVoiceName = findBestVoiceName(voice, systemVoicesList);
        let userPitch = parseFloat(pitchRange ? pitchRange.value : 1.0) || 1.0;
        if (voice.gender === 'Male') userPitch *= 0.88;
        if (voice.gender === 'Female') userPitch *= 1.06;

        chrome.tts.speak(sampleText, {
            voiceName: systemVoiceName,
            rate: parseFloat(rateRange ? rateRange.value : 1.0) || 1.0,
            pitch: userPitch,
            onEvent: (event) => {
                if (event.type === 'start') {
                    if (onStart) onStart();
                }
                if (event.type === 'end' || event.type === 'interrupted' || event.type === 'cancelled' || event.type === 'error') {
                    if (onEnd) onEnd();
                }
            }
        });
    }

    function previewVoice(voice) {
        stopPreview();
        const sampleText = `Hi! I am ${voice.cleanName || voice.name}, ready to read any webpage for you.`;
        speakPreview(voice, sampleText, null, null);
    }

    // Modal Triggers & Event Listeners
    if (voiceCardTrigger) {
        voiceCardTrigger.addEventListener('click', openVoiceModal);
    }
    if (btnCloseVoiceModal) {
        btnCloseVoiceModal.addEventListener('click', closeVoiceModal);
    }
    if (voiceModal) {
        voiceModal.addEventListener('click', (e) => {
            if (e.target === voiceModal) closeVoiceModal();
        });
    }

    if (voiceSearchInput) {
        voiceSearchInput.addEventListener('input', () => {
            voiceSearchQuery = voiceSearchInput.value.trim();
            renderVoiceModalList();
        });
    }

    function closeAllDropdowns() {
        document.querySelectorAll('.custom-dropdown').forEach(dd => dd.classList.remove('open'));
    }

    function setupCustomDropdown(dropdownId, onSelect) {
        const dd = document.getElementById(dropdownId);
        if (!dd) return;
        const btn = dd.querySelector('.custom-dropdown-btn');
        const valSpan = dd.querySelector('.custom-dropdown-val');
        const items = dd.querySelectorAll('.custom-dropdown-item');

        if (btn) {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const wasOpen = dd.classList.contains('open');
                closeAllDropdowns();
                if (!wasOpen) dd.classList.add('open');
            });
        }

        items.forEach(item => {
            item.addEventListener('click', (e) => {
                e.stopPropagation();
                items.forEach(i => i.classList.remove('active'));
                item.classList.add('active');
                if (valSpan) valSpan.textContent = item.textContent.trim();
                dd.classList.remove('open');
                if (onSelect) onSelect(item.dataset.val);
            });
        });
    }

    setupCustomDropdown('dropdown-lang', (val) => {
        activeLangFilter = val || 'all';
        renderVoiceModalList();
    });

    setupCustomDropdown('dropdown-gender', (val) => {
        activeGenderFilter = val || 'all';
        renderVoiceModalList();
    });

    setupCustomDropdown('dropdown-type', (val) => {
        activeTypeFilter = val || 'all';
        renderVoiceModalList();
    });

    document.addEventListener('click', () => {
        closeAllDropdowns();
    });

    // ── Preview Button ─────────────────────────────────

    if (testButton) {
        testButton.addEventListener('click', () => {
            if (isSpeakingPreview) {
                stopPreview();
                return;
            }

            isSpeakingPreview = true;
            testButton.classList.add('speaking');
            if (testLabel) testLabel.textContent = 'Stop preview';

            const v = getVoiceInfo(currentVoice);
            const previewText = `Hello! I am ${v.cleanName || v.name}. Select any text on a webpage and I will read it aloud for you.`;

            speakPreview(v, previewText, null, () => {
                isSpeakingPreview = false;
                testButton.classList.remove('speaking');
                if (testLabel) testLabel.textContent = 'Preview';
            });
        });
    }

    // ── Read Clipboard ─────────────────────────────────

    if (readClipboardBtn) {
        readClipboardBtn.addEventListener('click', async () => {
            try {
                const text = await navigator.clipboard.readText();
                if (text && text.trim()) {
                    chrome.runtime.sendMessage({
                        type: 'START_SPEECH',
                        text: text.trim(),
                        from: 0
                    });
                }
            } catch (err) {
                console.warn('Clipboard read error:', err);
            }
        });
    }

    // ── Export MP3 Audio File ──────────────────────────

    const exportMp3Btn = document.getElementById('export-mp3');
    if (exportMp3Btn) {
        const exportLabel = exportMp3Btn.querySelector('span');
        exportMp3Btn.addEventListener('click', async () => {
            let textToExport = '';
            try {
                const clipText = await navigator.clipboard.readText();
                if (clipText && clipText.trim()) textToExport = clipText.trim();
            } catch (_) {}

            if (!textToExport) {
                const v = getVoiceInfo(currentVoice);
                textToExport = `Hello! This is an audio recording generated by Audio Cursor using ${v.cleanName || v.name}.`;
            }

            const origLabel = exportLabel ? exportLabel.textContent : 'Export MP3';
            if (exportLabel) exportLabel.textContent = 'Saving...';
            exportMp3Btn.disabled = true;

            try {
                const v = getVoiceInfo(currentVoice);
                const langCode = (v.lang && v.lang.slice(0, 2)) || 'en';
                const filename = `AudioCursor_${(v.cleanName || 'speech').replace(/\s+/g, '_')}_${Date.now()}.mp3`;
                await CloudTTS.downloadSpeechMp3(textToExport, filename, langCode);
                if (exportLabel) exportLabel.textContent = 'Saved!';
            } catch (err) {
                console.warn('Export MP3 failed:', err);
                if (exportLabel) exportLabel.textContent = 'Error';
            } finally {
                setTimeout(() => {
                    if (exportLabel) exportLabel.textContent = origLabel;
                    exportMp3Btn.disabled = false;
                }, 1500);
            }
        });
    }

    // ── Shortcuts Display ──────────────────────────────

    const DEFAULT_KEYBINDS = [
        { label: 'Play Selection', key: 'Alt+P' },
        { label: 'Download Audio', key: 'Alt+D' },
        { label: 'Place Cursor / Move', key: 'Click / Arrows' },
        { label: 'Select Word / Range', key: 'Shift+Arrows' }
    ];

    function renderKeybinds() {
        if (!keybindList) return;
        keybindList.innerHTML = '';
        DEFAULT_KEYBINDS.forEach(item => {
            const row = document.createElement('div');
            row.className = 'keybind-row';
            row.innerHTML = `
                <span>${item.label}</span>
                <span class="keybind-key">${item.key}</span>
            `;
            keybindList.appendChild(row);
        });
    }

    renderKeybinds();

    // ── Tab Switching ──────────────────────────────────

    const screenSettings = document.getElementById('screen-settings');
    const screenShortcuts = document.getElementById('screen-shortcuts');
    const footerHintText = document.getElementById('footer-hint-text');

    document.querySelectorAll('.popup-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.popup-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const target = tab.dataset.tab;
            if (target === 'shortcuts') {
                if (screenSettings) screenSettings.style.display = 'none';
                if (screenShortcuts) screenShortcuts.style.display = '';
                if (footerHintText) footerHintText.textContent = 'Use chrome://extensions/shortcuts to remap';
            } else {
                if (screenSettings) screenSettings.style.display = '';
                if (screenShortcuts) screenShortcuts.style.display = 'none';
                if (footerHintText) footerHintText.textContent = 'Click a shortcut to configure';
            }
        });
    });

    const openChromeShortcuts = document.getElementById('open-chrome-shortcuts');
    if (openChromeShortcuts) {
        openChromeShortcuts.addEventListener('click', () => {
            chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
        });
    }

    // ── Load Saved Settings ────────────────────

    chrome.storage.sync.get(['enabled', 'rate', 'pitch', 'repeat', 'voice'], (data) => {
        const enabled = data.enabled !== undefined ? data.enabled : true;
        if (enabledToggle) enabledToggle.checked = enabled;
        updateStatusUI(enabled);

        if (repeatToggle) {
            repeatToggle.checked = data.repeat === true;
        }

        if (data.rate) {
            const r = parseFloat(data.rate) || 1.0;
            if (rateRange) rateRange.value = r;
            if (rateValue) rateValue.textContent = `${r.toFixed(1)}×`;
            document.querySelectorAll('.speed-pill').forEach(p => {
                p.classList.toggle('active', parseFloat(p.dataset.speed) === r);
            });
            paintRange(rateRange);
        }
        if (data.pitch) {
            if (pitchRange) pitchRange.value = data.pitch;
            if (pitchValue) pitchValue.textContent = parseFloat(data.pitch).toFixed(1);
            paintRange(pitchRange);
        }
        if (data.voice) {
            currentVoice = data.voice;
        }

        loadAllVoices();
    });
});
