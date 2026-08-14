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
  // meanErr: the fit's mean radial error in pixels — comparable against a
  // polygon reading's mean outline distance when both interpretations fit.
  return { cx, cy, rx, ry, meanErr: dev * ((rx + ry) / 2) };
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

// Ramer–Douglas–Peucker, returning the kept vertex INDICES (always including the
// endpoints). Indices let us check each resulting segment against its original
// sub-stroke. Used to straighten a multi-segment freehand stroke.
function rdpIndices(pts, eps) {
  const keep = new Array(pts.length).fill(false);
  keep[0] = true;
  keep[pts.length - 1] = true;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [s, e] = stack.pop();
    let maxD = 0;
    let idx = -1;
    for (let i = s + 1; i < e; i++) {
      const d = pointLineDistance(pts[i], pts[s], pts[e]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > eps && idx !== -1) {
      keep[idx] = true;
      stack.push([s, idx], [idx, e]);
    }
  }
  const out = [];
  for (let i = 0; i < pts.length; i++) if (keep[i]) out.push(i);
  return out;
}

// Snap a segment to horizontal/vertical when its direction is within ~9° of an
// axis, keeping `a` fixed and moving `b` onto the axis. Returns the new `b`.
const ORTHO_TOL = Math.tan((9 * Math.PI) / 180);
function snapSegment(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  if (Math.abs(dy) <= Math.abs(dx) * ORTHO_TOL) return { x: b.x, y: a.y }; // horizontal
  if (Math.abs(dx) <= Math.abs(dy) * ORTHO_TOL) return { x: a.x, y: b.y }; // vertical
  return { x: b.x, y: b.y };
}

function snapLine(a, b) {
  return { a: { x: a.x, y: a.y }, b: snapSegment(a, b) };
}

// Snap each segment of a polyline in turn (sequentially, so shared vertices stay
// connected) — turns a hand-drawn right-angle into a clean one.
function snapPolyline(v) {
  const out = [{ x: v[0].x, y: v[0].y }];
  for (let i = 1; i < v.length; i++) out.push(snapSegment(out[i - 1], v[i]));
  return out;
}

// An open multi-segment stroke (an L, a staircase, a U, a zig-zag of a few
// segments) → its corner vertices, or null. Tolerant of a wobbly/bowed segment:
// shallow (non-corner) vertices are merged out rather than rejecting the whole
// stroke; a result that barely bends overall collapses back to a single line.
// Stays conservative against curves via a per-segment straightness check.
function detectPolyline(pts, bb) {
  const diag = Math.hypot(bb.w, bb.h);
  const eps = Math.max(6, 0.04 * diag);
  const idx = rdpIndices(pts, eps);
  if (idx.length < 3) return null;

  // Merge out interior vertices that aren't real corners (gentle bends from a
  // wobbly hand or a bowed segment), keeping only sharp turns.
  const TURN = (33 * Math.PI) / 180;
  let changed = true;
  while (changed && idx.length > 2) {
    changed = false;
    for (let k = 1; k < idx.length - 1; k++) {
      const a = pts[idx[k - 1]];
      const b = pts[idx[k]];
      const c = pts[idx[k + 1]];
      if (angleTurn(b.x - a.x, b.y - a.y, c.x - b.x, c.y - b.y) < TURN) {
        idx.splice(k, 1);
        changed = true;
        break;
      }
    }
  }

  // Collapsed to no real corners: a single straight-ish run → one line (if it
  // really is line-like), else leave it as ink.
  if (idx.length < 3) {
    const a0 = pts[0];
    const b0 = pts[pts.length - 1];
    const chord = dist(a0, b0);
    let maxDev = 0;
    for (const p of pts) maxDev = Math.max(maxDev, pointLineDistance(p, a0, b0));
    if (chord >= MIN_SIZE && maxDev < Math.max(20, 0.15 * chord)) {
      const s = snapLine(a0, b0);
      return { type: 'line', a: s.a, b: s.b };
    }
    return null;
  }

  if (idx.length > 12) return null; // implausibly many corners → not a clean polyline

  const v = idx.map((i) => pts[i]);

  // Arrowhead ending: the stroke's last 1–3 segments are short and fold back
  // sharply against the shaft — the hand-drawn V of an arrow tip. Strip them
  // and flag the arrow; all the guards below then judge only the shaft.
  let arrowEnd = false;
  {
    const total = polylineLength(v);
    let maxSeg = 0;
    for (let i = 1; i < v.length; i++) maxSeg = Math.max(maxSeg, dist(v[i - 1], v[i]));
    // A wing must be clearly shorter than the shaft's dominant segment (a
    // zig-zag of comparable segments is NOT a head, however sharp its turns).
    const wingMax = Math.min(0.45 * maxSeg, 0.3 * total);
    let end = v.length - 1;
    let stripped = 0;
    while (end >= 2 && stripped < 3) {
      const wingLen = dist(v[end - 1], v[end]);
      const turn = angleTurn(
        v[end - 1].x - v[end - 2].x, v[end - 1].y - v[end - 2].y,
        v[end].x - v[end - 1].x, v[end].y - v[end - 1].y
      );
      if (wingLen < wingMax && turn > (100 * Math.PI) / 180) {
        end--;
        stripped++;
      } else {
        break;
      }
    }
    if (stripped > 0) {
      arrowEnd = true;
      v.splice(end + 1);
      idx.splice(end + 1);
    }
  }

  // A stripped head can leave a plain straight shaft → an arrow-ended line.
  if (arrowEnd && v.length === 2) {
    if (dist(v[0], v[1]) < MIN_SIZE) return null;
    const s = snapLine(v[0], v[1]);
    return { type: 'line', a: s.a, b: s.b, arrowEnd: true };
  }
  if (v.length < 3) return null;

  const minSeg = Math.max(MIN_SIZE * 0.6, 0.05 * diag);
  for (let i = 1; i < v.length; i++) {
    if (dist(v[i - 1], v[i]) < minSeg) return null; // reject tiny zig-zag noise
  }

  // Reject a smooth curve that survived as several corners all bending the same
  // way (an arc RDP chopped into segments). A real open polyline has few corners
  // or alternating ones (a staircase zig-zags); 3+ interior turns all in the same
  // rotational direction means a curve, not a polyline. Turn signs are robust
  // here because merging already removed the shallow (near-zero) vertices.
  if (v.length - 2 >= 3) {
    let sign = 0;
    let allSame = true;
    for (let i = 1; i < v.length - 1; i++) {
      const ax = v[i].x - v[i - 1].x, ay = v[i].y - v[i - 1].y;
      const bx = v[i + 1].x - v[i].x, by = v[i + 1].y - v[i].y;
      const s = Math.sign(ax * by - ay * bx);
      if (sign === 0) sign = s;
      else if (s !== sign) { allSame = false; break; }
    }
    if (allSame) return null;
  }

  // Curve guard: each retained segment's original sub-stroke must be roughly
  // straight. A smooth curve that RDP chopped into pieces would bow within each
  // piece and is rejected here (stays ink).
  for (let k = 1; k < idx.length; k++) {
    const seg = pts.slice(idx[k - 1], idx[k] + 1);
    const segLen = dist(pts[idx[k - 1]], pts[idx[k]]);
    if (maxDeviationFromChord(seg, pts[idx[k - 1]], pts[idx[k]]) > 0.14 * segLen + 4) return null;
  }

  return { type: 'polyline', points: snapPolyline(v), arrowEnd };
}

// A closed stroke that isn't a rectangle or ellipse → a clean polygon (a
// triangle, diamond, pentagon, notched/L-shaped outline …), or null. Same
// straighten-and-merge approach as the open case, but cyclic and WITHOUT the
// same-direction rejection (a convex polygon legitimately turns one way) — smooth
// closed curves are kept out by the ellipse fit (tried first) and curve guard.
function detectPolygon(pts, bb) {
  const diag = Math.hypot(bb.w, bb.h);
  const eps = Math.max(6, 0.04 * diag);
  let idx = rdpIndices(pts, eps);
  // Closed loop: the last vertex is the (near-duplicate) start — drop it.
  if (idx.length >= 2 && dist(pts[idx[0]], pts[idx[idx.length - 1]]) < 0.25 * Math.max(bb.w, bb.h)) {
    idx = idx.slice(0, -1);
  }
  if (idx.length < 3) return null;

  // Merge out shallow (non-corner) vertices, cyclically.
  const TURN = (33 * Math.PI) / 180;
  const turnAt = (k) => {
    const a = pts[idx[(k - 1 + idx.length) % idx.length]];
    const b = pts[idx[k]];
    const c = pts[idx[(k + 1) % idx.length]];
    return angleTurn(b.x - a.x, b.y - a.y, c.x - b.x, c.y - b.y);
  };
  let changed = true;
  while (changed && idx.length > 3) {
    changed = false;
    for (let k = 0; k < idx.length; k++) {
      if (turnAt(k) < TURN) { idx.splice(k, 1); changed = true; break; }
    }
  }
  if (idx.length < 3 || idx.length > 10) return null;

  const v = idx.map((i) => pts[i]);
  const minSeg = Math.max(MIN_SIZE * 0.6, 0.05 * diag);
  for (let k = 0; k < v.length; k++) {
    if (dist(v[k], v[(k + 1) % v.length]) < minSeg) return null;
  }
  // Curve guard: each (non-closing) segment's original sub-stroke must be ~straight.
  for (let k = 1; k < idx.length; k++) {
    const seg = pts.slice(idx[k - 1], idx[k] + 1);
    const segLen = dist(pts[idx[k - 1]], pts[idx[k]]);
    if (maxDeviationFromChord(seg, pts[idx[k - 1]], pts[idx[k]]) > 0.14 * segLen + 4) return null;
  }
  return { type: 'polygon', points: v.map((p) => ({ x: p.x, y: p.y })) };
}

// Distance from p to the segment a–b (not the infinite line).
function pointSegmentDistance(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return dist(p, a);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// Mean distance from the stroke's points to a closed polygon's outline — the
// polygon reading's fit error, comparable with fitEllipse's meanErr (px).
function meanDistanceToPolygon(pts, verts) {
  const n = verts.length;
  let sum = 0;
  for (const p of pts) {
    let best = Infinity;
    for (let i = 0; i < n; i++) {
      const d = pointSegmentDistance(p, verts[i], verts[(i + 1) % n]);
      if (d < best) best = d;
    }
    sum += best;
  }
  return sum / pts.length;
}

// How much better the polygon must fit before it beats the ellipse (a polygon
// has more free parameters, so it always fits a little better).
const ELLIPSE_BIAS = 1.6;

// Fraction of points that stray well into the interior, away from the bounding
// box outline. A real rectangle hugs its bbox (≈0); a heart, triangle or
// staircase dips inside, so a sizable fraction strays. Guards rect detection
// against any closed blob that merely happens to have 3–6 sharp corners.
function interiorStrayFraction(pts, bb) {
  const half = Math.max(1, Math.min(bb.w, bb.h) / 2);
  const thresh = 0.3 * half;
  let stray = 0;
  for (const p of pts) {
    const edgeDist = Math.min(p.x - bb.minX, bb.maxX - p.x, p.y - bb.minY, bb.maxY - p.y);
    if (edgeDist > thresh) stray++;
  }
  return stray / pts.length;
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
//   { type: 'polyline', points: [{x,y}, ...] }   (open)
//   { type: 'polygon',  points: [{x,y}, ...] }   (closed)
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
    if (isStraight(pts)) {
      const s = snapLine(a, b);
      return { type: 'line', a: s.a, b: s.b };
    }
    // Multi-segment straightening: an L / staircase / few-segment zig-zag.
    const poly = detectPolyline(pts, bb);
    if (poly) return poly;
    return null;
  }

  // Corner count is the robust rect-vs-ellipse signal: a rectangle has ~4 sharp
  // corners, an ellipse none — far more tolerant of shaky sides than an
  // edge-distance or area test, which a single noisy spike throws off. But it
  // also fires on hearts/triangles/staircases, so additionally require the
  // stroke to hug its bounding box (few interior strays).
  const corners = countCorners(pts);
  if (corners >= 3 && corners <= 6 && interiorStrayFraction(pts, bb) < 0.12) {
    return { type: 'rect', x: bb.minX, y: bb.minY, w: bb.w, h: bb.h };
  }

  // Ellipse vs. polygon is decided by which reading actually fits the ink, not
  // by trying one first: a rotated quadrilateral (a romb) passes the radial
  // ellipse test numerically — its corners sit near the bbox ellipse and its
  // sides bow inside it — so an order-based choice would call it an ellipse.
  // Comparing mean fit error in pixels settles it: a real ellipse hugs the
  // ellipse far better than any few-vertex polygon, and vice versa.
  const ell = fitEllipse(pts, bb);
  const polygon = detectPolygon(pts, bb);
  const asEllipse = () => ({
    type: ell.rx === ell.ry ? 'circle' : 'ellipse',
    cx: ell.cx, cy: ell.cy, rx: ell.rx, ry: ell.ry,
  });

  if (ell && polygon) {
    // The margin favours the ellipse: a polygon has many more free parameters,
    // so it always fits a bit better and would otherwise win on smooth strokes.
    return meanDistanceToPolygon(pts, polygon.points) * ELLIPSE_BIAS < ell.meanErr
      ? polygon
      : asEllipse();
  }
  if (ell) return asEllipse();
  // Not an ellipse — a clean closed polygon (triangle, diamond, notched
  // outline, …) before giving up and leaving it as ink.
  if (polygon) return polygon;

  return null;
}
