// src/modes.js — interaction modes (draw / select / shapes) + smart-shape snapping
//
// Draw   : freehand ink, nothing selectable (today's behavior, equation OCR safe)
// Select : Fabric native select / move / resize / rotate / multi-select
// Shapes : freehand ink that snaps to clean primitives on stroke completion
//
// A "Smart shapes" setting (off / manual / auto) controls when snapping fires.
// Hold Space to temporarily drop into Select without leaving the current mode.

import { pathToPoints, recognizeStroke } from './shapes.js';

let _mode = 'draw';                 // 'draw' | 'select' | 'shapes'
let _smartShapes = 'manual';        // 'off' | 'manual' | 'auto'
let _canvas = null;

export function getMode() {
  return _mode;
}

export function getSmartShapes() {
  return _smartShapes;
}

function _applyModeToCanvas() {
  if (!_canvas) return;
  if (_mode === 'select') {
    _canvas.isDrawingMode = false;
    _canvas.selection = true;
  } else {
    _canvas.isDrawingMode = true;
    _canvas.selection = false;
    _canvas.discardActiveObject();
  }
  _canvas.requestRenderAll();
}

function _updateButtons() {
  ['draw', 'select', 'shapes'].forEach((m) => {
    const btn = document.getElementById(`mode-${m}`);
    if (btn) btn.classList.toggle('active', m === _mode);
  });
}

export function setMode(mode) {
  if (!['draw', 'select', 'shapes'].includes(mode)) return;
  _mode = mode;
  _applyModeToCanvas();
  _updateButtons();
}

export function setSmartShapes(value) {
  if (['off', 'manual', 'auto'].includes(value)) _smartShapes = value;
}

function _shouldBeautify() {
  if (_smartShapes === 'off') return false;
  if (_smartShapes === 'auto') return _mode === 'draw' || _mode === 'shapes';
  if (_smartShapes === 'manual') return _mode === 'shapes';
  return false;
}

// Swap a freehand path for a recognized primitive, with a brief fade-in.
function _onPathCreated(e) {
  if (!_shouldBeautify()) return;
  const path = e.path;
  const pts = pathToPoints(path);
  const result = recognizeStroke(pts, {
    strokeWidth: path.strokeWidth || 5,
    color: typeof path.stroke === 'string' ? path.stroke : 'black',
  });
  if (!result) return;

  _canvas.remove(path);
  const { shape } = result;
  shape.set({ selectable: true, evented: true, opacity: 0.5 });
  _canvas.add(shape);
  // Brief fade-in as a "snap" cue. Guarded so any animate API mismatch still
  // leaves the shape fully opaque rather than half-faded.
  try {
    shape.animate(
      { opacity: 1 },
      {
        duration: 150,
        onChange: () => _canvas.requestRenderAll(),
        onComplete: () => {
          shape.set({ opacity: 1 });
          _canvas.requestRenderAll();
        },
      }
    );
  } catch (err) {
    shape.set({ opacity: 1 });
  }
  _canvas.requestRenderAll();
}

// Ignore Space when the user is typing into an input or editing an IText.
function _isTyping() {
  const el = document.activeElement;
  if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return true;
  const active = _canvas && _canvas.getActiveObject();
  return !!(active && active.isEditing);
}

export function initModes(canvas) {
  if (!canvas) return;
  _canvas = canvas;

  const drawBtn = document.getElementById('mode-draw');
  const selectBtn = document.getElementById('mode-select');
  const shapesBtn = document.getElementById('mode-shapes');
  if (drawBtn) drawBtn.addEventListener('click', () => setMode('draw'));
  if (selectBtn) selectBtn.addEventListener('click', () => setMode('select'));
  if (shapesBtn) shapesBtn.addEventListener('click', () => setMode('shapes'));

  const smartSelect = document.getElementById('smart-shapes-select');
  if (smartSelect) {
    _smartShapes = smartSelect.value || _smartShapes;
    smartSelect.addEventListener('change', (ev) => setSmartShapes(ev.target.value));
  }

  canvas.on('path:created', _onPathCreated);

  // Hold Space → temporary Select; release → restore previous mode.
  let tempPrevMode = null;
  window.addEventListener('keydown', (ev) => {
    if (ev.code !== 'Space' || ev.repeat || _isTyping()) return;
    if (_mode !== 'select' && tempPrevMode === null) {
      ev.preventDefault();
      tempPrevMode = _mode;
      setMode('select');
    }
  });
  window.addEventListener('keyup', (ev) => {
    if (ev.code !== 'Space') return;
    if (tempPrevMode !== null) {
      setMode(tempPrevMode);
      tempPrevMode = null;
    }
  });

  setMode('draw');

  // Expose for inline scripts / debugging.
  window.setMode = setMode;
  window.getMode = getMode;
}
