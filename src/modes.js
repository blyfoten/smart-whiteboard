// src/modes.js — interaction modes (draw / select / shapes / cad) + smart-shape snapping
//
// Draw   : freehand ink, nothing selectable (today's behavior, equation OCR safe)
// Select : Fabric native select / move / resize / rotate / multi-select
// Shapes : freehand ink that snaps to clean primitives on stroke completion
// CAD    : freehand ink that becomes parametric sketch geometry (cad/cad-mode.js);
//          a tap (stray-dot click) selects entities for the constraint toolbar
//
// A "Smart shapes" setting (off / manual / auto) controls when snapping fires.
// Hold Space to temporarily drop into Select without leaving the current mode.

import { pathToPoints, recognizeStroke } from './shapes.js';
import { cadHandleStroke, cadHandleClick, isCadTap, notifyModeChanged } from './cad/cad-mode.js';
import { pointerSlop } from './pointer.js';
import { snapPointToShapes, toTargetLocal, fromTargetLocal } from './edge-snap.js';
import { applyVertexSceneMove, getVertexScenePosition } from './node-edit.js';
import { suspend as historySuspend, popLast as historyPopLast, pushComposite, onAfterUndo } from './history.js';
import { deleteActiveSelection } from './equation-menu.js';
import { getDrawColor, computedShapeFill, getCornerRadius, getLineStyle } from './draw-settings.js';
import { toggleSubToolbar, showSubToolbar, isSubToolbarOpen } from './draw-toolbar.js';

const MODES = ['draw', 'select', 'shapes', 'cad'];
const POKE_PX = 22;                 // screen-pixel reach of a poke-to-select tap

let _mode = 'draw';                 // one of MODES
let _pokeReturnMode = null;         // drawing mode a poke came from (Esc returns)
let _pokeAt = null;                 // when a poke last selected something
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
  MODES.forEach((m) => {
    const btn = document.getElementById(`mode-${m}`);
    if (btn) btn.classList.toggle('active', m === _mode);
  });
}

export function setMode(mode) {
  if (!MODES.includes(mode)) return;
  _mode = mode;
  _applyModeToCanvas();
  _updateButtons();
  notifyModeChanged(); // mode-dependent CAD UI (context menu) re-evaluates
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
function _snapEndpointsToEdges(shape, indices) {
  if (_edgeSnap !== 'on') return;
  const pts = shape.points;
  if (!pts || pts.length < 2) return;
  const targets = _canvas.getObjects().filter((o) => o._isShape && !o._isGhost && o !== shape);
  if (!targets.length) return;

  const maxDist = EDGE_SNAP_PX / (_canvas.getZoom() || 1); // ~constant on screen
  let changed = false;
  const anchors = {};
  (indices || [0, pts.length - 1]).forEach((i) => {
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

// Drop a just-drawn path, leaving no trace in the undo history.
function _discardPath(p) {
  historyPopLast();                          // drop its just-recorded add-entry
  historySuspend(() => _canvas.remove(p));   // remove without recording
}

// A click (no drag) leaves a degenerate "dot" path — the two clicks of a
// double-click, clicking away from a text box, or a deliberate poke. A mark the
// user actually drew always involves some movement, so the threshold stays
// tight (widened a little for coarse pointers, which wobble): every stroke that
// becomes ink today still does, and dots/decimal points are untouched.
function _isStrayDot(p) {
  return !!p && Math.max(p.width || 0, p.height || 0) < pointerSlop(3, 2.5);
}

function _removeStrayDot(e) {
  const p = e && e.path;
  if (!_isStrayDot(p)) return false;
  _discardPath(p);
  return true;
}

// Distance from a point to a rectangle — 0 when the point is inside it.
function _distToRect(x, y, r) {
  const dx = Math.max(r.left - x, 0, x - (r.left + r.width));
  const dy = Math.max(r.top - y, 0, y - (r.top + r.height));
  return Math.hypot(dx, dy);
}

// What a poke at (x, y) grabs: the topmost object whose bounds contain the
// point, else the nearest one within POKE_PX. CAD renderings are skipped (CAD
// mode does its own, model-aware hit testing), as are ghosts and the transient
// snap guides.
function _pokeTarget(x, y) {
  const max = pointerSlop(POKE_PX) / (_canvas.getZoom() || 1);
  const objs = _canvas.getObjects();
  let best = null;
  let bestDist = Infinity;
  for (let i = objs.length - 1; i >= 0; i--) { // topmost first
    const o = objs[i];
    if (o.selectable === false || o._isGhost || o._cad || o.excludeFromExport) continue;
    const d = _distToRect(x, y, o.getBoundingRect());
    if (d === 0) return o;                     // inside the topmost hit → done
    if (d < bestDist && d <= max) {
      bestDist = d;
      best = o;
    }
  }
  return best;
}

// Poke-to-select: a tap in Draw or Shapes mode grabs the object under (or
// nearest to) it and drops into Select mode, so it can be moved, restyled or
// deleted without first hunting for the toolbar. Escape returns to drawing.
// Returns true if something was selected.
function _pokeSelect(path) {
  const x = (path.left || 0) + (path.width || 0) / 2;
  const y = (path.top || 0) + (path.height || 0) / 2;
  const target = _pokeTarget(x, y);
  if (!target) return false;
  _pokeReturnMode = _mode;
  _pokeAt = Date.now();
  setMode('select');
  _canvas.setActiveObject(target);
  _canvas.requestRenderAll();
  return true;
}

// True when a poke just selected something (within `withinMs`), consuming the
// flag. The double-click-to-add-text handler asks, so poking an object doesn't
// also drop a text box on top of it.
export function consumePokeSelection(withinMs = 500) {
  const recent = _pokeAt !== null && Date.now() - _pokeAt <= withinMs;
  _pokeAt = null;
  return recent;
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
    lineStyle: getLineStyle(),
  });
  if (!result) return;

  const { shape } = result;
  shape.set({ selectable: true, evented: true, opacity: 0.5, _isShape: true });

  // Edge snap: if an open polyline/line's start or end was drawn close to an
  // existing shape's outline, pull that endpoint onto the edge for a clean join.
  // An arrow-ended polyline's LAST points are its arrowhead wings, not a free
  // endpoint — snapping those would mangle the head, so only the start snaps.
  if (result.type === 'line' || result.type === 'polyline') {
    _snapEndpointsToEdges(shape, result.arrowEnd ? [0] : undefined);
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
    _pokeReturnMode = null; // an explicit mode choice ends the poke round-trip
    setMode(mode);
    if (sameMode) {
      toggleSubToolbar(mode);
    } else if (wasOpen) {
      showSubToolbar(mode);
    }
  };
  MODES.forEach((m) => {
    const btn = document.getElementById(`mode-${m}`);
    if (btn) btn.addEventListener('click', () => onModeButton(m));
  });

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

  canvas.on('path:created', (e) => {
    if (_mode === 'cad') {
      // In CAD mode any stroke too small to become geometry is a tap: select
      // the sketch entity under it. This keeps poking a line forgiving — a
      // finger tap that slips a few pixels selects instead of leaving a speck
      // of ink. Bigger strokes become parametric geometry (or stay as ink
      // annotation when the recognizer doesn't claim them).
      if (isCadTap(e.path)) {
        _discardPath(e.path);
        cadHandleClick(e.path);
      } else {
        cadHandleStroke(e.path);
      }
      return;
    }
    // Draw / Shapes: a tap that isn't a drawn mark is a poke — it grabs what
    // it landed on (and is simply discarded, as before, when it hits nothing).
    if (_removeStrayDot(e)) {
      _pokeSelect(e.path);
      return;
    }
    _onPathCreated(e);
  });
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

  // Direction-aware marquee selection (CAD-style window vs. crossing):
  //   drag downward (top→bottom) → "window": only fully-enclosed objects.
  //   drag upward   (bottom→top) → "crossing": any object the box touches.
  // Fabric reads canvas.selectionFullyContained when it finalizes the marquee on
  // mouse:up, so we set it live during the drag based on the pointer direction.
  let _marqueeStartY = null;
  canvas.on('mouse:down', (opt) => {
    if (_mode !== 'select') { _marqueeStartY = null; return; }
    _marqueeStartY = canvas.getPointer(opt.e).y;
  });
  canvas.on('mouse:move', (opt) => {
    // Only while an actual marquee is being dragged (not moving/resizing a shape).
    if (_marqueeStartY === null || canvas._currentTransform || !canvas._groupSelector) return;
    canvas.selectionFullyContained = canvas.getPointer(opt.e).y > _marqueeStartY;
  });
  canvas.on('mouse:up', () => { _marqueeStartY = null; });

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

  // Escape after a poke: drop the selection and go back to drawing, so the
  // whole detour is poke → restyle/move → Esc without touching the toolbar.
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || _pokeReturnMode === null || _isTyping()) return;
    const back = _pokeReturnMode;
    _pokeReturnMode = null;
    _canvas.discardActiveObject();
    _canvas.requestRenderAll();
    setMode(back);
  });

  // Delete / Backspace removes the current selection (unless typing). CAD
  // renderings (markers, dimension labels) are views of the sketch model, not
  // deletable objects — CAD deletion goes through cad-mode's own handler.
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Delete' && ev.key !== 'Backspace') return;
    const active = _canvas.getActiveObject();
    if (_isTyping() || !active || active._cad) return;
    ev.preventDefault();
    deleteActiveSelection();
  });

  setMode('draw');

  // Expose for inline scripts / debugging.
  window.setMode = setMode;
  window.getMode = getMode;
}
