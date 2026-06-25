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

// Magnitude of the turn between two consecutive direction vectors (0..π).
function angleTurn(ax, ay, bx, by) {
  const dot = ax * bx + ay * by;
  const det = ax * by - ay * bx;
  return Math.abs(Math.atan2(det, dot));
}

// Resample a polyline to n evenly-spaced points (normalizes point density).
function resample(pts, n) {
  const total = polylineLength(pts);
  if (total === 0) return pts.slice(0, 1);
  const step = total / (n - 1);
  const out = [pts[0]];
  let prev = pts[0];
  let i = 1;
  let acc = 0;
  while (i < pts.length && out.length < n) {
    const d = dist(prev, pts[i]);
    if (d > 0 && acc + d >= step) {
      const t = (step - acc) / d;
      prev = { x: prev.x + (pts[i].x - prev.x) * t, y: prev.y + (pts[i].y - prev.y) * t };
      out.push(prev);
      acc = 0;
    } else {
      acc += d;
      prev = pts[i];
      i++;
    }
  }
  while (out.length < n) out.push(pts[pts.length - 1]);
  return out;
}

// Cyclic 3-point moving average — damps hand jitter before corner detection.
function smoothCyclic(pts) {
  const n = pts.length;
  return pts.map((_, i) => {
    const a = pts[(i - 1 + n) % n], b = pts[i], c = pts[(i + 1) % n];
    return { x: (a.x + b.x + c.x) / 3, y: (a.y + b.y + c.y) / 3 };
  });
}

// Count sharp corners on a CLOSED stroke (treated cyclically): a rectangle
// yields ~4, an ellipse 0. Robust to shaky sides and bbox-inflating spikes,
// unlike edge-distance or area tests.
function countCorners(pts) {
  const n = 64;
  const k = 4; // comparison window
  const TH = (55 * Math.PI) / 180;
  const rs = smoothCyclic(resample(pts, n));
  const turn = rs.map((b, i) => {
    const a = rs[(i - k + n) % n];
    const c = rs[(i + k) % n];
    return angleTurn(b.x - a.x, b.y - a.y, c.x - b.x, c.y - b.y);
  });
  let count = 0;
  for (let i = 0; i < n; i++) {
    if (turn[i] < TH) continue;
    let isPeak = true;
    for (let j = 1; j <= k; j++) {
      if (turn[(i - j + n) % n] >= turn[i] || turn[(i + j) % n] > turn[i]) { isPeak = false; break; }
    }
    if (isPeak) count++;
  }
  return count;
}

// Ramer–Douglas–Peucker: simplify a polyline to the fewest vertices that keep
// every original point within `eps` of the simplified path. Used to straighten a
// multi-segment freehand stroke into connected straight segments.
function rdp(points, eps) {
  if (points.length < 3) return points.slice();
  let maxD = 0;
  let idx = 0;
  const a = points[0];
  const b = points[points.length - 1];
  for (let i = 1; i < points.length - 1; i++) {
    const d = pointLineDistance(points[i], a, b);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > eps) {
    const left = rdp(points.slice(0, idx + 1), eps);
    const right = rdp(points.slice(idx), eps);
    return left.slice(0, -1).concat(right);
  }
  return [a, b];
}

// An open multi-segment stroke (an L, a staircase, a zig-zag of a few segments)
// → its corner vertices, or null. Conservative: rejects curves, scribbles and
// handwriting, which simplify to too many or too-soft vertices.
function detectPolyline(pts, bb) {
  const diag = Math.hypot(bb.w, bb.h);
  const eps = Math.max(6, 0.035 * diag);
  const v = rdp(pts, eps);
  if (v.length < 3 || v.length > 7) return null; // 2 = straight line; >7 = not clean

  const minSeg = Math.max(MIN_SIZE * 0.7, 0.09 * diag);
  for (let i = 1; i < v.length; i++) {
    if (dist(v[i - 1], v[i]) < minSeg) return null; // reject tiny zig-zag noise
  }
  // Every interior vertex must be a real corner (a sharp turn) — otherwise the
  // stroke is a smooth curve that RDP merely chopped into segments.
  const TURN = (30 * Math.PI) / 180;
  for (let i = 1; i < v.length - 1; i++) {
    const t = angleTurn(v[i].x - v[i - 1].x, v[i].y - v[i - 1].y, v[i + 1].x - v[i].x, v[i + 1].y - v[i].y);
    if (t < TURN) return null;
  }
  return { type: 'polyline', points: v.map((p) => ({ x: p.x, y: p.y })) };
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
//   { type: 'line',     a, b }
//   { type: 'polyline', points: [{x,y}, ...] }
//   { type: 'arrow',    a, b }
//   { type: 'circle' | 'ellipse', cx, cy, rx, ry }
//   { type: 'rect',     x, y, w, h }
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
    // Multi-segment straightening: an L / staircase / few-segment zig-zag.
    const poly = detectPolyline(pts, bb);
    if (poly) return poly;
    return null;
  }

  // Corner count is the robust rect-vs-ellipse signal: a rectangle has ~4 sharp
  // corners, an ellipse none — far more tolerant of shaky sides than an
  // edge-distance or area test, which a single noisy spike throws off.
  const corners = countCorners(pts);
  if (corners >= 3 && corners <= 6) {
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
