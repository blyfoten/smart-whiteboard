// src/cad/sketch.js — the parametric 2D sketch model (no Fabric, no DOM).
//
// A Sketch is the CAD-mode source of truth: points, entities that reference
// them (lines by endpoint ids, circles/arcs by a centre id + radius), constraints,
// and named parameters. Fabric objects in cad-mode.js are just a rendering of
// this model; the solver (solver.js) mutates point coords / radii to satisfy
// the constraints. Kept pure so it can be unit-tested in Node.
//
// An arc is a circle's centre + radius plus a fixed start/end angle (radians,
// standard atan2 convention on this y-down canvas): { id, type:'arc', c, r,
// startAngle, endAngle }. The angles aren't solver variables — only the centre
// and radius move — so an arc behaves exactly like a circle for dragging,
// 'equal' and the 'radius' dimension (both accept a circle or an arc id).
//
// Constraint types and their references:
//   { type: 'horizontal',    line }
//   { type: 'vertical',      line }
//   { type: 'parallel',      a, b }            (two line ids)
//   { type: 'perpendicular', a, b }            (two line ids)
//   { type: 'equal',         a, b }            (two lines or two circles)
//   { type: 'pointOnLine',   point, line }
//   { type: 'fix',           point, x, y }
//   { type: 'distance',      p1, p2, expr }    (dimension; expr may use params)
//   { type: 'radius',        circle, expr }    (dimension)
//   { type: 'angle',         a, b, expr }      (dimension, degrees between lines)

import { evaluateExpression } from './expr.js';

export const DIMENSION_TYPES = ['distance', 'radius', 'angle'];

// --- offset geometry helpers (module-private; used by Sketch#offsetChain) ---

// Order a set of line entities into the single simple path they form: each
// interior point touched by exactly two of the given lines, at most two
// points touched by exactly one (an open chain's ends) or none (a closed
// loop). Returns { pointOrder, lineOrder, closed } or null if the ids branch
// (a T-junction), don't connect, or form more than one run.
function orderChain(lines) {
  const adj = new Map(); // point id -> [{ other, lineId }]
  const touch = (a, b, lineId) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push({ other: b, lineId });
  };
  lines.forEach((l) => { touch(l.p1, l.p2, l.id); touch(l.p2, l.p1, l.id); });

  for (const edges of adj.values()) {
    if (edges.length > 2) return null; // a T-junction — not a simple chain
  }
  const ends = [...adj.entries()].filter(([, edges]) => edges.length === 1).map(([id]) => id);
  let start;
  let closed;
  if (ends.length === 2) { start = ends[0]; closed = false; }
  else if (ends.length === 0) { start = lines[0].p1; closed = true; }
  else return null; // more than one open run

  const pointOrder = [start];
  const lineOrder = [];
  const usedLines = new Set();
  let current = start;
  for (let i = 0; i < lines.length; i++) {
    const next = (adj.get(current) || []).find((e) => !usedLines.has(e.lineId));
    if (!next) return null;
    usedLines.add(next.lineId);
    lineOrder.push(next.lineId);
    pointOrder.push(next.other);
    current = next.other;
  }
  if (usedLines.size !== lines.length) return null;
  if (closed) {
    if (pointOrder[pointOrder.length - 1] !== start) return null;
    pointOrder.pop(); // drop the duplicate closing point — addChain re-adds it
  }
  return { pointOrder, lineOrder, closed };
}

// Unit normal of a -> b, rotated 90° (canvas y-down: positive `distance`
// offsets to the right of travel).
function unitNormal(a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy) || 1;
  return { x: -dy / len, y: dx / len };
}

// Intersection of infinite lines p1+t*d1 and p2+s*d2, or null if parallel.
function rayIntersect(p1, d1, p2, d2) {
  const denom = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / denom;
  return { x: p1.x + t * d1.x, y: p1.y + t * d1.y };
}

// How many scalar equations each constraint contributes (for the DOF estimate).
const EQUATION_COUNT = {
  horizontal: 1, vertical: 1, parallel: 1, perpendicular: 1, equal: 1,
  pointOnLine: 1, distance: 1, radius: 1, angle: 1, fix: 2,
};

export class Sketch {
  constructor() {
    this.points = [];       // { id, x, y }
    this.entities = [];     // { id, type:'line', p1, p2 } | { id, type:'circle', c, r }
    this.constraints = [];  // see table above
    this.params = [];       // { name, expr } — ordered, later ones may use earlier
    this._nextId = 1;
  }

  _id(prefix) {
    return `${prefix}${this._nextId++}`;
  }

  // --- lookup ---

  point(id) { return this.points.find((p) => p.id === id) || null; }
  entity(id) { return this.entities.find((e) => e.id === id) || null; }
  constraint(id) { return this.constraints.find((c) => c.id === id) || null; }
  lines() { return this.entities.filter((e) => e.type === 'line'); }
  circles() { return this.entities.filter((e) => e.type === 'circle'); }
  arcs() { return this.entities.filter((e) => e.type === 'arc'); }
  // Entities with a radius variable — circles and arcs alike.
  radiused() { return this.entities.filter((e) => e.type === 'circle' || e.type === 'arc'); }

  // --- construction ---

  addPoint(x, y) {
    const p = { id: this._id('p'), x, y };
    this.points.push(p);
    return p;
  }

  // Reuse an existing point within `tol` of (x, y), else create one. This is
  // how recognized strokes pick up coincidence with what's already sketched.
  findOrAddPoint(x, y, tol = 0) {
    if (tol > 0) {
      const near = this.findPointNear(x, y, tol);
      if (near) return near;
    }
    return this.addPoint(x, y);
  }

  findPointNear(x, y, tol) {
    let best = null;
    let bestD = tol;
    for (const p of this.points) {
      const d = Math.hypot(p.x - x, p.y - y);
      if (d <= bestD) { best = p; bestD = d; }
    }
    return best;
  }

  addLine(p1, p2) {
    const e = { id: this._id('l'), type: 'line', p1, p2 };
    this.entities.push(e);
    return e;
  }

  addCircle(cx, cy, r) {
    const c = this.addPoint(cx, cy);
    const e = { id: this._id('c'), type: 'circle', c: c.id, r };
    this.entities.push(e);
    return e;
  }

  addArc(cx, cy, r, startAngle, endAngle) {
    const c = this.addPoint(cx, cy);
    const e = { id: this._id('a'), type: 'arc', c: c.id, r, startAngle, endAngle };
    this.entities.push(e);
    return e;
  }

  // A connected run of vertices -> shared points + line segments. `closed` adds
  // the wrap-around segment. Returns { points, lines } (model objects, in order).
  addChain(vertices, closed, tol = 0) {
    const pts = vertices.map((v) => this.findOrAddPoint(v.x, v.y, tol));
    const lines = [];
    for (let i = 1; i < pts.length; i++) {
      if (pts[i - 1].id !== pts[i].id) lines.push(this.addLine(pts[i - 1].id, pts[i].id));
    }
    if (closed && pts.length > 2 && pts[0].id !== pts[pts.length - 1].id) {
      lines.push(this.addLine(pts[pts.length - 1].id, pts[0].id));
    }
    return { points: pts, lines };
  }

  addConstraint(c) {
    const con = { id: this._id('k'), ...c };
    this.constraints.push(con);
    return con;
  }

  removeConstraint(id) {
    this.constraints = this.constraints.filter((c) => c.id !== id);
  }

  // Remove an entity, any constraints referencing it, and any points left
  // unreferenced by other entities (plus those points' own constraints).
  removeEntity(id) {
    const ent = this.entity(id);
    if (!ent) return;
    this.entities = this.entities.filter((e) => e.id !== id);
    this.constraints = this.constraints.filter((c) => !this._refsEntity(c, ent));
    const used = new Set();
    this.entities.forEach((e) => this._entityPointIds(e).forEach((pid) => used.add(pid)));
    const dropped = this.points.filter((p) => !used.has(p.id)).map((p) => p.id);
    if (dropped.length) {
      this.points = this.points.filter((p) => used.has(p.id));
      this.constraints = this.constraints.filter(
        (c) => !dropped.includes(c.point) && !dropped.includes(c.p1) && !dropped.includes(c.p2)
      );
    }
  }

  _entityPointIds(e) {
    return e.type === 'line' ? [e.p1, e.p2] : [e.c];
  }

  _refsEntity(c, ent) {
    const eid = ent.id;
    if (c.line === eid || c.a === eid || c.b === eid || c.circle === eid) return true;
    // Constraints on the entity's own points fall away only if the point does
    // (handled by the unreferenced-point sweep in removeEntity).
    return false;
  }

  // Merge point `dropId` into `keepId` (coincidence by sharing). Every entity
  // and constraint reference is rewritten; degenerate results (a line whose two
  // ends became the same point, duplicate constraints) are dropped.
  mergePoints(keepId, dropId) {
    if (keepId === dropId || !this.point(keepId) || !this.point(dropId)) return false;
    this.points = this.points.filter((p) => p.id !== dropId);
    this.entities.forEach((e) => {
      if (e.p1 === dropId) e.p1 = keepId;
      if (e.p2 === dropId) e.p2 = keepId;
      if (e.c === dropId) e.c = keepId;
    });
    this.entities = this.entities.filter((e) => !(e.type === 'line' && e.p1 === e.p2));
    this.constraints.forEach((c) => {
      if (c.point === dropId) c.point = keepId;
      if (c.p1 === dropId) c.p1 = keepId;
      if (c.p2 === dropId) c.p2 = keepId;
    });
    this.constraints = this.constraints.filter(
      (c) => !(c.type === 'distance' && c.p1 === c.p2)
    );
    // Sweep entities whose ids vanished (a collapsed line) out of constraints.
    const ids = new Set(this.entities.map((e) => e.id));
    this.constraints = this.constraints.filter((c) => {
      for (const key of ['line', 'a', 'b', 'circle']) {
        if (c[key] !== undefined && !ids.has(c[key])) return false;
      }
      return true;
    });
    return true;
  }

  // Parallel-copy an existing, connected run of lines at perpendicular
  // `distance` (signed — negative flips to the other side) — the CAD "offset"
  // tool: draw a wall/panel centreline once, offset it for the other face.
  // Corners are mitred by intersecting the neighbouring offset (infinite)
  // lines, matching the true offset-polygon shape. An open chain also gets a
  // cap line closing each end, whose length is exactly the offset distance —
  // a ready-made thickness dimension target. Each new segment gets a
  // 'parallel' constraint against its source so the copy tracks later edits.
  // Returns { lines, points, caps, closed } (new model objects), or null if
  // `lineIds` isn't a single simple chain of existing lines.
  offsetChain(lineIds, distance) {
    const srcLines = lineIds.map((id) => this.entity(id));
    if (!srcLines.length || srcLines.some((l) => !l || l.type !== 'line')) return null;
    const order = orderChain(srcLines);
    if (!order) return null;
    const { pointOrder, lineOrder, closed } = order;

    const verts = pointOrder.map((id) => this.point(id));
    if (verts.some((v) => !v)) return null;
    const n = verts.length;
    const segCount = closed ? n : n - 1;
    const segNormal = [];
    for (let i = 0; i < segCount; i++) {
      segNormal.push(unitNormal(verts[i], verts[(i + 1) % n]));
    }

    const offsetPts = verts.map((v, i) => {
      const prevSeg = closed ? (i - 1 + segCount) % segCount : i - 1;
      const nextSeg = closed ? i % segCount : i;
      const hasPrev = prevSeg >= 0 && prevSeg < segCount;
      const hasNext = nextSeg >= 0 && nextSeg < segCount;
      if (hasPrev && hasNext) {
        const before = verts[(i - 1 + n) % n];
        const after = verts[(i + 1) % n];
        const pA = { x: v.x + segNormal[prevSeg].x * distance, y: v.y + segNormal[prevSeg].y * distance };
        const pB = { x: v.x + segNormal[nextSeg].x * distance, y: v.y + segNormal[nextSeg].y * distance };
        const hit = rayIntersect(
          pA, { x: v.x - before.x, y: v.y - before.y },
          pB, { x: after.x - v.x, y: after.y - v.y }
        );
        return hit || { x: (pA.x + pB.x) / 2, y: (pA.y + pB.y) / 2 };
      }
      const nrm = hasNext ? segNormal[nextSeg] : segNormal[prevSeg];
      return { x: v.x + nrm.x * distance, y: v.y + nrm.y * distance };
    });

    const { points: newPoints, lines: newLines } = this.addChain(offsetPts, closed, 0);
    lineOrder.forEach((srcId, i) => {
      this.addConstraint({ type: 'parallel', a: srcId, b: newLines[i].id });
    });

    const caps = [];
    if (!closed) {
      const capEnds = [
        [pointOrder[0], newPoints[0].id],
        [pointOrder[pointOrder.length - 1], newPoints[newPoints.length - 1].id],
      ];
      capEnds.forEach(([a, b]) => {
        if (a === b) return;
        caps.push(this.addLine(a, b));
        this.addConstraint({ type: 'distance', p1: a, p2: b, expr: String(Math.abs(distance)) });
      });
    }

    return { lines: newLines, points: newPoints, caps, closed };
  }

  // --- parameters ---

  setParam(name, expr) {
    const existing = this.params.find((p) => p.name === name);
    if (existing) existing.expr = String(expr);
    else this.params.push({ name, expr: String(expr) });
  }

  removeParam(name) {
    this.params = this.params.filter((p) => p.name !== name);
  }

  // Evaluate all parameters in order into a plain { name: value } scope.
  // A parameter whose expression fails evaluates to NaN (callers surface it).
  paramScope() {
    const scope = {};
    for (const p of this.params) {
      try {
        scope[p.name] = evaluateExpression(p.expr, scope);
      } catch (e) {
        scope[p.name] = NaN;
      }
    }
    return scope;
  }

  // Evaluate a dimension expression against the current parameter scope.
  evalDim(expr) {
    return evaluateExpression(expr, this.paramScope());
  }

  // --- queries ---

  lineLength(line) {
    const a = this.point(line.p1);
    const b = this.point(line.p2);
    return a && b ? Math.hypot(b.x - a.x, b.y - a.y) : 0;
  }

  // Degrees of freedom left: 2 per point + 1 per circle radius, minus the
  // equations the constraints contribute. Negative means over-constrained
  // (redundant/conflicting) — the solver's residual tells which.
  degreesOfFreedom() {
    const vars = this.points.length * 2 + this.radiused().length;
    let eqs = 0;
    for (const c of this.constraints) eqs += EQUATION_COUNT[c.type] || 0;
    return vars - eqs;
  }

  isEmpty() {
    return this.entities.length === 0 && this.points.length === 0;
  }

  // --- (de)serialization for board persistence and undo snapshots ---

  toJSON() {
    return {
      points: this.points.map((p) => ({ ...p })),
      entities: this.entities.map((e) => ({ ...e })),
      constraints: this.constraints.map((c) => ({ ...c })),
      params: this.params.map((p) => ({ ...p })),
      nextId: this._nextId,
    };
  }

  static fromJSON(data) {
    const s = new Sketch();
    if (!data || typeof data !== 'object') return s;
    s.points = (data.points || []).map((p) => ({ ...p }));
    s.entities = (data.entities || []).map((e) => ({ ...e }));
    s.constraints = (data.constraints || []).map((c) => ({ ...c }));
    s.params = (data.params || []).map((p) => ({ ...p }));
    s._nextId = data.nextId || 1;
    return s;
  }
}
