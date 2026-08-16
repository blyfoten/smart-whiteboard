// src/debug-capture.js — evidence for the bug report.
//
// When the voice assistant hands a problem to the backend coding agent, the
// agent's whole understanding of the bug is what gets sent at that moment. A
// spoken description is thin evidence, so the app attaches what it knows itself:
// the errors the page actually threw, what the user had selected and drawn, and
// a clean screenshot of the board.
//
// The console/error hooks are installed once at startup and keep a small ring
// buffer — by the time someone says "that's broken", the error has usually
// already scrolled past.

import { getCanvas } from './canvas.js';

const MAX_ERRORS = 40;
const MAX_LOGS = 60;
const MAX_TOOL_CALLS = 15;
const MAX_SHOT_WIDTH = 1024;

const errors = [];
const logs = [];
const voiceTools = [];
let installed = false;

function stamp() {
  return new Date().toLocaleTimeString();
}

function push(buffer, line, max) {
  buffer.push(`[${stamp()}] ${String(line).slice(0, 600)}`);
  while (buffer.length > max) buffer.shift();
}

// Arguments as the console would have shown them, Errors keeping their stack.
function formatArgs(args) {
  return Array.from(args)
    .map((a) => {
      if (a instanceof Error) return `${a.message}\n${(a.stack || '').split('\n').slice(0, 4).join('\n')}`;
      if (typeof a === 'object' && a !== null) {
        try { return JSON.stringify(a); } catch (e) { return String(a); }
      }
      return String(a);
    })
    .join(' ');
}

export function initDebugCapture() {
  if (installed || typeof window === 'undefined') return;
  installed = true;

  const origError = console.error;
  const origWarn = console.warn;
  const origLog = console.log;

  console.error = function (...args) {
    push(errors, `console.error: ${formatArgs(args)}`, MAX_ERRORS);
    origError.apply(console, args);
  };
  console.warn = function (...args) {
    push(errors, `console.warn: ${formatArgs(args)}`, MAX_ERRORS);
    origWarn.apply(console, args);
  };
  console.log = function (...args) {
    push(logs, formatArgs(args), MAX_LOGS);
    origLog.apply(console, args);
  };

  window.addEventListener('error', (e) => {
    const where = e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : '';
    const stack = e.error && e.error.stack ? `\n${e.error.stack.split('\n').slice(0, 5).join('\n')}` : '';
    push(errors, `uncaught: ${e.message}${where}${stack}`, MAX_ERRORS);
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason instanceof Error
      ? `${e.reason.message}\n${(e.reason.stack || '').split('\n').slice(0, 4).join('\n')}`
      : String(e.reason);
    push(errors, `unhandled promise rejection: ${reason}`, MAX_ERRORS);
  });
}

// Voice tool calls are the app's own recent history of "what just happened",
// which is often exactly what the user is complaining about.
export function noteVoiceTool(name, args) {
  const detail = args && typeof args === 'object'
    ? Object.entries(args)
      .filter(([, v]) => typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean')
      .slice(0, 4)
      .map(([k, v]) => `${k}=${typeof v === 'string' ? v.slice(0, 24) : v}`)
      .join(' ')
    : '';
  voiceTools.push(detail ? `${name}(${detail})` : name);
  while (voiceTools.length > MAX_TOOL_CALLS) voiceTools.shift();
}

export function noteError(message) {
  push(errors, message, MAX_ERRORS);
}

// What is on the board, in one line — object counts and the current selection.
function boardSummary(canvas) {
  if (!canvas) return 'no canvas';
  const objects = canvas.getObjects().filter((o) => !o.excludeFromExport);
  const counts = {};
  for (const o of objects) counts[o.type] = (counts[o.type] || 0) + 1;
  const parts = Object.entries(counts).map(([type, n]) => `${n} ${type}`);
  const active = canvas.getActiveObject();
  return `${objects.length} object(s)${parts.length ? ` — ${parts.join(', ')}` : ''}` +
    (active ? `; selected: ${active.type}${active.id ? ` #${active.id}` : ''}` : '; nothing selected');
}

function cadSummary() {
  try {
    // Read through the CAD debug bridge so this module stays independent of the
    // CAD module's load order.
    const bridge = window.cadDebug;
    if (!bridge || !bridge.getSketch) return '';
    const sketch = bridge.getSketch();
    if (!sketch || !sketch.entities || !sketch.entities.length) return 'empty';
    const solve = bridge.getSolveStatus ? bridge.getSolveStatus() : null;
    return `${sketch.entities.length} entities, ${sketch.constraints.length} constraints, ` +
      `DOF ${sketch.degreesOfFreedom()}` + (solve ? `, solve ${solve.ok ? 'ok' : 'FAILED'}` : '');
  } catch (e) {
    return '';
  }
}

function uiSummary() {
  const flag = (id, label) => {
    const el = document.getElementById(id);
    if (!el) return null;
    return `${label}${el.classList.contains('collapsed') || el.classList.contains('hidden') ? ' hidden' : ' open'}`;
  };
  return [flag('output-panel', 'output panel'), flag('boards-panel', 'boards panel'), flag('sub-toolbar', 'sub-toolbar')]
    .filter(Boolean)
    .join(', ');
}

export function collectDebugContext() {
  const canvas = getCanvas();
  const activeMode = document.querySelector('.mode-btn.active');
  const modelSelect = document.getElementById('model-select');
  const tierSelect = document.getElementById('model-tier-select');
  return {
    url: location.href,
    userAgent: navigator.userAgent,
    viewport: `${window.innerWidth}x${window.innerHeight} @${window.devicePixelRatio || 1}x`,
    mode: activeMode ? (activeMode.getAttribute('aria-label') || activeMode.id) : 'unknown',
    model: `${modelSelect ? modelSelect.value : '?'} / ${tierSelect ? tierSelect.value : '?'}`,
    board: `${boardSummary(canvas)}; UI: ${uiSummary()}`,
    cad: cadSummary(),
    errors: errors.slice(),
    logs: logs.slice(-20),
    lastVoiceTools: voiceTools.slice(),
  };
}

// A clean screenshot of the board — no coordinate grid, unlike the frames the
// voice model sees. The agent is reading it as a human would.
export function captureBoardScreenshot() {
  const canvas = getCanvas();
  if (!canvas || !canvas.lowerCanvasEl) return null;
  const src = canvas.lowerCanvasEl;
  if (!src.width || !src.height) return null;
  const scale = Math.min(1, MAX_SHOT_WIDTH / src.width);
  const off = document.createElement('canvas');
  off.width = Math.max(1, Math.round(src.width * scale));
  off.height = Math.max(1, Math.round(src.height * scale));
  const ctx = off.getContext('2d');
  ctx.fillStyle = 'white';
  ctx.fillRect(0, 0, off.width, off.height);
  ctx.drawImage(src, 0, 0, off.width, off.height);
  try {
    return off.toDataURL('image/jpeg', 0.75);
  } catch (e) {
    return null;
  }
}

// Everything the server asks for when a debug session starts.
export function captureForBugReport() {
  return { screenshot: captureBoardScreenshot(), context: collectDebugContext() };
}
