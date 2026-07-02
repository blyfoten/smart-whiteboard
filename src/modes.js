// src/modes.js — interaction modes (draw / select / shapes) + smart-shape snapping
//
// Draw   : freehand ink, nothing selectable (today's behavior, equation OCR safe)
// Select : Fabric native select / move / resize / rotate / multi-select
// Shapes : freehand ink that snaps to clean primitives on stroke completion
//
// A "Smart shapes" setting (off / manual / auto) controls when snapping fires.
// Hold Space to temporarily drop into Select without leaving the current mode.

import { pathToPoints, recognizeStroke } from './shapes.js';
import { snapPointToShapes, toTargetLocal, fromTargetLocal } from './edge-snap.js';
import { applyVertexSceneMove, getVertexScenePosition } from './node-edit.js';
import { suspend as historySuspend, popLast as historyPopLast, pushComposite, onAfterUndo } from './history.js';
import { deleteActiveSelection } from './equation-menu.js';
import { getDrawColor, computedShapeFill, getCornerRadius } from './draw-settings.js';
import { toggleSubToolbar, showSubToolbar, isSubToolbarOpen } from './draw-toolbar.js';

let _mode = 'draw';                 // 'draw' | 'select' | 'shapes'
let _smartShapes = 'manual';        // 'off' | 'manual' | 'auto'
let _edgeSnap = 'on';               // 'on' | 'off' — endpoint edge-snap + sticky anchors
let _canvas = null;

const EDGE_SNAP_PX = 22;            // screen-pixel radius for endpoint edge-snapping

export function getEdgeSnap() {
  return _edgeSnap;
}

export function setEdgeSnap(value) {
  if (['on', 'off'].includes(value)) _edgeSnap = value;
}

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

// Pull a just-recognized polyline/line's first & last vertex onto a nearby
// existing shape edge. The new shape isn't on the canvas yet, and its `points`
// are still in scene coordinates (no transform applied), so we can read/write
// them directly. Records the snapped target on the shape for later anchoring.
function _snapEndpointsToEdges(shape) {
  if (_edgeSnap !== 'on') return;
  const pts = shape.points;
  if (!pts || pts.length < 2) return;
  const targets = _canvas.getObjects().filter((o) => o._isShape && !o._isGhost && o !== shape);
  if (!targets.length) return;

  const maxDist = EDGE_SNAP_PX / (_canvas.getZoom() || 1); // ~constant on screen
  let changed = false;
  const anchors = {};
  [0, pts.length - 1].forEach((i) => {
    const hit = snapPointToShapes(pts[i], targets, maxDist);
    if (hit) {
      pts[i] = hit.point;
      // Pin the vertex to a fixed spot in the target's local frame so it follows
      // the target when it moves/scales (sticky anchoring).
      anchors[i] = { target: hit.target, local: toTargetLocal(hit.target, hit.point) };
      changed = true;
    }
  });
  if (changed) {
    shape._edgeAnchors = anchors;
    shape.setBoundingBox(true);
    shape.setCoords();
  }
}

// Re-pin every anchored polyline vertex onto its target's current edge position,
// so anchored nodes follow a shape as it's moved/scaled. `skip` is the object
// currently being dragged (don't fight its own drag).
function _reapplyAnchors(skip) {
  if (_edgeSnap !== 'on') return;
  const objs = _canvas.getObjects();
  let any = false;
  for (const poly of objs) {
    if (poly === skip || !poly._edgeAnchors) continue;
    // While an object is part of an active (multi-) selection its transform is
    // group-relative, so applyVertexSceneMove's canvas-space math would corrupt
    // its points and make it jump. The whole selection moves rigidly anyway, so
    // the anchored vertices stay glued without any re-pinning.
    if (poly.group) continue;
    for (const key of Object.keys(poly._edgeAnchors)) {
      const a = poly._edgeAnchors[key];
      if (!a || !a.target || !objs.includes(a.target)) continue;
      applyVertexSceneMove(poly, Number(key), fromTargetLocal(a.target, a.local));
      any = true;
    }
  }
  if (any) _canvas.requestRenderAll();
}

// After a node was dragged: re-anchor it to the nearest shape edge if released
// close enough, otherwise detach it (leave it where dropped).
function _reanchorNodeAfterDrag(poly, i) {
  const targets = _canvas.getObjects().filter((o) => o._isShape && !o._isGhost && o !== poly);
  const scene = getVertexScenePosition(poly, i);
  const maxDist = EDGE_SNAP_PX / (_canvas.getZoom() || 1);
  const hit = targets.length ? snapPointToShapes({ x: scene.x, y: scene.y }, targets, maxDist) : null;
  if (!poly._edgeAnchors) poly._edgeAnchors = {};
  if (hit) {
    poly._edgeAnchors[i] = { target: hit.target, local: toTargetLocal(hit.target, hit.point) };
    applyVertexSceneMove(poly, i, hit.point); // snap exactly onto the edge
  } else if (poly._edgeAnchors[i]) {
    delete poly._edgeAnchors[i]; // dropped in open space → detach
  }
  _canvas.requestRenderAll();
}

// A click (no drag) in draw mode leaves a zero-size "dot" path — e.g. the two
// clicks of a double-click, or clicking away from a text box. Discard those
// degenerate strokes (drawn marks/decimal points are bigger and kept).
function _removeStrayDot(e) {
  const p = e && e.path;
  if (!p) return false;
  if (Math.max(p.width || 0, p.height || 0) >= 3) return false;
  historyPopLast();                          // drop its just-recorded add-entry
  historySuspend(() => _canvas.remove(p));   // remove without recording
  return true;
}

// Swap a freehand path for a recognized primitive, with a brief fade-in.
function _onPathCreated(e) {
  if (!_shouldBeautify()) return;
  const path = e.path;
  const pts = pathToPoints(path);
  const result = recognizeStroke(pts, {
    strokeWidth: path.strokeWidth || 5,
    color: getDrawColor(),
    fill: computedShapeFill(),
    cornerRadius: getCornerRadius(),
  });
  if (!result) return;

  const { shape } = result;
  shape.set({ selectable: true, evented: true, opacity: 0.5, _isShape: true });

  // Edge snap: if an open polyline/line's start or end was drawn close to an
  // existing shape's outline, pull that endpoint onto the edge for a clean join.
  if (result.type === 'line' || result.type === 'polyline') {
    _snapEndpointsToEdges(shape);
  }

  // Replace the freehand stroke with the clean shape. Keep the stroke's own
  // add-entry below and push the snap on top, so it's two undo steps: first undo
  // restores the original stroke, second undo removes it (undoes the drawing).
  historySuspend(() => {
    _canvas.remove(path);
    _canvas.add(shape);
  });
  pushComposite((c) => historySuspend(() => {
    c.remove(shape);
    c.add(path); // original hand-drawn stroke reappears, in its original colour
  }));

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

  // Clicking the already-active mode button toggles its options bar; switching
  // modes keeps the bar open (if it was) and re-renders it for the new mode.
  const onModeButton = (mode) => {
    const wasOpen = isSubToolbarOpen();
    const sameMode = _mode === mode;
    setMode(mode);
    if (sameMode) {
      toggleSubToolbar(mode);
    } else if (wasOpen) {
      showSubToolbar(mode);
    }
  };
  const drawBtn = document.getElementById('mode-draw');
  const selectBtn = document.getElementById('mode-select');
  const shapesBtn = document.getElementById('mode-shapes');
  if (drawBtn) drawBtn.addEventListener('click', () => onModeButton('draw'));
  if (selectBtn) selectBtn.addEventListener('click', () => onModeButton('select'));
  if (shapesBtn) shapesBtn.addEventListener('click', () => onModeButton('shapes'));

  const smartSelect = document.getElementById('smart-shapes-select');
  if (smartSelect) {
    _smartShapes = smartSelect.value || _smartShapes;
    smartSelect.addEventListener('change', (ev) => setSmartShapes(ev.target.value));
  }

  const edgeSnapSelect = document.getElementById('edge-snap-select');
  if (edgeSnapSelect) {
    _edgeSnap = edgeSnapSelect.value || _edgeSnap;
    edgeSnapSelect.addEventListener('change', (ev) => setEdgeSnap(ev.target.value));
  }

  canvas.on('path:created', (e) => { if (!_removeStrayDot(e)) _onPathCreated(e); });
  // After an undo, re-pin anchored nodes (e.g. a restored/relocated target).
  onAfterUndo(() => _reapplyAnchors(null));
  // Sticky anchors: anchored polyline nodes follow their shape as it moves.
  canvas.on('object:moving', (e) => _reapplyAnchors(e.target));
  canvas.on('object:modified', (e) => {
    if (_edgeSnap !== 'on') return;
    const obj = e && e.target;
    const corner = e && e.transform && e.transform.corner;
    const ctrl = corner && obj && obj.controls ? obj.controls[corner] : null;
    // A node was dragged (our polylines only have point-controls, each with a
    // pointIndex) → re-snap to nearest edge or detach. Otherwise a shape/body
    // moved → keep anchored nodes glued to their targets.
    if (obj && Array.isArray(obj.points) && ctrl && Number.isInteger(ctrl.pointIndex)) {
      _reanchorNodeAfterDrag(obj, ctrl.pointIndex);
    } else {
      _reapplyAnchors(null);
    }
  });

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

  // Delete / Backspace removes the current selection (unless typing).
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Delete' && ev.key !== 'Backspace') return;
    if (_isTyping() || !_canvas.getActiveObject()) return;
    ev.preventDefault();
    deleteActiveSelection();
  });

  setMode('draw');

  // Expose for inline scripts / debugging.
  window.setMode = setMode;
  window.getMode = getMode;
}
