// src/edge-snap.js — snap a point onto the nearest edge of existing shapes.
//
// Used when a freehand polyline/line is recognized: if its start/end point was
// drawn very close to another smart shape's outline, the endpoint is pulled onto
// that edge so connections are clean. Works in scene coordinates and accounts for
// each target's transform (move/scale/rotate), so it keeps working after edits.

import { Point, util } from 'fabric';

// A scene point expressed in a target's local coordinate space, and back. Used to
// pin an anchored vertex to a fixed spot on a shape so it follows the shape's
// moves/scales/rotations.
export function toTargetLocal(target, scenePoint) {
  const p = new Point(scenePoint.x, scenePoint.y).transform(util.invertTransform(target.calcTransformMatrix()));
  return { x: p.x, y: p.y };
}

export function fromTargetLocal(target, localPoint) {
  const p = new Point(localPoint.x, localPoint.y).transform(target.calcTransformMatrix());
  return { x: p.x, y: p.y };
}

// The vertices of a Polyline/Polygon in scene coordinates.
function polyVertsScene(obj) {
  const m = obj.calcTransformMatrix();
  return obj.points.map((pt) =>
    new Point(pt.x - obj.pathOffset.x, pt.y - obj.pathOffset.y).transform(m)
  );
}

// An object's outline as a list of [a, b] segments in scene coordinates.
function shapeSegments(obj) {
  switch (obj.type) {
    case 'polyline':
    case 'polygon': {
      const v = polyVertsScene(obj);
      const segs = [];
      for (let i = 1; i < v.length; i++) segs.push([v[i - 1], v[i]]);
      if (obj.type === 'polygon' && v.length > 2) segs.push([v[v.length - 1], v[0]]);
      return segs;
    }
    case 'rect': {
      const c = obj.getCoords(); // [tl, tr, br, bl] in scene coords
      return [[c[0], c[1]], [c[1], c[2]], [c[2], c[3]], [c[3], c[0]]];
    }
    case 'ellipse':
    case 'circle': {
      const m = obj.calcTransformMatrix();
      const N = 48;
      const pts = [];
      for (let i = 0; i < N; i++) {
        const a = (i / N) * 2 * Math.PI;
        pts.push(new Point(obj.rx * Math.cos(a), obj.ry * Math.sin(a)).transform(m));
      }
      const segs = [];
      for (let i = 1; i < pts.length; i++) segs.push([pts[i - 1], pts[i]]);
      segs.push([pts[pts.length - 1], pts[0]]);
      return segs;
    }
    case 'line': {
      const m = obj.calcTransformMatrix();
      const lp = obj.calcLinePoints();
      return [[new Point(lp.x1, lp.y1).transform(m), new Point(lp.x2, lp.y2).transform(m)]];
    }
    default:
      return [];
  }
}

function nearestOnSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return { x: a.x + dx * t, y: a.y + dy * t };
}

// Nearest point on any shape's edge within maxDist of p, or null. Returns the
// snapped point plus the shape it snapped to (for later anchoring).
export function snapPointToShapes(p, shapes, maxDist) {
  let best = null;
  let bestObj = null;
  let bestD = maxDist;
  for (const obj of shapes) {
    for (const [a, b] of shapeSegments(obj)) {
      const q = nearestOnSegment(p, a, b);
      const d = Math.hypot(q.x - p.x, q.y - p.y);
      if (d < bestD) { bestD = d; best = q; bestObj = obj; }
    }
  }
  return best ? { point: best, target: bestObj } : null;
}
