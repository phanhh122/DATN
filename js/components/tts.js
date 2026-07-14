// components/tts.js — Web Speech API Text-To-Speech (zh-CN)
let _currentUtterance = null;

export function speakText(text, onEnd) {
    if (!text) return;
    // Stop any playing
    window.speechSynthesis.cancel();

    const utter = new SpeechSynthesisUtterance(text);
    utter.lang  = 'zh-CN';
    utter.rate  = 0.9;
    utter.pitch = 1;
    utter.volume = 1;

    // Pick zh-CN voice if available
    const voices = window.speechSynthesis.getVoices();
    const zhVoice = voices.find(v => v.lang === 'zh-CN' || v.lang === 'zh_CN');
    if (zhVoice) utter.voice = zhVoice;

    utter.onend   = () => { _currentUtterance = null; if (onEnd) onEnd(); };
    utter.onerror = () => { _currentUtterance = null; };

    _currentUtterance = utter;
    window.speechSynthesis.speak(utter);
}

export function stopSpeech() {
    window.speechSynthesis.cancel();
    _currentUtterance = null;
}

export function isSpeaking() {
    return window.speechSynthesis.speaking;
}

// Voices might load async
window.speechSynthesis.onvoiceschanged = () => {
    // Pre-load voices
    window.speechSynthesis.getVoices();
};
