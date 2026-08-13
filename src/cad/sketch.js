// src/cad/sketch.js — the parametric 2D sketch model (no Fabric, no DOM).
//
// A Sketch is the CAD-mode source of truth: points, entities that reference
// them (lines by endpoint ids, circles by a centre id + radius), constraints,
// and named parameters. Fabric objects in cad-mode.js are just a rendering of
// this model; the solver (solver.js) mutates point coords / radii to satisfy
// the constraints. Kept pure so it can be unit-tested in Node.
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
    const vars = this.points.length * 2 + this.circles().length;
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
