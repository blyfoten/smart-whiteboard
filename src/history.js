// src/history.js — a small undo history (command stack).
//
// Each command is an object with an `undo(canvas)` function. Adds, removals and
// modifications (move / scale / rotate / node-edit) are recorded automatically
// via canvas events; multi-step operations (smart-shape snap, extract-in-place,
// clear) record a single composite command instead, by suspending the automatic
// recording while they mutate the canvas and pushing one command at the end.

let _stack = [];
let _suspended = false;
const _afterUndo = [];

export function isSuspended() {
  return _suspended;
}

// Run fn with automatic recording suspended (so internal mutations of a composite
// operation don't each become their own undo step). Returns fn's result.
export function suspend(fn) {
  const prev = _suspended;
  _suspended = true;
  try {
    return fn();
  } finally {
    _suspended = prev;
  }
}

export function record(cmd) {
  if (!_suspended && cmd && typeof cmd.undo === 'function') _stack.push(cmd);
}

// Push a single composite undo step (used after a suspended multi-step change).
export function pushComposite(undoFn) {
  record({ undo: undoFn });
}

export function popLast() {
  return _stack.pop();
}

export function clearHistory() {
  _stack = [];
}

// Register a callback run after every undo (e.g. to re-apply edge anchors).
export function onAfterUndo(cb) {
  _afterUndo.push(cb);
}

export function undo(canvas) {
  const cmd = _stack.pop();
  if (!cmd) return;
  suspend(() => {
    try {
      cmd.undo(canvas);
    } catch (e) {
      console.error('Undo failed:', e);
    }
  });
  if (canvas) canvas.requestRenderAll();
  _afterUndo.forEach((cb) => {
    try {
      cb(canvas);
    } catch (e) {
      /* ignore */
    }
  });
}

function snapshot(o) {
  const s = {
    left: o.left, top: o.top, width: o.width, height: o.height,
    scaleX: o.scaleX, scaleY: o.scaleY, angle: o.angle, skewX: o.skewX, skewY: o.skewY,
  };
  if (Array.isArray(o.points)) s.points = o.points.map((p) => ({ x: p.x, y: p.y }));
  if (o.pathOffset) s.pathOffset = { x: o.pathOffset.x, y: o.pathOffset.y };
  return s;
}

function restore(o, s) {
  if (s.points && Array.isArray(o.points)) o.points = s.points.map((p) => ({ x: p.x, y: p.y }));
  o.set({
    left: s.left, top: s.top, width: s.width, height: s.height,
    scaleX: s.scaleX, scaleY: s.scaleY, angle: s.angle, skewX: s.skewX, skewY: s.skewY,
  });
  if (s.pathOffset) o.pathOffset = { x: s.pathOffset.x, y: s.pathOffset.y };
  o.setCoords();
}

// Wire automatic recording of adds / removals / modifications onto a canvas.
export function initHistory(canvas) {
  if (!canvas) return;

  canvas.on('object:added', (e) => {
    const o = e.target;
    if (_suspended || !o || o._isGhost || o._noHistory) return;
    record({ undo: (c) => c.remove(o) });
  });

  canvas.on('object:removed', (e) => {
    const o = e.target;
    if (_suspended || !o || o._isGhost || o._noHistory) return;
    record({ undo: (c) => c.add(o) });
  });

  // Snapshot an object's geometry when a drag/transform may begin.
  canvas.on('mouse:down', (e) => {
    const t = e.target;
    if (t && !t._noHistory) t._undoBefore = snapshot(t);
  });

  canvas.on('object:modified', (e) => {
    const o = e.target;
    if (_suspended || !o || o._noHistory || !o._undoBefore) return;
    const before = o._undoBefore;
    o._undoBefore = null;
    record({ undo: () => restore(o, before) });
  });
}
