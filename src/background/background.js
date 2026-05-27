// Background script - handles TTS execution
console.log('Audio Cursor Background V2.1 Initializing...');
var currentSessionId = 0;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'PLAY_TEXT') {
        const sessionId = ++currentSessionId;
        const startOffset = message.offset || 0;
        
        // Stop any current speech before starting new
        chrome.tts.stop();
        
        const textToSpeak = message.text.substring(startOffset);
        
        chrome.storage.sync.get(['voice', 'rate', 'pitch', 'enabled'], (data) => {
            if (data.enabled === false) return;

            chrome.tts.speak(textToSpeak, {
                voiceName: data.voice === 'default' ? undefined : data.voice,
                rate: parseFloat(data.rate) || 1.0,
                pitch: parseFloat(data.pitch) || 1.0,
                onEvent: (event) => {
                    const sendIfNew = (msg) => {
                        if (sessionId === currentSessionId) {
                            chrome.tabs.sendMessage(sender.tab.id, msg);
                        }
                    };

                    if (event.type === 'start') {
                        sendIfNew({ 
                            type: 'TTS_STATUS', 
                            status: 'playing',
                            totalLength: message.text.length,
                            offset: startOffset,
                            rate: parseFloat(data.rate) || 1.0
                        });
                    }
                    if (event.type === 'word') {
                        const actualIndex = startOffset + event.charIndex;
                        sendIfNew({ 
                            type: 'TTS_PROGRESS', 
                            charIndex: actualIndex,
                            totalLength: message.text.length
                        });
                    }
                    if (event.type === 'end' || event.type === 'interrupted' || event.type === 'error') {
                        sendIfNew({ type: 'TTS_STATUS', status: 'idle' });
                    }
                }
            });
        });
    } else if (message.type === 'PAUSE_TTS') {
        chrome.tts.stop();
        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
            if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'TTS_STATUS', status: 'paused' });
        });
    } else if (message.type === 'RESUME_TTS') {
        chrome.tts.resume();
        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
            if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'TTS_STATUS', status: 'playing' });
        });
    } else if (message.type === 'STOP_TTS') {
        currentSessionId++; // Invalidate current session
        chrome.tts.stop();
        chrome.tabs.query({active: true, currentWindow: true}, (tabs) => {
            if (tabs[0]) chrome.tabs.sendMessage(tabs[0].id, { type: 'TTS_STATUS', status: 'idle' });
        });
    }
});

chrome.runtime.onInstalled.addListener(() => {
    console.log('Audio Cursor initialized');
});
