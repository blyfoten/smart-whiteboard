// src/speech.js — Web Speech API

let recognition = null;
let recognizing = false;

export function initializeSpeechRecognition(handleCommand) {
  const statusEl = document.getElementById('status');

  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
    if (statusEl) statusEl.textContent = 'Speech recognition not supported.';
    return;
  }

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.lang = 'sv-SE';
  recognition.continuous = false;
  recognition.interimResults = false;

  recognition.onstart = () => {
    recognizing = true;
    if (statusEl) statusEl.textContent = 'Voice recognition started. Speak now.';
  };

  recognition.onresult = (event) => {
    const transcript = event.results[0][0].transcript.trim().toLowerCase();
    if (statusEl) statusEl.textContent = `You said: "${transcript}"`;
    handleCommand(transcript);
    recognizing = false;
  };

  recognition.onerror = (event) => {
    console.error('Speech recognition error', event.error);
    if (statusEl) statusEl.textContent = 'Error: ' + event.error;
    recognizing = false;
  };

  recognition.onend = () => {
    recognizing = false;
    if (statusEl) statusEl.textContent = 'Voice recognition ended.';
  };
}

export function toggleRecognition() {
  if (!recognition) {
    alert('Web Speech API is not supported in this browser.');
    return;
  }
  if (recognizing) {
    recognition.stop();
  } else {
    recognition.start();
  }
}
