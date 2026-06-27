// src/snap-move.js — align a moved selection to other objects (smart guides).
//
// When "Move align" is on, dragging an object snaps its bounding-box edges and
// centre to the nearest matching edge/centre of another object, and draws thin
// guide lines while snapped. Guides are excluded from history and from saved
// boards.

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

function linesOf(o) {
  const r = o.getBoundingRect();
  return {
    xs: [r.left, r.left + r.width / 2, r.left + r.width],
    ys: [r.top, r.top + r.height / 2, r.top + r.height],
  };
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

function onMoving(e) {
  const canvas = getCanvas();
  const moving = e.target;
  if (getSnapMove() !== 'on' || !canvas || !moving) return;

  const others = canvas.getObjects().filter(
    (o) => o !== moving && !o._isGuide && !o._isGhost && o.visible !== false && o.selectable !== false
  );
  if (_v) clearGuides(canvas);
  if (!others.length) return;

  const tol = THRESH / (canvas.getZoom() || 1);
  const m = linesOf(moving);
  let bestDX = 0, dxAbs = tol + 1, gx = null;
  let bestDY = 0, dyAbs = tol + 1, gy = null;

  for (const o of others) {
    const t = linesOf(o);
    for (const mx of m.xs) for (const tx of t.xs) {
      const a = Math.abs(tx - mx);
      if (a < dxAbs) { dxAbs = a; bestDX = tx - mx; gx = tx; }
    }
    for (const my of m.ys) for (const ty of t.ys) {
      const a = Math.abs(ty - my);
      if (a < dyAbs) { dyAbs = a; bestDY = ty - my; gy = ty; }
    }
  }

  const snappedX = dxAbs <= tol;
  const snappedY = dyAbs <= tol;
  if (snappedX) moving.left += bestDX;
  if (snappedY) moving.top += bestDY;
  if (snappedX || snappedY) moving.setCoords();

  if (!_v) { _v = makeGuide(); _h = makeGuide(); }
  const vb = viewBounds(canvas);
  if (snappedX) {
    _v.set({ x1: gx, y1: vb.top, x2: gx, y2: vb.bottom });
    _v.setCoords();
    canvas.add(_v);
  }
  if (snappedY) {
    _h.set({ x1: vb.left, y1: gy, x2: vb.right, y2: gy });
    _h.setCoords();
    canvas.add(_h);
  }
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
  canvas.on('mouse:up', endMove);
}
