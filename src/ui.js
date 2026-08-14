// src/ui.js — event listeners, model selection, output panel

import { getCanvas, undoLast, saveScreenshot, clearCanvas } from './canvas.js';
import { IText } from 'fabric';
import { solveEquationFromText, extractEquation, analyzeRegionInk, analyzeText, parseTypedEquation, drawGraph, replotAllGraphs } from './api.js';
import { startRegionSelect, inkInRegion } from './region-select.js';
import { getDrawColor } from './draw-settings.js';
import { toggleRecognition } from './speech.js';
import { captureFrameBase64 } from './voice.js';
import { consumePokeSelection } from './modes.js';

let currentModel = 'math';
let currentTier = 'fast';   // cheapest variant by default
let modelCatalogue = null;  // from GET /models — drives the tier picker's labels

export function getCurrentModel() {
  return currentModel;
}

// The variant of the selected provider to call: 'fast' | 'balanced' | 'max'.
// Sent with every /extract and /solve request; the SERVER maps it to a model id
// (the browser never names a model, so it can't reach for an arbitrary one).
export function getCurrentTier() {
  return currentTier;
}

// Relabel the tier options with the selected provider's own variant names —
// "Fast & cheap (Luna)" for OpenAI, "(Haiku)" for Claude — so the ladder is
// concrete rather than abstract. Falls back to the plain labels until the
// catalogue arrives (or if the provider has no variants, e.g. local math.js).
function refreshTierOptions() {
  const sel = document.getElementById('model-tier-select');
  if (!sel) return;
  const entry = modelCatalogue && modelCatalogue.providers[currentModel];
  const generic = { fast: 'Fast & cheap', balanced: 'Balanced', max: 'Best' };
  sel.disabled = !entry;
  sel.title = entry
    ? `Which ${entry.label} variant to call`
    : 'Math.js runs locally — no model variants to choose';
  Array.from(sel.options).forEach((opt) => {
    const step = entry && entry.tiers.find((t) => t.tier === opt.value);
    opt.textContent = step ? `${generic[opt.value]} (${step.name})` : generic[opt.value];
    if (step) opt.title = step.model;
  });
}

async function loadModelCatalogue() {
  try {
    const resp = await fetch('/models');
    if (!resp.ok) return;
    modelCatalogue = await resp.json();
  } catch (e) {
    /* offline or old server — the picker keeps its generic labels */
  }
  refreshTierOptions();
}

export function initializeModelSelectionUI() {
  const tierSelect = document.getElementById('model-tier-select');
  if (tierSelect) {
    if (tierSelect.value) currentTier = tierSelect.value;
    tierSelect.addEventListener('change', (e) => { currentTier = e.target.value; });
  }
  loadModelCatalogue();

  const existingSelect = document.getElementById('model-select');

  if (existingSelect) {
    existingSelect.addEventListener('change', (e) => {
      currentModel = e.target.value;
      refreshTierOptions(); // variant names differ per provider
    });

    if (existingSelect.value) {
      currentModel = existingSelect.value;
    }
    return;
  }

  // Create dropdown if not in HTML
  const uiElement = document.querySelector('.ui-element');
  if (!uiElement) return;

  const container = document.createElement('div');
  container.style.marginTop = '10px';

  const label = document.createElement('label');
  label.textContent = 'AI Model: ';
  label.setAttribute('for', 'model-select');

  const select = document.createElement('select');
  select.id = 'model-select';

  [
    { value: 'math', text: 'Math.js (Simple)' },
    { value: 'gpt', text: 'GPT (Advanced)' },
    { value: 'gemini', text: 'Gemini (Advanced)' },
    { value: 'claude', text: 'Claude (Advanced)' },
  ].forEach(opt => {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.text;
    select.appendChild(o);
  });

  select.addEventListener('change', (e) => {
    currentModel = e.target.value;
  });

  container.appendChild(label);
  container.appendChild(select);
  uiElement.appendChild(container);
}

export function setupCanvasEventListeners() {
  const canvas = getCanvas();
  if (!canvas) return;

  // Double-click to drop a blank text box ready for typing (handwriting font).
  canvas.on('mouse:dblclick', (options) => {
    // Unless the first click was a poke that selected a shape — then the
    // double-click was aimed at that shape, not at empty board.
    if (consumePokeSelection()) return;
    const pointer = canvas.getPointer(options.e);
    const text = new IText('', {
      left: pointer.x,
      top: pointer.y,
      fill: getDrawColor(),
      fontSize: 28,
      backgroundColor: 'transparent',
      selectable: true,
      editable: true,
      fontFamily: 'Caveat, cursive',
    });
    // Drop it if empty; if it's an equation, tag it so selecting it shows the
    // contextual menu (the menu is driven by selection, not edit-exit).
    text.on('editing:exited', () => {
      if (!text.text || !text.text.trim()) {
        canvas.remove(text);
      } else if (text.text.includes('=')) {
        text._equationData = parseTypedEquation(text.text);
      }
    });
    canvas.add(text);
    canvas.setActiveObject(text);
    text.enterEditing();
  });
}

function initSettingsMenu() {
  const btn = document.getElementById('settings-btn');
  const menu = document.getElementById('settings-menu');
  if (!btn || !menu) return;

  const setOpen = (open) => {
    menu.classList.toggle('hidden', !open);
    btn.setAttribute('aria-expanded', open ? 'true' : 'false');
  };

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(menu.classList.contains('hidden'));
  });
  // Keep the menu open when interacting inside it (but let selects work).
  menu.addEventListener('click', (e) => e.stopPropagation());
  // Dismiss on outside click or Escape.
  document.addEventListener('click', () => setOpen(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });
}

export function initializeEventListeners() {
  initSettingsMenu();

  const gridSel = document.getElementById('graph-grid-select');
  if (gridSel) {
    gridSel.addEventListener('change', () => replotAllGraphs());
  }

  const startRecordBtn = document.getElementById('start-record-btn');
  if (startRecordBtn) {
    startRecordBtn.addEventListener('click', toggleRecognition);
  }

  const extractEqBtn = document.getElementById('extract-eq-btn');
  if (extractEqBtn) {
    extractEqBtn.addEventListener('click', () => {
      // If a typed text equation is selected, analyze that; else read handwriting.
      const canvas = getCanvas();
      const active = canvas && canvas.getActiveObject();
      if (active && (active.type === 'i-text' || active.type === 'text') &&
          typeof active.text === 'string' && active.text.includes('=')) {
        analyzeText(active);
      } else {
        extractEquation();
      }
    });
  }

  const regionAnalyzeBtn = document.getElementById('region-analyze-btn');
  if (regionAnalyzeBtn) {
    regionAnalyzeBtn.addEventListener('click', () => {
      regionAnalyzeBtn.classList.add('active');
      startRegionSelect((region) => {
        regionAnalyzeBtn.classList.remove('active');
        if (!region) return;
        const ink = inkInRegion(getCanvas(), region);
        if (!ink.length) {
          alert('No handwriting found in the selected region.');
          return;
        }
        analyzeRegionInk(ink);
      });
    });
  }

  const undoBtn = document.getElementById('undo-btn');
  if (undoBtn) {
    undoBtn.addEventListener('click', () => undoLast(getCanvas()));
  }

  const saveBtn = document.getElementById('save-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => saveScreenshot(getCanvas()));
  }

  const clearBtn = document.getElementById('clear-btn');
  if (clearBtn) {
    clearBtn.addEventListener('click', () => clearCanvas(getCanvas()));
  }

  const addTestBtn = document.getElementById('add-test-equation-btn');
  if (addTestBtn) {
    addTestBtn.addEventListener('click', () => {
      const input = document.getElementById('test-equation');
      const equation = input && input.value.trim();
      if (!equation) {
        alert('Please enter a test equation');
        return;
      }
      const canvas = getCanvas();
      if (!canvas) {
        alert('Canvas not found!');
        return;
      }
      const text = new IText(equation, {
        left: 100,
        top: 100,
        fill: 'black',
        fontSize: 36,
        fontFamily: 'Caveat, cursive',
      });
      canvas.add(text);
      canvas.setActiveObject(text);
      canvas.requestRenderAll();
    });
  }

  // Solving is now a contextual action on an analyzed equation (see
  // equation-menu.js), so there's no standalone Solve button to wire.

  const graphBtn = document.getElementById('graph-btn');
  if (graphBtn) {
    graphBtn.addEventListener('click', drawGraph);
  }

  const forceSolveBtn = document.getElementById('force-solve-btn');
  if (forceSolveBtn) {
    forceSolveBtn.addEventListener('click', () => {
      const equation = prompt('Enter equation to solve (e.g. x^2 + 3*x - 5 = 0):');
      if (equation) solveEquationFromText(equation);
    });
  }

  // Download exactly what the voice assistant sees (board + coordinate grid).
  const aiFrameBtn = document.getElementById('ai-frame-btn');
  if (aiFrameBtn) {
    aiFrameBtn.addEventListener('click', () => {
      const b64 = captureFrameBase64();
      if (!b64) return;
      const link = document.createElement('a');
      link.download = `ai-frame-${Date.now()}.jpg`;
      link.href = 'data:image/jpeg;base64,' + b64;
      link.click();
    });
  }
}
