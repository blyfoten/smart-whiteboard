// src/voice.js — conversational voice mode (Gemini Live) client.
//
// On toggle: capture mic audio (downsampled to 16kHz PCM16) and whiteboard video
// frames (~1 fps JPEG), stream both over a WebSocket to the server relay, and
// play back the model's 24kHz audio replies. Transcripts go to the output panel.

import { getCanvas } from './canvas.js';
import { appendToOutput } from './output.js';
import { executeAction } from './canvas-actions.js';

let active = false;
let ws = null;
let micCtx = null;
let micStream = null;
let processor = null;
let sourceNode = null;
let videoTimer = null;
let hintShown = false;

// Coalesce streaming transcript fragments into one growing line per speaker.
let _transcriptRole = null;
let _transcriptEl = null;

function appendTranscript(role, fragment) {
  const outputContent = document.getElementById('output-content');
  if (!outputContent) return;
  if (role !== _transcriptRole) {
    _transcriptRole = role;
    _transcriptEl = null;
  }
  if (!_transcriptEl) {
    _transcriptEl = document.createElement('div');
    _transcriptEl.className = 'result-block';
    const label = role === 'user' ? 'You' : 'Assistant';
    _transcriptEl.innerHTML = `<b>${label}:</b> <span class="t"></span>`;
    outputContent.appendChild(_transcriptEl);
  }
  _transcriptEl.querySelector('.t').textContent += fragment;
  outputContent.scrollTop = outputContent.scrollHeight;
}

function resetTranscript() {
  _transcriptRole = null;
  _transcriptEl = null;
}

// Execute assistant tool calls on the canvas and report results back so the
// model knows they succeeded.
async function handleToolCalls(calls) {
  if (!Array.isArray(calls)) return;
  const responses = [];
  for (const call of calls) {
    let result;
    try {
      result = await executeAction(call.name, call.args || {});
    } catch (e) {
      result = { error: (e && e.message) || String(e) };
    }
    responses.push({ id: call.id, name: call.name, result });
    appendToOutput(`<i>🖊️ ${call.name}</i>`);
  }
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'tool_response', responses }));
  }
}

// Playback
let playCtx = null;
let nextPlayTime = 0;
let scheduledSources = [];

const FRAME_INTERVAL_MS = 1000;
const MAX_FRAME_WIDTH = 768;

function setStatus(text) {
  const el = document.getElementById('status');
  if (el) el.textContent = text;
}

// ---- audio helpers ----------------------------------------------------------

function downsampleTo16k(float32, inRate) {
  if (inRate === 16000) return float32;
  const ratio = inRate / 16000;
  const outLen = Math.floor(float32.length / ratio);
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const start = Math.floor(i * ratio);
    const end = Math.floor((i + 1) * ratio);
    let sum = 0;
    let count = 0;
    for (let j = start; j < end && j < float32.length; j++) {
      sum += float32[j];
      count++;
    }
    out[i] = count ? sum / count : 0;
  }
  return out;
}

function floatToPCM16Base64(float32) {
  const buf = new ArrayBuffer(float32.length * 2);
  const view = new DataView(buf);
  for (let i = 0; i < float32.length; i++) {
    const s = Math.max(-1, Math.min(1, float32[i]));
    view.setInt16(i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  const bytes = new Uint8Array(buf);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function playPCM16Base64(b64) {
  if (!playCtx) playCtx = new (window.AudioContext || window.webkitAudioContext)();
  const binary = atob(b64);
  const sampleCount = Math.floor(binary.length / 2);
  if (sampleCount === 0) return;
  const buffer = playCtx.createBuffer(1, sampleCount, 24000);
  const channel = buffer.getChannelData(0);
  for (let i = 0; i < sampleCount; i++) {
    const lo = binary.charCodeAt(i * 2);
    const hi = binary.charCodeAt(i * 2 + 1);
    let val = (hi << 8) | lo;
    if (val >= 0x8000) val -= 0x10000; // signed
    channel[i] = val / 32768;
  }
  const src = playCtx.createBufferSource();
  src.buffer = buffer;
  src.connect(playCtx.destination);
  const now = playCtx.currentTime;
  if (nextPlayTime < now) nextPlayTime = now;
  src.start(nextPlayTime);
  nextPlayTime += buffer.duration;
  scheduledSources.push(src);
  src.onended = () => {
    scheduledSources = scheduledSources.filter((s) => s !== src);
  };
}

function stopPlayback() {
  scheduledSources.forEach((s) => {
    try { s.stop(); } catch (e) { /* noop */ }
  });
  scheduledSources = [];
  nextPlayTime = 0;
}

// ---- video frame capture ----------------------------------------------------

function captureFrameBase64() {
  const canvas = getCanvas();
  if (!canvas || !canvas.lowerCanvasEl) return null;
  const srcEl = canvas.lowerCanvasEl;
  if (!srcEl.width || !srcEl.height) return null;
  const scale = Math.min(1, MAX_FRAME_WIDTH / srcEl.width);
  const w = Math.max(1, Math.round(srcEl.width * scale));
  const h = Math.max(1, Math.round(srcEl.height * scale));
  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const ctx = off.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(srcEl, 0, 0, w, h);
  const dataUrl = off.toDataURL('image/jpeg', 0.6);
  return dataUrl.split(',')[1];
}

// ---- lifecycle --------------------------------------------------------------

async function start() {
  if (active) return;
  hintShown = false;
  resetTranscript();

  // Browsers only expose the microphone on secure origins (https:// or localhost).
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    setStatus('Voice: needs HTTPS');
    appendToOutput(
      '<b>Voice mode needs a secure origin.</b> Microphone access is blocked on ' +
      'plain <code>http://</code>. Serve the site over <b>https://</b> (or open it via ' +
      '<code>localhost</code> on the host) to use voice mode.',
      true
    );
    return;
  }

  setStatus('Voice: connecting...');

  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    setStatus('Voice: microphone permission denied.');
    appendToOutput('<b>Voice mode:</b> microphone access was denied.', true);
    return;
  }

  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${proto}//${location.host}/voice`);

  ws.onopen = () => {
    micCtx = new (window.AudioContext || window.webkitAudioContext)();
    sourceNode = micCtx.createMediaStreamSource(micStream);
    processor = micCtx.createScriptProcessor(4096, 1, 1);
    sourceNode.connect(processor);
    processor.connect(micCtx.destination);

    processor.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== 1) return;
      const input = e.inputBuffer.getChannelData(0);
      const down = downsampleTo16k(input, micCtx.sampleRate);
      ws.send(JSON.stringify({ type: 'audio', data: floatToPCM16Base64(down) }));
    };

    // Stream whiteboard frames ~1 fps.
    videoTimer = setInterval(() => {
      if (!ws || ws.readyState !== 1) return;
      const frame = captureFrameBase64();
      if (frame) ws.send(JSON.stringify({ type: 'video', data: frame }));
    }, FRAME_INTERVAL_MS);
  };

  ws.onmessage = (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch (e) { return; }
    switch (msg.type) {
      case 'ready':
        setStatus('🎤 Voice: listening — speak now');
        if (!hintShown) {
          hintShown = true;
          appendToOutput(
            '<b>🎤 Voice mode is on</b> — the assistant will greet you, then just talk. Try:<br>' +
            '• "What do you see on the whiteboard?"<br>' +
            '• "Solve x squared plus three x minus four."<br>' +
            '• "Plot y equals x squared."<br>' +
            '• (draw something) "What is this?" / "Is this a 7 or a 1?"<br>' +
            '<i>Tap 🛑 Stop Voice to end.</i>'
          );
        }
        break;
      case 'audio':
        playPCM16Base64(msg.data);
        break;
      case 'interrupted':
        stopPlayback();
        break;
      case 'text':
        appendTranscript(msg.role, msg.data);
        break;
      case 'tool_call':
        handleToolCalls(msg.calls);
        break;
      case 'turn_complete':
        resetTranscript();
        break;
      case 'error':
        appendToOutput(`<b>Voice error:</b> ${msg.message}`, true);
        setStatus('Voice: error — see output panel');
        break;
      case 'closed':
        if (msg.message) appendToOutput(`<b>Voice session closed:</b> ${msg.message}`, true);
        setStatus('Voice: session closed');
        break;
      default:
        break;
    }
  };

  ws.onerror = () => {
    appendToOutput('<b>Voice mode:</b> WebSocket connection error.', true);
  };
  ws.onclose = () => {
    if (active) stop();
  };

  active = true;
  updateButton();
}

function stop() {
  active = false;
  if (videoTimer) { clearInterval(videoTimer); videoTimer = null; }
  if (processor) { try { processor.disconnect(); } catch (e) {} processor = null; }
  if (sourceNode) { try { sourceNode.disconnect(); } catch (e) {} sourceNode = null; }
  if (micCtx) { try { micCtx.close(); } catch (e) {} micCtx = null; }
  if (micStream) { micStream.getTracks().forEach((t) => t.stop()); micStream = null; }
  stopPlayback();
  if (ws) {
    try {
      if (ws.readyState === 1) ws.send(JSON.stringify({ type: 'stop' }));
      ws.close();
    } catch (e) { /* noop */ }
    ws = null;
  }
  setStatus('Voice: off');
  updateButton();
}

function updateButton() {
  const btn = document.getElementById('voice-btn');
  if (!btn) return;
  btn.textContent = active ? '🛑 Stop Voice' : '🎤 Voice';
  btn.classList.toggle('active', active);
}

export function initVoice() {
  const btn = document.getElementById('voice-btn');
  if (!btn) return;
  btn.addEventListener('click', () => {
    if (active) stop();
    else start();
  });
  updateButton();
}
