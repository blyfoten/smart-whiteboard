// src/shape-classifier.js — pure stroke geometry & classification (no Fabric)
//
// Given the anchor points of a freehand stroke, decide whether it cleanly
// matches a geometric primitive and return a plain descriptor (or null).
// Kept free of any Fabric/DOM dependency so it can be unit-tested in Node.
// Deliberately conservative: anything that isn't a confident match returns
// null and stays as ink — so handwriting and equations are never mangled.

export const MIN_SIZE = 24; // ignore tiny strokes (dots, punctuation, marks)

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function polylineLength(pts) {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  return len;
}

function boundingBox(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.x > maxX) maxX = p.x;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY, w: maxX - minX, h: maxY - minY };
}

// Perpendicular distance from point p to the line through a–b.
function pointLineDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0) return dist(p, a);
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / len;
}

function maxDeviationFromChord(pts, a, b) {
  let max = 0;
  for (const p of pts) {
    const d = pointLineDistance(p, a, b);
    if (d > max) max = d;
  }
  return max;
}

// Extract anchor points from a Fabric brush Path's `path` command array.
export function pathToPoints(fabricPath) {
  const segs = fabricPath && fabricPath.path;
  if (!Array.isArray(segs)) return [];
  const pts = [];
  for (const s of segs) {
    switch (s[0]) {
      case 'M':
      case 'L':
        pts.push({ x: s[1], y: s[2] });
        break;
      case 'Q':
        pts.push({ x: s[3], y: s[4] }); // quadratic endpoint
        break;
      case 'C':
        pts.push({ x: s[5], y: s[6] }); // cubic endpoint
        break;
      default:
        break;
    }
  }
  return pts;
}

function isStraight(pts) {
  const a = pts[0];
  const b = pts[pts.length - 1];
  const chord = dist(a, b);
  if (chord < MIN_SIZE) return false;
  const dev = maxDeviationFromChord(pts, a, b);
  const total = polylineLength(pts);
  return dev < 0.08 * chord + 6 && total < chord * 1.25;
}

function fitEllipse(pts, bb) {
  const cx = bb.minX + bb.w / 2;
  const cy = bb.minY + bb.h / 2;
  let rx = bb.w / 2;
  let ry = bb.h / 2;
  if (rx < 8 || ry < 8) return null;
  let dev = 0;
  for (const p of pts) {
    const nx = (p.x - cx) / rx;
    const ny = (p.y - cy) / ry;
    dev += Math.abs(Math.hypot(nx, ny) - 1);
  }
  dev /= pts.length;
  if (dev > 0.16) return null;
  if (Math.abs(rx - ry) / Math.max(rx, ry) < 0.2) {
    rx = ry = (rx + ry) / 2; // snap near-circles to a true circle
  }
  return { cx, cy, rx, ry };
}

// A rectangle's points hug the bounding-box perimeter; an ellipse only touches
// it at four points. Measure the fraction of points sitting in a thin band
// along the bbox edges, and require all four sides to be represented.
function isRectangle(pts, bb) {
  if (bb.w < MIN_SIZE || bb.h < MIN_SIZE) return false;
  // Tight band: rectangle points sit ~on the edges; a circle's only touch the
  // bbox near the 4 cardinal points, so a wide band would misread it as a rect.
  const band = 0.06 * Math.min(bb.w, bb.h) + 3;
  let nearEdge = 0;
  let left = 0, right = 0, top = 0, bottom = 0;
  for (const p of pts) {
    const dl = Math.abs(p.x - bb.minX);
    const dr = Math.abs(p.x - bb.maxX);
    const dt = Math.abs(p.y - bb.minY);
    const db = Math.abs(p.y - bb.maxY);
    if (Math.min(dl, dr, dt, db) <= band) nearEdge++;
    if (dl <= band) left++;
    if (dr <= band) right++;
    if (dt <= band) top++;
    if (db <= band) bottom++;
  }
  return nearEdge / pts.length > 0.85 && left > 0 && right > 0 && top > 0 && bottom > 0;
}

// Arrow: a mostly-straight shaft from start to the farthest point, followed by
// a short hook (the arrowhead) that folds back toward the start.
function detectArrow(pts) {
  const a = pts[0];
  let tipIdx = 0;
  let tipDist = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = dist(a, pts[i]);
    if (d > tipDist) {
      tipDist = d;
      tipIdx = i;
    }
  }
  if (tipDist < MIN_SIZE || tipIdx < 2 || tipIdx > pts.length - 2) return null;

  const tip = pts[tipIdx];
  const shaft = pts.slice(0, tipIdx + 1);
  if (maxDeviationFromChord(shaft, a, tip) > 0.06 * tipDist + 5) return null;

  const tail = pts.slice(tipIdx);
  if (polylineLength(tail) > 0.5 * tipDist) return null;

  const dx = tip.x - a.x;
  const dy = tip.y - a.y;
  const last = pts[pts.length - 1];
  const projLast = ((last.x - a.x) * dx + (last.y - a.y) * dy) / (tipDist * tipDist);
  if (projLast > 0.95) return null;

  return { a, b: tip };
}

// classifyStroke(points) -> descriptor | null
//   { type: 'line',    a, b }
//   { type: 'arrow',   a, b }
//   { type: 'circle' | 'ellipse', cx, cy, rx, ry }
//   { type: 'rect',    x, y, w, h }
export function classifyStroke(pts) {
  if (!pts || pts.length < 3) return null;

  const bb = boundingBox(pts);
  if (Math.hypot(bb.w, bb.h) < MIN_SIZE) return null;

  const a = pts[0];
  const b = pts[pts.length - 1];
  const closed = dist(a, b) < 0.2 * Math.max(bb.w, bb.h);

  if (!closed) {
    // Arrow before line: a plain line has no hook, so detectArrow returns null
    // and we fall through; an arrow's hook would otherwise read as "straight".
    const arrow = detectArrow(pts);
    if (arrow) return { type: 'arrow', a: arrow.a, b: arrow.b };
    if (isStraight(pts)) return { type: 'line', a: { ...a }, b: { ...b } };
    return null;
  }

  // Rectangle before ellipse: a clean ellipse simplifies to >4 corners, so the
  // 4-corner test won't catch it; checking ellipse first would let a rectangle
  // (whose points hug the bounding box) slip through the ellipse fit.
  if (isRectangle(pts, bb)) {
    return { type: 'rect', x: bb.minX, y: bb.minY, w: bb.w, h: bb.h };
  }

  const ell = fitEllipse(pts, bb);
  if (ell) {
    return {
      type: ell.rx === ell.ry ? 'circle' : 'ellipse',
      cx: ell.cx, cy: ell.cy, rx: ell.rx, ry: ell.ry,
    };
  }

  return null;
}
