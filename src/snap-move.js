// src/snap-move.js — align a moved/resized selection to other objects.
//
// When "Align" is on, dragging an object snaps its bounding-box edges/centre to
// the nearest matching edge/centre of another object (with guide lines), and
// resizing snaps the dragged edge the same way while the opposite edge stays
// fixed. Guides are excluded from history and from saved boards.

import { getCanvas } from './canvas.js';
import { Line } from 'fabric';
import { getSnapMove } from './draw-settings.js';

const THRESH = 7; // screen pixels

let _v = null;
let _h = null;

function makeGuide() {
  return new Line([0, 0, 0, 0], {
    stroke: '#e5479a',
    strokeWidth: 1,
    selectable: false,
    evented: false,
    excludeFromExport: true,
    _noHistory: true,
    _isGuide: true,
  });
}

// The candidate x/y snap lines (edges + centres) of every other object.
function targetLines(canvas, moving) {
  const xs = [];
  const ys = [];
  canvas.getObjects().forEach((o) => {
    if (o === moving || o._isGuide || o._isGhost || o.visible === false || o.selectable === false) return;
    const r = o.getBoundingRect();
    xs.push(r.left, r.left + r.width / 2, r.left + r.width);
    ys.push(r.top, r.top + r.height / 2, r.top + r.height);
  });
  return { xs, ys };
}

function nearest(value, candidates, tol) {
  let best = tol + 1;
  let hit = null;
  for (const c of candidates) {
    const a = Math.abs(c - value);
    if (a < best) { best = a; hit = c; }
  }
  return best <= tol ? hit : null;
}

function viewBounds(canvas) {
  const t = canvas.viewportTransform;
  return {
    left: -t[4] / t[0],
    top: -t[5] / t[3],
    right: (canvas.getWidth() - t[4]) / t[0],
    bottom: (canvas.getHeight() - t[5]) / t[3],
  };
}

function clearGuides(canvas) {
  const objs = canvas.getObjects();
  if (_v && objs.includes(_v)) canvas.remove(_v);
  if (_h && objs.includes(_h)) canvas.remove(_h);
}

function drawGuides(canvas, gx, gy) {
  if (!_v) { _v = makeGuide(); _h = makeGuide(); }
  const vb = viewBounds(canvas);
  if (gx !== null) { _v.set({ x1: gx, y1: vb.top, x2: gx, y2: vb.bottom }); _v.setCoords(); canvas.add(_v); }
  if (gy !== null) { _h.set({ x1: vb.left, y1: gy, x2: vb.right, y2: gy }); _h.setCoords(); canvas.add(_h); }
}

function onMoving(e) {
  const canvas = getCanvas();
  const moving = e.target;
  if (getSnapMove() !== 'on' || !canvas || !moving) return;
  if (_v) clearGuides(canvas);

  const { xs, ys } = targetLines(canvas, moving);
  if (!xs.length) return;
  const tol = THRESH / (canvas.getZoom() || 1);
  const r = moving.getBoundingRect();

  // Try left/centre/right against any target line; take the nearest snap.
  let gx = null, gy = null;
  for (const v of [r.left, r.left + r.width / 2, r.left + r.width]) {
    const hit = nearest(v, xs, tol);
    if (hit !== null) { moving.left += hit - v; gx = hit; break; }
  }
  for (const v of [r.top, r.top + r.height / 2, r.top + r.height]) {
    const hit = nearest(v, ys, tol);
    if (hit !== null) { moving.top += hit - v; gy = hit; break; }
  }
  if (gx !== null || gy !== null) moving.setCoords();
  drawGuides(canvas, gx, gy);
}

function onScaling(e) {
  const canvas = getCanvas();
  const obj = e.target;
  const corner = e.transform && e.transform.corner;
  if (getSnapMove() !== 'on' || !canvas || !obj || !corner) return;
  if (_v) clearGuides(canvas);
  if ((obj.angle || 0) % 360 !== 0) return; // skip rotated objects (bbox != axes)

  const { xs, ys } = targetLines(canvas, obj);
  if (!xs.length) return;
  const tol = THRESH / (canvas.getZoom() || 1);

  const movesRight = corner === 'tr' || corner === 'br' || corner === 'mr';
  const movesLeft = corner === 'tl' || corner === 'bl' || corner === 'ml';
  const movesBottom = corner === 'bl' || corner === 'br' || corner === 'mb';
  const movesTop = corner === 'tl' || corner === 'tr' || corner === 'mt';

  const r0 = obj.getBoundingRect();
  let gx = null, gy = null;

  if (movesRight || movesLeft) {
    const fixedX = movesRight ? r0.left : r0.left + r0.width;
    const movingX = movesRight ? r0.left + r0.width : r0.left;
    const tx = nearest(movingX, xs, tol);
    if (tx !== null) {
      const span0 = Math.abs(movingX - fixedX);
      const span1 = Math.abs(tx - fixedX);
      if (span0 > 1 && span1 > 0) { obj.scaleX *= span1 / span0; gx = tx; }
    }
  }
  if (movesTop || movesBottom) {
    const fixedY = movesBottom ? r0.top : r0.top + r0.height;
    const movingY = movesBottom ? r0.top + r0.height : r0.top;
    const ty = nearest(movingY, ys, tol);
    if (ty !== null) {
      const span0 = Math.abs(movingY - fixedY);
      const span1 = Math.abs(ty - fixedY);
      if (span0 > 1 && span1 > 0) { obj.scaleY *= span1 / span0; gy = ty; }
    }
  }

  // Re-anchor: keep the fixed edge in place after adjusting the scale.
  if (gx !== null || gy !== null) {
    obj.setCoords();
    const r1 = obj.getBoundingRect();
    if (gx !== null) {
      const fixedX = movesRight ? r0.left : r0.left + r0.width;
      const newFixedX = movesRight ? r1.left : r1.left + r1.width;
      obj.left += fixedX - newFixedX;
    }
    if (gy !== null) {
      const fixedY = movesBottom ? r0.top : r0.top + r0.height;
      const newFixedY = movesBottom ? r1.top : r1.top + r1.height;
      obj.top += fixedY - newFixedY;
    }
    obj.setCoords();
  }
  drawGuides(canvas, gx, gy);
}

function endMove() {
  const canvas = getCanvas();
  if (!canvas) return;
  clearGuides(canvas);
  canvas.requestRenderAll();
}

export function initMoveSnap(canvas) {
  if (!canvas) return;
  canvas.on('object:moving', onMoving);
  canvas.on('object:scaling', onScaling);
  canvas.on('mouse:up', endMove);
}
