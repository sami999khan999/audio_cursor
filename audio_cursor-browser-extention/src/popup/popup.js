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

    function describeLocation(langCode) {
        return COUNTRY_MAP[langCode] || {
            name: langCode || 'System',
            flag: '💻',
            lang: langCode ? langCode.split('-')[0].toUpperCase() : 'System'
        };
    }

    function guessGender(voiceName) {
        const n = voiceName.toLowerCase();
        if (n.includes('female') || n.includes('zira') || n.includes('jenny')) return 'Female';
        if (n.includes('male') || n.includes('david') || n.includes('guy')) return 'Male';
        return null;
    }

    // Chrome's own voices, read from window.speechSynthesis. This is a different
    // list from chrome.tts.getVoices(): it also carries the bundled "Google …"
    // voices, which chrome.tts does not report on desktop Chrome.
    function formatChromeVoices(chromeVoices) {
        return chromeVoices.map(v => {
            const loc = describeLocation(v.lang);
            const clean = v.name
                .replace(/^Microsoft /, '')
                .replace(/ Online \(Natural\)/, '')
                .replace(/ - [A-Za-z]+ \([^)]+\)/, '')
                .replace(/ Desktop/, '');

            return {
                name: v.name,
                cleanName: clean,
                displayName: v.name,
                friendlyName: v.name,
                country: loc.name,
                flag: loc.flag,
                lang: v.lang || 'en-US',
                languageName: loc.lang,
                gender: guessGender(v.name) || 'Chrome',
                isNeural: false,
                engine: 'webspeech',
                // What speechSynthesis matches on when the voice is spoken.
                voiceURI: v.voiceURI || v.name
            };
        });
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

        const chromeVoices = await WebSpeech.listVoices();

        chrome.tts.getVoices((localVoices) => {
            systemVoicesList = (localVoices || []).filter(v => v.voiceName);

            const formattedLocal = systemVoicesList.map(v => {
                const isOnline = v.voiceName.toLowerCase().includes('natural') || v.voiceName.toLowerCase().includes('online');
                const gender = guessGender(v.voiceName) || 'Local';

                const clean = v.voiceName
                    .replace(/^Microsoft /, '')
                    .replace(/ Online \(Natural\)/, '')
                    .replace(/ - English \([^)]+\)/, '')
                    .replace(/ Desktop/, '');

                const loc = describeLocation(v.lang);

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
                    engine: 'local',
                    voiceURI: v.voiceName
                };
            });

            // Neural first, then Chrome's own voices, and finally anything only
            // chrome.tts knows about.
            //
            // Chrome ranks above chrome.tts on purpose: the two lists overlap
            // heavily, reporting most voices under identical names. Adding Chrome
            // last behind a "name not seen yet" guard meant every shared voice was
            // claimed as `local` and the Chrome list came out empty.
            const map = new Map();
            neuralVoices.forEach(v => map.set(v.name, { engine: 'neural', ...v }));
            formatChromeVoices(chromeVoices).forEach(v => {
                if (!map.has(v.name)) map.set(v.name, v);
            });
            formattedLocal.forEach(v => {
                if (!map.has(v.name)) map.set(v.name, v);
            });

            allVoices = Array.from(map.values());
            console.info(
                `Audio Cursor voices — neural ${neuralVoices.length}, ` +
                `Chrome ${chromeVoices.length}, chrome.tts ${formattedLocal.length}, ` +
                `listed ${allVoices.length}`
            );
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
                isNeural: false,
                engine: 'local'
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
            isNeural: true,
            engine: 'neural'
        };
    }

    // Badge shown next to a voice: which engine will actually speak it.
    function engineBadge(v) {
        if (v.engine === 'webspeech') return { label: 'Chrome', className: 'badge-chrome' };
        if (v.isNeural) return { label: 'Natural AI', className: 'badge-ai' };
        return { label: 'Local', className: '' };
    }

    function updateVoiceCardUI() {
        const v = getVoiceInfo(currentVoice);
        if (currentVoiceFlag) {
            currentVoiceFlag.textContent = v.flag || (v.isNeural ? '✨' : '🎙️');
        }
        if (currentVoiceName) currentVoiceName.textContent = v.cleanName || v.name;
        if (currentVoiceCountry) currentVoiceCountry.textContent = v.country || v.lang || '';
        if (currentVoiceGender) currentVoiceGender.textContent = v.gender || (v.isNeural ? 'Natural' : 'Local');

        if (currentVoiceBadge) {
            const badge = engineBadge(v);
            currentVoiceBadge.textContent = badge.label;
            currentVoiceBadge.className = 'pill-badge ' + badge.className;
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
            if (activeTypeFilter === 'local' && (v.isNeural || v.engine === 'webspeech')) return false;
            if (activeTypeFilter === 'chrome' && v.engine !== 'webspeech') return false;

            return true;
        });
    }

    function renderVoiceModalList() {
        if (!voiceModalList) return;
        const filtered = getFilteredVoices();
        if (modalVoiceCount) modalVoiceCount.textContent = `${filtered.length} of ${allVoices.length}`;

        voiceModalList.innerHTML = '';

        if (filtered.length === 0) {
            const noChromeVoices = activeTypeFilter === 'chrome' &&
                !allVoices.some(v => v.engine === 'webspeech');
            const hint = noChromeVoices
                ? 'Chrome is not reporting any built-in voices on this system. Reopening the popup usually loads them.'
                : 'Try searching for a different language, country, or accent.';

            voiceModalList.innerHTML = `
                <div style="text-align: center; padding: 36px 12px; color: var(--text-muted);">
                    <div style="font-weight: 700; font-size: 13px; color: var(--text-primary);">No matching voices</div>
                    <div style="font-size: 12px; margin-top: 5px;">${hint}</div>
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
            const badge = engineBadge(v);
            const typeBadge = `<span class="pill-badge ${badge.className}">${badge.label}</span>`;
            // Only a real gender adds information — 'Local'/'Chrome' would just
            // repeat the engine badge sitting next to it.
            const genderBadge = genderClass ? `<span class="pill-badge ${genderClass}">${v.gender}</span>` : '';

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
        // The buttons in this fragment are new elements, so the running
        // preview's indicator has to be reapplied to them.
        syncPreviewButtons();
    }

    function selectVoice(voiceName) {
        currentVoice = voiceName;
        const v = getVoiceInfo(voiceName);
        // The background worker cannot tell a Chrome voice from an OS one by name
        // alone, so record which engine has to speak it.
        chrome.storage.sync.set({
            voice: voiceName,
            voiceEngine: v.engine || 'neural',
            voiceLang: v.lang || ''
        });
        updateVoiceCardUI();
        closeVoiceModal();
    }

    // Neural previews are synthesized and played by the offscreen document.
    let pendingPreviewOnEnd = null;

    // Which voice a row-level preview is running for, and how far along it is.
    // Tracked by voice name rather than by element so the state survives the
    // list being re-rendered by a filter or a search.
    let activePreviewVoice = null;
    /** @type {'loading' | 'playing'} */
    let activePreviewState = 'loading';

    // Bumped on every start and stop. A `chrome.tts` callback cannot be
    // cancelled, so stopping one preview to start another fires the old
    // `interrupted` event *after* the new one is set up; without this the stale
    // callback would clear the indicator that had just been put up.
    let previewToken = 0;

    /** Paint every row button from `activePreviewVoice` / `activePreviewState`. */
    function syncPreviewButtons() {
        document.querySelectorAll('.btn-item-preview').forEach((btn) => {
            const isActive = Boolean(activePreviewVoice) && btn.dataset.voice === activePreviewVoice;
            const loading = isActive && activePreviewState === 'loading';
            const playing = isActive && activePreviewState === 'playing';

            btn.classList.toggle('loading', loading);
            btn.classList.toggle('playing', playing);
            btn.textContent = loading ? 'Loading…' : (playing ? '■ Stop' : '▶ Preview');
            btn.setAttribute('aria-label',
                isActive ? 'Stop the preview' : 'Preview this voice');
        });
    }

    function setPreviewState(voiceName, state) {
        activePreviewVoice = voiceName;
        activePreviewState = state || 'loading';
        syncPreviewButtons();
    }

    let pendingPreviewOnStart = null;

    chrome.runtime.onMessage.addListener((message) => {
        if (message.type === 'AC_PREVIEW_STARTED') {
            const started = pendingPreviewOnStart;
            pendingPreviewOnStart = null;
            if (started) started();
            return;
        }
        if (message.type === 'AC_PREVIEW_ENDED' || message.type === 'AC_PREVIEW_ERROR') {
            if (message.type === 'AC_PREVIEW_ERROR') {
                console.warn('Voice preview failed:', message.error);
            }
            pendingPreviewOnStart = null;
            const cb = pendingPreviewOnEnd;
            pendingPreviewOnEnd = null;
            if (cb) cb();
        }
    });

    function stopNeuralPreviewAudio() {
        pendingPreviewOnStart = null;
        pendingPreviewOnEnd = null;
        chrome.runtime.sendMessage({ type: 'STOP_PREVIEW' }, () => void chrome.runtime.lastError);
    }

    function stopPreview() {
        previewToken++;
        chrome.tts.stop();
        stopNeuralPreviewAudio();
        isSpeakingPreview = false;
        if (testButton) {
            testButton.classList.remove('loading', 'speaking');
            if (testLabel) testLabel.textContent = 'Preview';
        }
        setPreviewState(null, 'loading');
    }

    function speakPreview(voice, sampleText, onStart, onEnd) {
        const isNeural = voice.engine
            ? voice.engine === 'neural'
            : (voice.isNeural !== false && /Neural$/.test(voice.name || ''));

        // Neural and Chrome voices are both spoken by the offscreen document, so
        // the preview keeps playing even after this popup closes.
        if (isNeural || voice.engine === 'webspeech') {
            pendingPreviewOnStart = onStart || null;
            pendingPreviewOnEnd = onEnd || null;
            chrome.runtime.sendMessage({
                type: 'PREVIEW_VOICE',
                engine: isNeural ? 'neural' : 'webspeech',
                text: sampleText,
                voice: voice.name,
                rate: parseFloat(rateRange ? rateRange.value : 1.0) || 1.0,
                pitch: parseFloat(pitchRange ? pitchRange.value : 1.0) || 1.0
            }, (resp) => {
                if (chrome.runtime.lastError || !resp || !resp.ok) {
                    console.warn('Voice preview failed:', resp && resp.error);
                    pendingPreviewOnStart = null;
                    pendingPreviewOnEnd = null;
                    if (onEnd) onEnd();
                }
                // Otherwise the offscreen document is up; it reports the real
                // start and end of the audio itself.
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
        // A running preview had no indicator at all, so there was nothing to
        // press to stop it and no sign of which row was speaking.
        const wasPlayingThisVoice = activePreviewVoice === voice.name;
        stopPreview();
        if (wasPlayingThisVoice) return;

        const token = ++previewToken;
        // Neural voices are synthesized over the network, so there is a real
        // gap before any sound. The button says so rather than sitting idle.
        setPreviewState(voice.name, 'loading');

        const sampleText = `Hi! I am ${voice.cleanName || voice.name}, ready to read any webpage for you.`;
        speakPreview(
            voice,
            sampleText,
            () => {
                if (token !== previewToken) return;
                setPreviewState(voice.name, 'playing');
            },
            () => {
                if (token !== previewToken) return;
                setPreviewState(null, 'loading');
            }
        );
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

            // Also stops a row preview: one preview plays at a time, so only
            // one indicator may be lit.
            stopPreview();
            const token = ++previewToken;

            isSpeakingPreview = true;
            // Not "Stop preview" yet — a neural voice is still being
            // synthesized at this point and the button would be offering to
            // stop something that has not started.
            testButton.classList.add('loading');
            if (testLabel) testLabel.textContent = 'Loading…';

            const v = getVoiceInfo(currentVoice);
            const previewText = `Hello! I am ${v.cleanName || v.name}. Select any text on a webpage and I will read it aloud for you.`;

            speakPreview(
                v,
                previewText,
                () => {
                    if (token !== previewToken) return;
                    testButton.classList.remove('loading');
                    testButton.classList.add('speaking');
                    if (testLabel) testLabel.textContent = 'Stop preview';
                },
                () => {
                    if (token !== previewToken) return;
                    isSpeakingPreview = false;
                    testButton.classList.remove('loading', 'speaking');
                    if (testLabel) testLabel.textContent = 'Preview';
                }
            );
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

    // ── Shortcuts Display ──────────────────────────────

    // Remappable binds, stored in chrome.storage.sync.keybinds — the content
    // script reads the same keys and picks changes up live.
    const KEYBIND_DEFS = [
        {
            id: 'togglePlayback',
            label: 'Play / Pause selection',
            fallback: 'Alt+P',
            note: 'Also a browser shortcut'
        },
        {
            id: 'downloadAudio',
            label: 'Download audio',
            fallback: 'Alt+D',
            note: 'Also a browser shortcut'
        },
        {
            id: 'keyboardSelect',
            label: 'Keyboard selection mode',
            fallback: 'Alt+S'
        },
        {
            id: 'autoPlaySelect',
            label: 'Auto-play on select',
            fallback: 'Ctrl+Alt',
            modifiersOnly: true,
            note: 'Hold these, then select text'
        }
    ];

    const STATIC_KEYBINDS = [
        { label: 'Place cursor / move', key: 'Click / Arrows' },
        { label: 'Select word / range', key: 'Shift+Arrows' }
    ];

    const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'OS', 'AltGraph']);
    let keybinds = {};
    let capture = null;

    function bindFor(def) {
        const value = keybinds[def.id];
        return value === undefined ? def.fallback : value;
    }

    /** Build an "Ctrl+Alt+P" style string that the content script can parse. */
    function comboFromEvent(e, modifiersOnly) {
        const parts = [];
        if (e.ctrlKey) parts.push('Ctrl');
        if (e.altKey) parts.push('Alt');
        if (e.shiftKey) parts.push('Shift');
        if (e.metaKey) parts.push('Meta');
        if (modifiersOnly) return parts.join('+');

        const key = e.key || '';
        if (MODIFIER_KEYS.has(key)) return null;
        parts.push(key.length === 1 ? key.toUpperCase() : key);
        return parts.join('+');
    }

    function conflictWith(def, combo) {
        if (!combo) return null;
        const clash = KEYBIND_DEFS.find(other => other.id !== def.id && bindFor(other) === combo);
        return clash ? clash.label : null;
    }

    function saveKeybinds() {
        chrome.storage.sync.set({ keybinds });
    }

    function endCapture() {
        if (!capture) return;
        window.removeEventListener('keydown', onCaptureKeydown, true);
        window.removeEventListener('keyup', onCaptureKeyup, true);
        capture = null;
        renderKeybinds();
    }

    function commitCapture(combo) {
        const def = capture.def;
        const clash = conflictWith(def, combo);
        if (clash) {
            capture.error = 'Already used by ' + clash;
            renderKeybinds();
            return;
        }
        keybinds[def.id] = combo;
        saveKeybinds();
        endCapture();
    }

    function onCaptureKeydown(e) {
        if (!capture) return;
        e.preventDefault();
        e.stopPropagation();

        if (e.key === 'Escape') {
            endCapture();
            return;
        }
        if (e.key === 'Backspace' || e.key === 'Delete') {
            commitCapture('');
            return;
        }

        if (MODIFIER_KEYS.has(e.key)) {
            // Modifier-only binds are committed on release, so Ctrl+Alt works.
            capture.held = comboFromEvent(e, true);
            capture.error = '';
            renderKeybinds();
            return;
        }

        if (capture.def.modifiersOnly) return;

        const combo = comboFromEvent(e, false);
        if (!combo) return;
        if (!e.ctrlKey && !e.altKey && !e.metaKey) {
            capture.error = 'Use at least one modifier';
            renderKeybinds();
            return;
        }
        commitCapture(combo);
    }

    function onCaptureKeyup(e) {
        if (!capture || !capture.held) return;
        if (!MODIFIER_KEYS.has(e.key)) return;
        if (e.ctrlKey || e.altKey || e.shiftKey || e.metaKey) return;
        commitCapture(capture.held);
    }

    function beginCapture(def) {
        endCapture();
        capture = { def: def, held: '', error: '' };
        window.addEventListener('keydown', onCaptureKeydown, true);
        window.addEventListener('keyup', onCaptureKeyup, true);
        renderKeybinds();
    }

    function renderKeybinds() {
        if (!keybindList) return;
        keybindList.innerHTML = '';

        KEYBIND_DEFS.forEach(def => {
            const capturing = !!capture && capture.def.id === def.id;
            const current = bindFor(def);

            const row = document.createElement('div');
            row.className = 'keybind-row keybind-row-editable' + (capturing ? ' capturing' : '');

            const info = document.createElement('div');
            info.className = 'keybind-info';

            const label = document.createElement('span');
            label.className = 'keybind-label';
            label.textContent = def.label;
            info.appendChild(label);

            const noteText = capturing
                ? (capture.error || (def.modifiersOnly ? 'Hold the modifiers, then release' : 'Press a combination · Esc cancels'))
                : def.note;
            if (noteText) {
                const note = document.createElement('span');
                note.className = 'keybind-note' + (capturing && capture.error ? ' keybind-error' : '');
                note.textContent = noteText;
                info.appendChild(note);
            }
            row.appendChild(info);

            const actions = document.createElement('div');
            actions.className = 'keybind-actions';

            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'keybind-key keybind-edit';
            btn.title = 'Click, then press the keys you want';
            btn.textContent = capturing ? (capture.held || 'Press keys…') : (current || 'Off');
            btn.addEventListener('click', () => (capturing ? endCapture() : beginCapture(def)));
            actions.appendChild(btn);

            if (current !== def.fallback) {
                const reset = document.createElement('button');
                reset.type = 'button';
                reset.className = 'keybind-reset-one';
                reset.title = 'Reset to ' + def.fallback;
                reset.textContent = '⟲';
                reset.addEventListener('click', () => {
                    delete keybinds[def.id];
                    saveKeybinds();
                    endCapture();
                    renderKeybinds();
                });
                actions.appendChild(reset);
            }

            row.appendChild(actions);
            keybindList.appendChild(row);
        });

        STATIC_KEYBINDS.forEach(item => {
            const row = document.createElement('div');
            row.className = 'keybind-row';
            const label = document.createElement('span');
            label.textContent = item.label;
            const key = document.createElement('span');
            key.className = 'keybind-key keybind-static';
            key.textContent = item.key;
            row.appendChild(label);
            row.appendChild(key);
            keybindList.appendChild(row);
        });
    }

    chrome.storage.sync.get(['keybinds'], (data) => {
        keybinds = data.keybinds || {};
        renderKeybinds();
    });

    chrome.storage.onChanged.addListener((changes, area) => {
        if (area === 'sync' && changes.keybinds && !capture) {
            keybinds = changes.keybinds.newValue || {};
            renderKeybinds();
        }
    });

    renderKeybinds();

    // ── Tab Switching ──────────────────────────────────

    const screenSettings = document.getElementById('screen-settings');
    const screenShortcuts = document.getElementById('screen-shortcuts');
    const footerHintText = document.getElementById('footer-hint-text');
    const keybindResetBtn = document.getElementById('keybind-reset');

    document.querySelectorAll('.popup-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.popup-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const target = tab.dataset.tab;
            if (target === 'shortcuts') {
                if (screenSettings) screenSettings.style.display = 'none';
                if (screenShortcuts) screenShortcuts.style.display = '';
                if (footerHintText) footerHintText.textContent = 'Configure in chrome://extensions/shortcuts';
            } else {
                if (screenSettings) screenSettings.style.display = '';
                if (screenShortcuts) screenShortcuts.style.display = 'none';
                if (footerHintText) footerHintText.textContent = 'Press Alt+P to read selected text';
            }
        });
    });

    const openChromeShortcuts = document.getElementById('open-chrome-shortcuts');
    if (openChromeShortcuts) {
        openChromeShortcuts.addEventListener('click', () => {
            chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
        });
    }

    if (keybindResetBtn) {
        keybindResetBtn.addEventListener('click', () => {
            setRate(1.0);
            if (pitchRange) pitchRange.value = 1.0;
            if (pitchValue) pitchValue.textContent = '1.0';
            paintRange(pitchRange);
            if (repeatToggle) repeatToggle.checked = false;
            
            // Set default voice
            const defaultVoice = allVoices.find(v => v.name === 'en-US-JennyNeural') || allVoices[0];
            if (defaultVoice) {
                currentVoice = defaultVoice.name;
                updateVoiceCardUI();
            }

            const resetInfo = getVoiceInfo(currentVoice);
            chrome.storage.sync.set({
                rate: '1.0',
                pitch: '1.0',
                repeat: false,
                voice: currentVoice,
                voiceEngine: resetInfo.engine || 'neural',
                voiceLang: resetInfo.lang || ''
            });

            const originalText = keybindResetBtn.textContent;
            keybindResetBtn.textContent = 'Reset!';
            setTimeout(() => {
                keybindResetBtn.textContent = originalText;
            }, 1200);
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
