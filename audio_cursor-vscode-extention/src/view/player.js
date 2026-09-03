/**
 * Audio Cursor Player Webview Script
 * Acts as the Speech Synthesis engine and interactive UI with full voice search, filtering, and preview.
 */

(function () {
  const vscode = acquireVsCodeApi();

  // State
  let currentSessionId = null;
  let currentSnapshot = null;
  let currentSettings = {
    voice: 'en-US-JennyNeural',
    rate: 1.0,
    pitch: 1.0,
    highlightWord: true,
    followCursor: true
  };
  let currentStatus = 'idle'; // 'idle' | 'starting' | 'playing' | 'paused' | 'stopped'
  let currentPercent = 0;
  let currentCharIndex = 0;

  let allVoices = [];
  let chunkQueue = [];
  let isSpeaking = false;

  // Filters for voice browser
  let voiceSearchQuery = '';
  let activeLangFilter = 'all';
  let activeGenderFilter = 'all';
  let activeTypeFilter = 'all';

  // Neural audio playback state (Web Audio API Engine)
  let audioCtx = null;
  let currentSourceNode = null;
  let activeChunk = null;
  let chunkStartTime = 0;
  let chunkDuration = 0;
  let timeUpdateInterval = null;
  let isAudioPaused = false;
  let pauseTimestamp = 0;
  let totalPausedDuration = 0;
  let neuralAudioCache = new Map(); // chunkIndex -> audioBase64
  let currentPlayingChunk = null;
  let pendingAudioChunk = null;
  let pendingLocalChunk = null;
  let hasUserGesture = false;
  let startingWatchdog = null;

  // DOM Elements
  const elEmptyState = document.getElementById('empty-state');
  const elPlayerContent = document.getElementById('player-content');
  const elGestureBanner = document.getElementById('gesture-banner');
  const elGestureBtn = document.getElementById('btn-gesture-activate');
  const elStatusBadge = document.getElementById('status-badge');
  const elStatusText = document.getElementById('status-text');

  const elPlayPauseBtn = document.getElementById('btn-play-pause');
  const elPlayPauseIcon = document.getElementById('icon-play-pause');
  const elPlayPauseText = document.getElementById('text-play-pause');
  const elStopBtn = document.getElementById('btn-stop');
  const elPrevBtn = document.getElementById('btn-prev');
  const elNextBtn = document.getElementById('btn-next');

  const elReadTerminalBtn = document.getElementById('btn-read-terminal');
  const elPlayerNoticeSlot = document.getElementById('player-notice-slot');
  const elPlayerNoticeText = document.getElementById('player-notice-text');
  const elSourceIcon = document.getElementById('source-icon');
  const elSourceName = document.getElementById('source-name');
  const elSourceSub = document.getElementById('source-sub');
  const elSourceKind = document.getElementById('source-kind');
  const elVisualizerBars = document.getElementById('visualizer-bars');

  const elScrubTrack = document.getElementById('scrub-track');
  const elScrubFill = document.getElementById('scrub-fill');
  const elScrubThumb = document.getElementById('scrub-thumb');
  const elTimeElapsed = document.getElementById('time-elapsed');
  const elTimeRemaining = document.getElementById('time-remaining');

  const elTextContainer = document.getElementById('text-container');
  const elTextFileName = document.getElementById('text-filename');
  const elTextStats = document.getElementById('text-stats');
  const elCopyTextBtn = document.getElementById('btn-copy-text');

  // Voice Card & Modal Elements
  const elVoiceCard = document.getElementById('btn-open-voice-modal');
  const elCurrentVoiceFlag = document.getElementById('current-voice-flag');
  const elCurrentVoiceName = document.getElementById('current-voice-name');
  const elCurrentVoiceBadge = document.getElementById('current-voice-badge');
  const elCurrentVoiceCountry = document.getElementById('current-voice-country');
  const elCurrentVoiceGender = document.getElementById('current-voice-gender');
  const elVoiceCountSummary = document.getElementById('voice-count-summary');

  const elVoiceModal = document.getElementById('voice-modal');
  const elCloseVoiceModal = document.getElementById('btn-close-voice-modal');
  const elVoiceSearchInput = document.getElementById('voice-search-input');
  const elClearSearchBtn = document.getElementById('btn-clear-search');
  const elVoiceModalList = document.getElementById('voice-modal-list');
  const elModalVoiceCount = document.getElementById('modal-voice-count');

  // Settings
  const elRateSlider = document.getElementById('setting-rate');
  const elRateVal = document.getElementById('rate-val');
  const elPitchSlider = document.getElementById('setting-pitch');
  const elPitchVal = document.getElementById('pitch-val');
  const elHighlightWord = document.getElementById('setting-highlight-word');
  const elFollowCursor = document.getElementById('setting-follow-cursor');
  const elSettingsLink = document.getElementById('link-more-settings');

  // SVG Icons
  const SVG_FILE = '<svg viewBox="0 0 16 16"><path d="M9 1H3a1 1 0 0 0-1 1v12a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1V6l-5-5zm0 1.5L12.5 6H9V2.5zM3 14V2h5v5h5v7H3z"/></svg>';
  const SVG_TERMINAL = '<svg viewBox="0 0 16 16"><path d="M1.5 2h13a.5.5 0 0 1 .5.5v11a.5.5 0 0 1-.5.5h-13a.5.5 0 0 1-.5-.5v-11a.5.5 0 0 1 .5-.5zM2 13h12V3H2v10zm1.35-7.85l.7-.7L7.2 7.6a.5.5 0 0 1 0 .7l-3.15 3.16-.7-.71L6.15 8 3.35 5.15zM8 10.5h4v1H8v-1z"/></svg>';
  const SVG_PREVIEW = '<svg viewBox="0 0 16 16"><path d="M8 3C4.5 3 1.7 5.2 1 8c.7 2.8 3.5 5 7 5s6.3-2.2 7-5c-.7-2.8-3.5-5-7-5zm0 8.5A3.5 3.5 0 1 1 8 4.5a3.5 3.5 0 0 1 0 7zm0-5.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4z"/></svg>';
  const SVG_PLAY = '<svg viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5-9-5.5z"/></svg>';
  const SVG_PAUSE = '<svg viewBox="0 0 16 16"><path d="M3.5 2h3v12h-3V2zm6 0h3v12h-3V2z"/></svg>';
  // Not a transport glyph: it fills the icon slot while the first chunk is being
  // synthesized, so the button never shows "Pause" before anything is audible.
  const HTML_SPINNER = '<span class="btn-spin"></span>';

  // --- Voice Discovery & Helper Functions ---

  function loadLocalVoices() {
    if (!('speechSynthesis' in window)) return;
    const list = window.speechSynthesis.getVoices() || [];
    if (list.length > 0) {
      vscode.postMessage({
        type: 'voices',
        voices: list.map(v => ({
          name: v.name,
          displayName: `${v.name} (Local)`,
          cleanName: v.name,
          country: 'Local System',
          flag: '💻',
          lang: v.lang,
          default: v.default,
          localService: true,
          isNeural: false,
          voiceURI: v.voiceURI
        }))
      });
    }
  }

  if ('speechSynthesis' in window) {
    loadLocalVoices();
    window.speechSynthesis.onvoiceschanged = () => {
      loadLocalVoices();
    };
  }

  function isNeuralVoice(voiceName) {
    if (!voiceName) return false;
    const v = allVoices.find(x => x.name === voiceName || x.voiceURI === voiceName);
    return v ? Boolean(v.isNeural) : voiceName.includes('Neural');
  }

  function getVoiceInfo(voiceName) {
    if (!voiceName) {
      return {
        name: '',
        cleanName: 'Jenny (US)',
        country: 'United States',
        languageName: 'English',
        countryCode: 'US',
        flag: 'US',
        gender: 'Female',
        isNeural: true
      };
    }
    const found = allVoices.find(v => v.name === voiceName || v.voiceURI === voiceName);
    if (found) return found;

    const langParts = voiceName.split('-');
    const countryCode = langParts[1] ? langParts[1].substring(0, 2).toUpperCase() : 'AI';

    return {
      name: voiceName,
      cleanName: voiceName.replace(/^[a-z]{2,3}-[A-Z]{2,4}-/, '').replace(/Neural$/, '').replace(/Multilingual$/, ' (Multi)'),
      country: voiceName.startsWith('en-') ? 'United States' : 'Natural AI',
      languageName: 'English',
      countryCode: countryCode,
      flag: countryCode,
      gender: 'AI',
      isNeural: voiceName.includes('Neural')
    };
  }

  function updateVoiceCardUI() {
    const v = getVoiceInfo(currentSettings.voice);
    if (elCurrentVoiceFlag) elCurrentVoiceFlag.textContent = v.countryCode || 'US';
    if (elCurrentVoiceName) elCurrentVoiceName.textContent = v.cleanName || v.name || 'Default';
    if (elCurrentVoiceCountry) elCurrentVoiceCountry.textContent = v.country || 'United States';
    if (elCurrentVoiceGender) elCurrentVoiceGender.textContent = v.gender || (v.isNeural ? 'Female' : 'Local');

    if (elCurrentVoiceBadge) {
      elCurrentVoiceBadge.textContent = v.isNeural ? 'Natural AI' : 'Offline';
      elCurrentVoiceBadge.className = 'tag ' + (v.isNeural ? 'tag-neural' : 'tag-offline');
    }

    if (elVoiceCountSummary) {
      elVoiceCountSummary.textContent = `${allVoices.length || 325} voices`;
    }
  }

  // --- Voice Browser Modal Rendering & Filtering ---

  function openVoiceModal() {
    if (elVoiceModal) {
      elVoiceModal.style.display = 'flex';
      if (elVoiceSearchInput) {
        elVoiceSearchInput.value = voiceSearchQuery;
        elVoiceSearchInput.focus();
      }
      renderVoiceModalList();
    }
  }

  function closeVoiceModal() {
    if (elVoiceModal) {
      elVoiceModal.style.display = 'none';
    }
    stopPreviewAudio();
  }

  function getFilteredVoices() {
    return allVoices.filter(v => {
      // 1. Search Query
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

      // 2. Language Filter
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

      // 3. Gender Filter
      if (activeGenderFilter !== 'all') {
        if (v.gender && v.gender !== activeGenderFilter) {
          return false;
        }
      }

      // 4. Type Filter
      if (activeTypeFilter === 'neural' && !v.isNeural) return false;
      if (activeTypeFilter === 'local' && v.isNeural) return false;

      return true;
    });
  }

  function renderVoiceModalList() {
    if (!elVoiceModalList) return;
    const filtered = getFilteredVoices();
    if (elModalVoiceCount) elModalVoiceCount.textContent = `${filtered.length} of ${allVoices.length || 325}`;

    elVoiceModalList.innerHTML = '';

    if (filtered.length === 0) {
      elVoiceModalList.innerHTML = `
        <div class="empty-state" style="padding: 30px 10px;">
          <div class="empty-state-title">No matching voices</div>
          <div class="empty-state-text">Try searching for a different language, country, or accent.</div>
        </div>
      `;
      return;
    }

    const fragment = document.createDocumentFragment();

    filtered.forEach(v => {
      const isSelected = v.name === currentSettings.voice || (v.name === '' && !currentSettings.voice);
      const itemEl = document.createElement('div');
      itemEl.className = 'voice-list-item' + (isSelected ? ' selected' : '');

      const genderClass = v.gender === 'Female' ? 'tag-female' : (v.gender === 'Male' ? 'tag-male' : '');
      const typeBadge = v.isNeural ? '<span class="tag tag-neural">Natural AI</span>' : '<span class="tag tag-offline">Offline</span>';
      const genderBadge = v.gender ? `<span class="tag ${genderClass}">${v.gender}</span>` : '';
      const checkmark = isSelected ? '<span class="selected-checkmark" title="Active Voice">✓ Selected</span>' : '';
      const cCode = v.countryCode || (v.lang ? (v.lang.split('-')[1] || v.lang.substring(0,2)).toUpperCase() : 'AI');

      itemEl.innerHTML = `
        <div class="voice-item-left">
          <div class="voice-avatar-mini"><span class="avatar-code">${cCode}</span></div>
          <div class="voice-item-details">
            <div class="voice-item-name">
              <span class="voice-name-title">${v.cleanName || v.name}</span>
              ${typeBadge}
              ${genderBadge}
              ${checkmark}
            </div>
            <div class="voice-item-sub">
              ${v.country || ''} • ${v.languageName || v.lang || ''}
            </div>
          </div>
        </div>
        <div class="voice-item-actions">
          <button class="btn-preview" data-voice="${v.name}" title="Listen to a voice sample">
            <svg class="preview-svg" viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5-9-5.5z"/></svg>
            <span>Preview</span>
          </button>
        </div>
      `;

      itemEl.addEventListener('click', (e) => {
        if (e.target && e.target.closest('.btn-preview')) return;
        selectVoice(v.name);
      });

      const previewBtn = itemEl.querySelector('.btn-preview');
      if (previewBtn) {
        previewBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          previewVoice(v, previewBtn);
        });
      }

      fragment.appendChild(itemEl);
    });

    elVoiceModalList.appendChild(fragment);
  }

  function selectVoice(voiceName) {
    currentSettings.voice = voiceName;
    updateVoiceCardUI();
    post({ type: 'setSetting', key: 'voice', value: voiceName });
    closeVoiceModal();
  }

  let currentPreviewBtn = null;

  function stopPreviewAudio() {
    if (currentPreviewBtn) {
      currentPreviewBtn.classList.remove('playing');
      currentPreviewBtn.innerHTML = '<svg class="preview-svg" viewBox="0 0 16 16"><path d="M4 2.5v11l9-5.5-9-5.5z"/></svg><span>Preview</span>';
      currentPreviewBtn = null;
    }
    stopCurrentAudioSource();
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
  }

  function previewVoice(voice, btnEl) {
    stopPreviewAudio();
    if (btnEl) {
      currentPreviewBtn = btnEl;
      btnEl.classList.add('playing');
      btnEl.innerHTML = '<span style="font-size:10px;">🔊</span><span>Playing...</span>';
    }
    const sampleText = `Hi! I am ${voice.cleanName || voice.name}, an audio voice for your editor.`;

    if (voice.isNeural) {
      post({
        type: 'requestNeuralAudio',
        sessionId: 'preview-' + Date.now(),
        chunkIndex: -1,
        text: sampleText,
        voice: voice.name,
        rate: 1.0,
        pitch: 1.0
      });
    } else {
      if ('speechSynthesis' in window) {
        window.speechSynthesis.cancel();
        const utt = new SpeechSynthesisUtterance(sampleText);
        const localList = window.speechSynthesis.getVoices() || [];
        const match = localList.find(v => v.name === voice.name);
        if (match) utt.voice = match;
        utt.onend = () => {
          stopPreviewAudio();
        };
        utt.onerror = () => {
          stopPreviewAudio();
        };
        window.speechSynthesis.speak(utt);
      }
    }
  }

  // --- Accordion Sections & State Persistence ---

  document.querySelectorAll('.section-header').forEach(header => {
    header.addEventListener('click', () => {
      const section = header.closest('.section');
      if (section) {
        section.classList.toggle('collapsed');
        savePersistedState();
      }
    });
  });

  function savePersistedState() {
    const collapsedSections = [];
    document.querySelectorAll('.section.collapsed').forEach(s => {
      if (s.id) collapsedSections.push(s.id);
    });
    vscode.setState({ collapsedSections });
  }

  function restorePersistedState() {
    const state = vscode.getState();
    if (state && state.collapsedSections) {
      for (const id of state.collapsedSections) {
        const el = document.getElementById(id);
        if (el) el.classList.add('collapsed');
      }
    }
  }

  restorePersistedState();

  // --- UI Event Handlers ---

  function post(msg) {
    vscode.postMessage(msg);
  }

  // The webview has its own console that nothing outside it can see, so a script
  // error in here reads as "the player is stuck" with no trace anywhere. Send it
  // to the Audio Cursor output channel instead.
  window.addEventListener('error', (e) => {
    post({
      type: 'clientError',
      message: (e && e.message) || 'Unknown player error',
      stack: e && e.error && e.error.stack
    });
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e && e.reason;
    post({
      type: 'clientError',
      message: 'Unhandled rejection: ' + ((reason && reason.message) || String(reason)),
      stack: reason && reason.stack
    });
  });

  function showGestureBanner() {
    if (elGestureBanner) {
      elGestureBanner.style.display = 'flex';
    }
  }

  function hideGestureBanner() {
    if (elGestureBanner) {
      elGestureBanner.style.display = 'none';
    }
  }

  /**
   * Resume the AudioContext and report whether it is actually running.
   * Chromium blocks audio until the webview document has had a user gesture,
   * and it can re-suspend the context later (e.g. when the view is hidden),
   * so this must be re-checked before every chunk instead of once per session.
   * @returns {Promise<boolean>}
   */
  async function ensureAudioRunning() {
    const ctx = getAudioContext();
    if (!ctx) return false;
    if (ctx.state === 'running') return true;
    try {
      await ctx.resume();
    } catch (_) {}
    return ctx.state === 'running';
  }

  /** Play an inaudible buffer to fully unlock the output device after a gesture. */
  function primeAudioOutput(ctx) {
    try {
      const buffer = ctx.createBuffer(1, 1, ctx.sampleRate);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.start(0);
    } catch (_) {}
  }

  async function triggerGestureUnlock() {
    hideGestureBanner();
    const running = await ensureAudioRunning();
    hasUserGesture = running;
    if (running) {
      primeAudioOutput(audioCtx);
    }

    if (pendingAudioChunk) {
      const { chunk, audioBase64 } = pendingAudioChunk;
      pendingAudioChunk = null;
      updateStatusUI('starting');
      startNeuralAudioChunk(chunk, audioBase64);
    } else if (pendingLocalChunk) {
      const chunk = pendingLocalChunk;
      pendingLocalChunk = null;
      updateStatusUI('starting');
      playLocalUtterance(chunk);
    }
  }

  // Chromium may re-suspend the context while the sidebar view is hidden.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && isSpeaking && !isAudioPaused) {
      ensureAudioRunning();
    }
  });

  window.addEventListener('click', triggerGestureUnlock, true);
  window.addEventListener('pointerdown', triggerGestureUnlock, true);
  window.addEventListener('keydown', triggerGestureUnlock, true);

  if (elGestureBanner) {
    elGestureBanner.addEventListener('click', triggerGestureUnlock);
  }
  if (elGestureBtn) {
    elGestureBtn.addEventListener('click', triggerGestureUnlock);
  }

  if (elVoiceCard) {
    elVoiceCard.addEventListener('click', openVoiceModal);
  }
  if (elCloseVoiceModal) {
    elCloseVoiceModal.addEventListener('click', closeVoiceModal);
  }

  if (elVoiceModal) {
    elVoiceModal.addEventListener('click', (e) => {
      if (e.target === elVoiceModal) closeVoiceModal();
    });
  }

  if (elVoiceSearchInput) {
    elVoiceSearchInput.addEventListener('input', () => {
      voiceSearchQuery = elVoiceSearchInput.value.trim();
      if (elClearSearchBtn) {
        elClearSearchBtn.style.display = elVoiceSearchInput.value ? 'flex' : 'none';
      }
      renderVoiceModalList();
    });
  }

  if (elClearSearchBtn) {
    elClearSearchBtn.addEventListener('click', () => {
      if (elVoiceSearchInput) {
        elVoiceSearchInput.value = '';
        voiceSearchQuery = '';
        elClearSearchBtn.style.display = 'none';
        elVoiceSearchInput.focus();
        renderVoiceModalList();
      }
    });
  }

  if (elCopyTextBtn) {
    elCopyTextBtn.addEventListener('click', () => {
      if (currentSnapshot && currentSnapshot.text) {
        navigator.clipboard.writeText(currentSnapshot.text).then(() => {
          const originalHTML = elCopyTextBtn.innerHTML;
          elCopyTextBtn.innerHTML = '<span style="font-size:11px; color:#22c55e; font-weight:bold;">✓</span>';
          setTimeout(() => {
            elCopyTextBtn.innerHTML = originalHTML;
          }, 1500);
        }).catch(() => {});
      }
    });
  }

  // Custom Filter Dropdowns (Matching Browser Extension)
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
        if (valSpan) valSpan.innerHTML = item.innerHTML;
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

  // Speed Pills Click Listeners
  document.querySelectorAll('.speed-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const speed = parseFloat(pill.dataset.speed);
      if (!isNaN(speed)) {
        setSpeed(speed);
      }
    });
  });

  function updateRangeFill(slider) {
    if (!slider) return;
    const min = parseFloat(slider.min) || 0;
    const max = parseFloat(slider.max) || 100;
    const val = parseFloat(slider.value) || 0;
    const percent = Math.max(0, Math.min(100, ((val - min) / (max - min)) * 100));
    slider.style.setProperty('--val', `${percent}%`);
    slider.style.background = `linear-gradient(to right, var(--vscode-button-background, #007acc) 0%, var(--vscode-button-background, #007acc) ${percent}%, rgba(128, 128, 128, 0.25) ${percent}%, rgba(128, 128, 128, 0.25) 100%)`;
  }

  function setSpeed(speedVal) {
    currentSettings.rate = speedVal;
    if (elRateSlider) {
      elRateSlider.value = speedVal;
      updateRangeFill(elRateSlider);
    }
    if (elRateVal) elRateVal.textContent = speedVal.toFixed(1) + 'x';
    document.querySelectorAll('.speed-pill').forEach(p => {
      p.classList.toggle('active', parseFloat(p.dataset.speed) === speedVal);
    });
    post({ type: 'setSetting', key: 'rate', value: speedVal });
  }

  elPlayPauseBtn.addEventListener('click', () => {
    // Nothing is playing yet — either the first chunk is still being prepared,
    // or Chromium is holding audio back until this document sees a gesture.
    // This click IS that gesture (the capture-phase listener has already used
    // it), so start playback rather than sending a transport command the host
    // would ignore or, worse, act on while audio is coming up.
    if (currentStatus === 'starting' || currentStatus === 'blocked') {
      // This click is the user gesture Chromium is waiting for. If a chunk is
      // parked on it, releasing it is all that is needed. If nothing is parked
      // then the pipeline stalled somewhere upstream, so ask the host to start
      // over — never leave the button doing nothing at all.
      const hasParkedChunk = Boolean(pendingAudioChunk || pendingLocalChunk);
      triggerGestureUnlock();
      if (!hasParkedChunk) {
        post({
          type: 'command',
          action: 'play',
          source: currentSnapshot ? currentSnapshot.source : undefined
        });
      }
      return;
    }
    if (currentStatus === 'playing') {
      post({ type: 'command', action: 'pause' });
    } else if (currentStatus === 'paused') {
      post({ type: 'command', action: 'resume' });
    } else {
      post({
        type: 'command',
        action: 'play',
        source: currentSnapshot ? currentSnapshot.source : undefined
      });
    }
  });

  elStopBtn.addEventListener('click', () => {
    post({ type: 'command', action: 'stop' });
  });

  if (elReadTerminalBtn) {
    elReadTerminalBtn.addEventListener('click', () => {
      post({ type: 'command', action: 'readTerminal' });
    });
  }

  elPrevBtn.addEventListener('click', () => {
    post({ type: 'command', action: 'previousSentence' });
  });

  elNextBtn.addEventListener('click', () => {
    post({ type: 'command', action: 'nextSentence' });
  });

  const elKeybindingsBtn = document.getElementById('btn-keybindings');
  if (elKeybindingsBtn) {
    elKeybindingsBtn.addEventListener('click', () => {
      post({ type: 'command', action: 'openKeybindings' });
    });
  }

  if (elSettingsLink) {
    elSettingsLink.addEventListener('click', (e) => {
      e.preventDefault();
      post({ type: 'command', action: 'openSettings' });
    });
  }

  // Scrub bar interaction
  let isScrubbing = false;
  function handleScrub(e) {
    if (!currentSnapshot || !currentSnapshot.text) return;
    const rect = elScrubTrack.getBoundingClientRect();
    const frac = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    const targetChar = Math.round(frac * currentSnapshot.text.length);
    updateProgressUI(frac * 100, targetChar);
    post({ type: 'command', action: 'seek', charIndex: targetChar });
  }

  elScrubTrack.addEventListener('mousedown', (e) => {
    isScrubbing = true;
    elScrubTrack.classList.add('scrubbing');
    handleScrub(e);
  });

  window.addEventListener('mousemove', (e) => {
    if (isScrubbing) handleScrub(e);
  });

  window.addEventListener('mouseup', () => {
    isScrubbing = false;
    elScrubTrack.classList.remove('scrubbing');
  });

  if (elRateSlider) {
    updateRangeFill(elRateSlider);
    elRateSlider.addEventListener('input', () => {
      const val = parseFloat(elRateSlider.value);
      elRateVal.textContent = val.toFixed(1) + 'x';
      updateRangeFill(elRateSlider);
      document.querySelectorAll('.speed-pill').forEach(p => {
        p.classList.toggle('active', parseFloat(p.dataset.speed) === val);
      });
    });

    elRateSlider.addEventListener('change', () => {
      const val = parseFloat(elRateSlider.value);
      currentSettings.rate = val;
      updateRangeFill(elRateSlider);
      post({ type: 'setSetting', key: 'rate', value: val });
    });
  }

  if (elPitchSlider) {
    updateRangeFill(elPitchSlider);
    elPitchSlider.addEventListener('input', () => {
      const val = parseFloat(elPitchSlider.value);
      elPitchVal.textContent = val.toFixed(1);
      updateRangeFill(elPitchSlider);
    });

    elPitchSlider.addEventListener('change', () => {
      const val = parseFloat(elPitchSlider.value);
      currentSettings.pitch = val;
      updateRangeFill(elPitchSlider);
      post({ type: 'setSetting', key: 'pitch', value: val });
    });
  }

  elHighlightWord.addEventListener('change', () => {
    currentSettings.highlightWord = elHighlightWord.checked;
    post({ type: 'setSetting', key: 'highlightWord', value: elHighlightWord.checked });
  });

  elFollowCursor.addEventListener('change', () => {
    currentSettings.followCursor = elFollowCursor.checked;
    post({ type: 'setSetting', key: 'followCursor', value: elFollowCursor.checked });
  });

  // --- Text Container Rendering ---

  function renderTextPane(snapshot) {
    if (!snapshot || !snapshot.text) {
      elEmptyState.style.display = 'flex';
      elPlayerContent.style.display = 'none';
      return;
    }

    elEmptyState.style.display = 'none';
    elPlayerContent.style.display = 'flex';

    elTextFileName.textContent = snapshot.fileName || 'Selection';
    elTextStats.textContent = `${snapshot.wordCount || 0} words · ${snapshot.charCount || snapshot.text.length} chars`;
    updateSourceCard(snapshot);

    elTextContainer.innerHTML = '';
    const text = snapshot.text;

    if (text.length < 25000) {
      const fragment = document.createDocumentFragment();
      const regex = /\S+|\s+/g;
      let match;

      while ((match = regex.exec(text)) !== null) {
        const token = match[0];
        const start = match.index;
        const end = start + token.length;

        if (/\s+/.test(token)) {
          fragment.appendChild(document.createTextNode(token));
        } else {
          const span = document.createElement('span');
          span.className = 'word';
          span.textContent = token;
          span.dataset.start = start;
          span.dataset.end = end;
          span.addEventListener('click', () => {
            post({ type: 'command', action: 'seek', charIndex: start });
          });
          fragment.appendChild(span);
        }
      }

      elTextContainer.appendChild(fragment);
    } else {
      elTextContainer.textContent = text;
    }
  }

  function highlightWordInTextPane(charIndex) {
    if (!elTextContainer) return;
    const prevActive = elTextContainer.querySelector('.word.active');
    if (prevActive) {
      prevActive.classList.remove('active');
    }

    const words = elTextContainer.querySelectorAll('.word');
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const start = parseInt(w.dataset.start, 10);
      const end = parseInt(w.dataset.end, 10);
      if (charIndex >= start && charIndex < end) {
        w.classList.add('active');
        w.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        break;
      }
    }
  }

  function showNotice(text) {
    if (!elPlayerNoticeSlot || !elPlayerNoticeText) return;
    if (!text) {
      // Keep the text in place while the slot collapses — clearing it would
      // make the notice blank out a frame before it finishes animating.
      elPlayerNoticeSlot.classList.remove('open');
      return;
    }
    elPlayerNoticeText.textContent = text;
    elPlayerNoticeSlot.classList.add('open');
  }

  function estimateSeconds(wordCount) {
    const rate = currentSettings.rate || 1.0;
    return Math.max(1, Math.round((wordCount / (200 * rate)) * 60));
  }

  function updateSourceCard(snapshot) {
    if (!elSourceName) return;
    const source = (snapshot && snapshot.source) || 'editor';
    const isTerminal = source === 'terminal';
    const isPreview = source === 'preview';
    const words = (snapshot && snapshot.wordCount) || 0;

    if (elSourceIcon) {
      elSourceIcon.innerHTML = isTerminal ? SVG_TERMINAL : (isPreview ? SVG_PREVIEW : SVG_FILE);
    }
    elSourceName.textContent = (snapshot && snapshot.fileName) || 'Selection';
    elSourceName.title = elSourceName.textContent;

    if (elSourceSub) {
      const parts = [`${words} word${words === 1 ? '' : 's'}`, `~${formatTime(estimateSeconds(words))}`];
      if (snapshot && snapshot.fromCursor) parts.push('from cursor');
      elSourceSub.textContent = parts.join(' · ');
    }

    if (elSourceKind) {
      elSourceKind.textContent = isTerminal ? 'Terminal' : (isPreview ? 'Preview' : 'Editor');
      elSourceKind.className = 'tag ' + (isTerminal ? 'tag-terminal' : (isPreview ? 'tag-preview' : 'tag-editor'));
    }
  }

  function updateProgressUI(percent, charIndex) {
    currentPercent = Math.max(0, Math.min(100, percent));
    currentCharIndex = charIndex || 0;
    elScrubFill.style.width = `${currentPercent}%`;
    if (elScrubThumb) elScrubThumb.style.left = `${currentPercent}%`;

    if (currentSnapshot && currentSnapshot.text) {
      const totalChars = currentSnapshot.text.length;
      const rate = currentSettings.rate || 1.0;
      const totalSeconds = Math.round(((totalChars / 5) / (200 * rate)) * 60);
      const elapsedSeconds = Math.round(((currentCharIndex / Math.max(1, totalChars)) * totalSeconds));
      const remainingSeconds = Math.max(0, totalSeconds - elapsedSeconds);

      elTimeElapsed.textContent = formatTime(elapsedSeconds);
      elTimeRemaining.textContent = `-${formatTime(remainingSeconds)}`;
    }
  }

  function formatTime(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  // Neural chunks are synthesized over the network, so a second or two on the
  // spinner is normal. A stall that outlasts this must not strand the user on a
  // spinner, so it drops to a state whose button actually starts something.
  const STARTING_TIMEOUT = 6000;

  function updateStatusUI(status) {
    currentStatus = status;
    if (startingWatchdog) {
      clearTimeout(startingWatchdog);
      startingWatchdog = null;
    }
    if (elVisualizerBars) {
      elVisualizerBars.classList.toggle('active', status === 'playing');
    }
    if (status === 'starting') {
      // Requested, but silent: the first chunk is still being synthesized and
      // decoded. Claiming 'playing' here is what made the button read "Pause"
      // on the very first Alt+P of a session.
      elPlayPauseIcon.innerHTML = HTML_SPINNER;
      elPlayPauseText.textContent = 'Loading';
      elStopBtn.disabled = false;
      elStatusBadge.className = 'status-badge starting';
      elStatusText.textContent = 'Loading';
      startingWatchdog = setTimeout(() => {
        if (currentStatus === 'starting') updateStatusUI('blocked');
      }, STARTING_TIMEOUT);
      return;
    }

    if (status === 'blocked') {
      // Chromium will not let a webview start audio until the document has had
      // a user gesture, and Alt+P is handled by VS Code, so this document never
      // sees one. The audio is ready and parked; a single click releases it.
      elPlayPauseIcon.innerHTML = SVG_PLAY;
      elPlayPauseText.textContent = 'Play';
      elStopBtn.disabled = false;
      elStatusBadge.className = 'status-badge blocked';
      elStatusText.textContent = 'Tap to play';
      return;
    }

    if (status === 'playing') {
      elPlayPauseIcon.innerHTML = SVG_PAUSE;
      elPlayPauseText.textContent = 'Pause';
      elStopBtn.disabled = false;
      elStatusBadge.className = 'status-badge playing';
      elStatusText.textContent = `Playing ${Math.round(currentPercent)}%`;
    } else if (status === 'paused') {
      elPlayPauseIcon.innerHTML = SVG_PLAY;
      elPlayPauseText.textContent = 'Resume';
      elStopBtn.disabled = false;
      elStatusBadge.className = 'status-badge paused';
      elStatusText.textContent = `Paused ${Math.round(currentPercent)}%`;
    } else {
      elPlayPauseIcon.innerHTML = SVG_PLAY;
      elPlayPauseText.textContent = 'Play';
      elStopBtn.disabled = status === 'idle' || status === 'stopped';
      elStatusBadge.className = 'status-badge ready';
      elStatusText.textContent = 'Ready';
    }
  }

  // --- Dual Speech Engine (Web Audio API & Local Web Speech API) ---

  function getAudioContext() {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (AudioContextClass) {
        audioCtx = new AudioContextClass();
      }
    }
    return audioCtx;
  }

  function base64ToArrayBuffer(base64) {
    const binary = atob(base64);
    const len = binary.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  function stopTimeTracking() {
    if (timeUpdateInterval) {
      clearInterval(timeUpdateInterval);
      timeUpdateInterval = null;
    }
  }

  function startTimeTracking(sid, chunk, duration) {
    stopTimeTracking();
    timeUpdateInterval = setInterval(() => {
      if (sid !== currentSessionId || !audioCtx || !currentSourceNode || isAudioPaused) return;
      const now = audioCtx.currentTime;
      const elapsed = Math.max(0, (now - chunkStartTime) - totalPausedDuration);
      const frac = Math.min(1, Math.max(0, elapsed / Math.max(0.1, duration)));
      const chunkLen = chunk.end - chunk.start;
      const globalChar = chunk.start + Math.floor(frac * chunkLen);

      post({
        type: 'progress',
        sessionId: sid,
        charIndex: globalChar,
        chunkIndex: chunk.index
      });

      highlightWordInTextPane(globalChar);
      if (currentSnapshot && currentSnapshot.text) {
        updateProgressUI((globalChar / currentSnapshot.text.length) * 100, globalChar);
      }
    }, 35);
  }

  function stopCurrentAudioSource() {
    stopTimeTracking();
    if (currentSourceNode) {
      try {
        currentSourceNode.onended = null;
        currentSourceNode.stop();
        currentSourceNode.disconnect();
      } catch (_) {}
      currentSourceNode = null;
    }
    activeChunk = null;
  }

  function stopSynthesis() {
    stopCurrentAudioSource();
    if ('speechSynthesis' in window) {
      window.speechSynthesis.cancel();
    }
    chunkQueue = [];
    neuralAudioCache.clear();
    currentPlayingChunk = null;
    pendingAudioChunk = null;
    pendingLocalChunk = null;
    hideGestureBanner();
    isSpeaking = false;
    isAudioPaused = false;
    totalPausedDuration = 0;
  }

  function playNextChunk() {
    if (chunkQueue.length === 0 || !isSpeaking) {
      if (isSpeaking && !currentSourceNode) {
        post({ type: 'ended', sessionId: currentSessionId });
        stopSynthesis();
        updateStatusUI('stopped');
      }
      return;
    }

    const chunk = chunkQueue.shift();
    currentPlayingChunk = chunk;

    const useNeural = isNeuralVoice(currentSettings.voice);

    if (useNeural) {
      playNeuralChunk(chunk);
      // Pre-fetch next chunk
      if (chunkQueue.length > 0) {
        const nextChunk = chunkQueue[0];
        if (!neuralAudioCache.has(nextChunk.index)) {
          post({
            type: 'requestNeuralAudio',
            sessionId: currentSessionId,
            chunkIndex: nextChunk.index,
            text: nextChunk.spokenText || nextChunk.text,
            voice: currentSettings.voice || 'en-US-JennyNeural',
            rate: currentSettings.rate || 1.0,
            pitch: currentSettings.pitch || 1.0
          });
        }
      }
    } else {
      playLocalUtterance(chunk);
    }
  }

  function playNeuralChunk(chunk) {
    const sid = currentSessionId;
    const textToSpeak = chunk.spokenText || chunk.text;

    if (!textToSpeak || !textToSpeak.trim()) {
      post({ type: 'chunkEnded', sessionId: sid, chunkIndex: chunk.index });
      playNextChunk();
      return;
    }

    const cachedBase64 = neuralAudioCache.get(chunk.index);
    if (cachedBase64) {
      startNeuralAudioChunk(chunk, cachedBase64);
    } else {
      post({
        type: 'requestNeuralAudio',
        sessionId: sid,
        chunkIndex: chunk.index,
        text: textToSpeak,
        voice: currentSettings.voice || 'en-US-JennyNeural',
        rate: currentSettings.rate || 1.0,
        pitch: currentSettings.pitch || 1.0
      });
    }
  }

  async function startNeuralAudioChunk(chunk, audioBase64) {
    const sid = currentSessionId;
    if (sid !== currentSessionId) return;

    stopCurrentAudioSource();

    try {
      const ctx = getAudioContext();
      if (!ctx) {
        throw new Error('Web Audio API not supported in this environment');
      }

      // The context can be suspended at any point (no gesture yet, or the
      // view was hidden). Starting a source on a suspended context plays
      // nothing at all, so park the chunk and wait for a click instead.
      const running = await ensureAudioRunning();
      if (sid !== currentSessionId) return;
      if (!running) {
        hasUserGesture = false;
        pendingAudioChunk = { chunk, audioBase64 };
        showGestureBanner();
        updateStatusUI('blocked');
        post({ type: 'requireGesture', sessionId: sid });
        return;
      }

      const arrayBuffer = base64ToArrayBuffer(audioBase64);
      const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));

      if (sid !== currentSessionId) return;

      const source = ctx.createBufferSource();
      source.buffer = audioBuffer;
      source.connect(ctx.destination);
      currentSourceNode = source;
      activeChunk = chunk;
      chunkDuration = audioBuffer.duration || 1;
      chunkStartTime = ctx.currentTime;
      totalPausedDuration = 0;
      isAudioPaused = false;

      hideGestureBanner();
      hasUserGesture = true;
      if (currentStatus !== 'playing') updateStatusUI('playing');
      post({ type: 'started', sessionId: sid, chunkIndex: chunk.index });

      startTimeTracking(sid, chunk, chunkDuration);

      source.onended = () => {
        if (sid !== currentSessionId) return;
        if (currentSourceNode === source) {
          stopTimeTracking();
          currentSourceNode = null;
          activeChunk = null;
          post({ type: 'chunkEnded', sessionId: sid, chunkIndex: chunk.index });
          neuralAudioCache.delete(chunk.index);
          playNextChunk();
        }
      };

      source.start(0);
    } catch (err) {
      if (sid === currentSessionId) {
        post({ type: 'error', sessionId: sid, message: 'Audio playback error: ' + err.message });
      }
    }
  }

  function playLocalUtterance(chunk) {
    const sid = currentSessionId;
    const textToSpeak = chunk.spokenText || chunk.text;
    if (!textToSpeak || !textToSpeak.trim()) {
      post({ type: 'chunkEnded', sessionId: sid, chunkIndex: chunk.index });
      playNextChunk();
      return;
    }

    const utterance = new SpeechSynthesisUtterance(textToSpeak);
    const localList = ('speechSynthesis' in window) ? window.speechSynthesis.getVoices() : [];
    const match = localList.find(v => v.name === currentSettings.voice || v.voiceURI === currentSettings.voice);
    if (match) utterance.voice = match;

    utterance.rate = currentSettings.rate || 1.0;
    utterance.pitch = currentSettings.pitch || 1.0;

    utterance.onstart = () => {
      if (sid !== currentSessionId) return;
      if (currentStatus !== 'playing') updateStatusUI('playing');
      post({ type: 'started', sessionId: sid, chunkIndex: chunk.index });
    };

    utterance.onboundary = (e) => {
      if (sid !== currentSessionId) return;
      const globalChar = chunk.start + (e.charIndex || 0);
      post({
        type: 'progress',
        sessionId: sid,
        charIndex: globalChar,
        chunkIndex: chunk.index,
        charLength: e.charLength || (chunk.text.substring(e.charIndex || 0).match(/^\S+/) || [''])[0].length
      });
      highlightWordInTextPane(globalChar);
      if (currentSnapshot && currentSnapshot.text) {
        updateProgressUI((globalChar / currentSnapshot.text.length) * 100, globalChar);
      }
    };

    utterance.onend = () => {
      if (sid !== currentSessionId) return;
      post({ type: 'chunkEnded', sessionId: sid, chunkIndex: chunk.index });
      playNextChunk();
    };

    utterance.onerror = (e) => {
      if (sid !== currentSessionId) return;
      if (e.error === 'interrupted' || e.error === 'canceled') return;
      if (e.error === 'not-allowed') {
        hasUserGesture = false;
        pendingLocalChunk = chunk;
        showGestureBanner();
        updateStatusUI('blocked');
        post({ type: 'requireGesture', sessionId: sid });
        return;
      }
      post({
        type: 'error',
        sessionId: sid,
        message: e.error,
        code: e.error
      });
    };

    window.speechSynthesis.speak(utterance);
  }

  // --- Host Message Handling ---

  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'init': {
        if (msg.voices) {
          allVoices = msg.voices;
          updateVoiceCardUI();
        }
        if (msg.settings) {
          currentSettings = Object.assign(currentSettings, msg.settings);
          if (elRateSlider) {
            elRateSlider.value = currentSettings.rate;
            elRateVal.textContent = currentSettings.rate.toFixed(1) + 'x';
            updateRangeFill(elRateSlider);
            document.querySelectorAll('.speed-pill').forEach(p => {
              p.classList.toggle('active', parseFloat(p.dataset.speed) === currentSettings.rate);
            });
          }
          if (elPitchSlider) {
            elPitchSlider.value = currentSettings.pitch;
            elPitchVal.textContent = currentSettings.pitch.toFixed(1);
            updateRangeFill(elPitchSlider);
          }
          if (elHighlightWord) elHighlightWord.checked = currentSettings.highlightWord;
          if (elFollowCursor) elFollowCursor.checked = currentSettings.followCursor;
          updateVoiceCardUI();
        }
        if (msg.snapshot) {
          currentSnapshot = msg.snapshot;
          renderTextPane(currentSnapshot);
        }
        break;
      }

      case 'allVoices': {
        allVoices = msg.voices || [];
        updateVoiceCardUI();
        break;
      }

      case 'terminalState': {
        if (elReadTerminalBtn) {
          elReadTerminalBtn.style.display = msg.hasTerminal ? 'inline-flex' : 'none';
        }
        break;
      }

      case 'settings': {
        if (msg.settings) {
          currentSettings = Object.assign(currentSettings, msg.settings);
          if (elRateSlider) {
            elRateSlider.value = currentSettings.rate;
            elRateVal.textContent = currentSettings.rate.toFixed(1) + 'x';
            updateRangeFill(elRateSlider);
            document.querySelectorAll('.speed-pill').forEach(p => {
              p.classList.toggle('active', parseFloat(p.dataset.speed) === currentSettings.rate);
            });
          }
          if (elPitchSlider) {
            elPitchSlider.value = currentSettings.pitch;
            elPitchVal.textContent = currentSettings.pitch.toFixed(1);
            updateRangeFill(elPitchSlider);
          }
          if (elHighlightWord) elHighlightWord.checked = currentSettings.highlightWord;
          if (elFollowCursor) elFollowCursor.checked = currentSettings.followCursor;
          updateVoiceCardUI();
        }
        break;
      }

      case 'selection': {
        currentSnapshot = msg && msg.text ? msg : null;
        renderTextPane(currentSnapshot);

        // A new selection only ever re-arms the player; the host stops any
        // running session and playback restarts on an explicit Play.
        stopSynthesis();
        updateProgressUI(0, 0);
        updateStatusUI(currentSnapshot ? 'stopped' : 'idle');

        if (msg && msg.reason === 'selectionChanged') {
          showNotice('Stopped — new text selected. Press Play or Alt+P to read it.');
        } else if (msg && msg.reason === 'previewDocument') {
          showNotice('Reading the whole document. To read part of it, select in the preview and press Ctrl+C.');
        } else {
          showNotice('');
        }
        break;
      }

      case 'speak': {
        showNotice('');
        currentSessionId = msg.sessionId;
        stopSynthesis();
        isSpeaking = true;
        chunkQueue = [...(msg.chunks || [])];
        updateStatusUI('starting');
        playNextChunk();
        break;
      }

      case 'neuralAudio': {
        if (msg.sessionId && msg.sessionId.startsWith('preview-')) {
          const ctx = getAudioContext();
          if (ctx) {
            ctx.resume().then(async () => {
              try {
                const arrayBuffer = base64ToArrayBuffer(msg.audioBase64);
                const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
                const source = ctx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(ctx.destination);
                currentSourceNode = source;
                source.onended = () => {
                  if (currentSourceNode === source) currentSourceNode = null;
                  stopPreviewAudio();
                };
                source.start(0);
              } catch (_) {
                stopPreviewAudio();
              }
            }).catch(() => {
              stopPreviewAudio();
            });
          }
          return;
        }

        if (msg.sessionId !== currentSessionId) return;
        neuralAudioCache.set(msg.chunkIndex, msg.audioBase64);
        if (currentPlayingChunk && currentPlayingChunk.index === msg.chunkIndex && !currentSourceNode) {
          startNeuralAudioChunk(currentPlayingChunk, msg.audioBase64);
        }
        break;
      }

      case 'neuralAudioError': {
        if (msg.sessionId && msg.sessionId.startsWith('preview-')) {
          return;
        }
        if (msg.sessionId !== currentSessionId) return;
        stopSynthesis();
        updateStatusUI('stopped');
        post({ type: 'error', sessionId: msg.sessionId, message: msg.message });
        break;
      }

      case 'enqueue': {
        if (msg.sessionId !== currentSessionId) return;
        chunkQueue.push(...(msg.chunks || []));
        if (isSpeaking && !currentSourceNode && (!('speechSynthesis' in window) || !window.speechSynthesis.speaking)) {
          playNextChunk();
        }
        break;
      }

      case 'pause': {
        if (msg.sessionId && msg.sessionId !== currentSessionId) return;
        if (audioCtx && currentSourceNode && !isAudioPaused) {
          pauseTimestamp = audioCtx.currentTime;
          audioCtx.suspend();
          isAudioPaused = true;
        } else if ('speechSynthesis' in window) {
          window.speechSynthesis.pause();
        }
        updateStatusUI('paused');
        break;
      }

      case 'resume': {
        if (msg.sessionId && msg.sessionId !== currentSessionId) return;
        if (audioCtx && currentSourceNode && isAudioPaused) {
          totalPausedDuration += (audioCtx.currentTime - pauseTimestamp);
          audioCtx.resume();
          isAudioPaused = false;
        } else if ('speechSynthesis' in window) {
          window.speechSynthesis.resume();
        }
        updateStatusUI('playing');
        break;
      }

      case 'stop': {
        if (msg.sessionId && msg.sessionId !== currentSessionId) return;
        stopSynthesis();
        updateStatusUI('stopped');
        updateProgressUI(0, 0);
        break;
      }

      case 'state': {
        if (msg.status) updateStatusUI(msg.status);
        if (typeof msg.percent === 'number') updateProgressUI(msg.percent);
        break;
      }
    }
  });

  // Signal ready to host
  post({ type: 'ready' });
})();
