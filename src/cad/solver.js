// src/cad/solver.js — numeric 2D geometric constraint solver (no Fabric/DOM).
//
// SolveSpace-style: pack every point coordinate and circle radius into a
// variable vector, express each constraint as one or two scalar residuals, and
// drive the residuals to zero with damped Gauss–Newton (Levenberg–Marquardt)
// least squares, using a finite-difference Jacobian. Sketches here are small
// (tens of variables), so the dense normal-equations solve is plenty fast.
//
// Under-constrained sketches are the normal case: a weak "prior" residual pulls
// every variable toward its current value, so the solver picks the solution
// closest to what's on screen instead of wandering. A dragged point enters as a
// medium-weight target ("pin"): constraints win over the drag, the drag wins
// over the prior — so dragging feels direct but can never break a constraint.

const WEIGHT = {
  constraint: 1,
  fix: 10,       // fixed points hold firm against everything but real conflicts
  drag: 0.05,    // the dragged point follows the cursor where the sketch allows
  prior: 0.001,  // "stay where you are" regularization for free directions
};

// Angle-ish residuals (parallel/perpendicular/angle) are dimensionless; scale
// them into pixel-ish units so one Jacobian conditioning fits all constraints.
const K_ANG = 100;

const MIN_RADIUS = 1;

// Build the solver's view of a sketch: variable vector + residual closures.
function buildSystem(sketch, pins, dimValues) {
  const varIndex = new Map(); // 'px:<id>' | 'py:<id>' | 'r:<id>' -> index
  const x0 = [];
  const addVar = (key, value) => {
    varIndex.set(key, x0.length);
    x0.push(value);
  };
  for (const p of sketch.points) {
    addVar(`px:${p.id}`, p.x);
    addVar(`py:${p.id}`, p.y);
  }
  for (const c of sketch.circles()) addVar(`r:${c.id}`, c.r);

  const ix = (key) => varIndex.get(key);
  const px = (x, id) => x[ix(`px:${id}`)];
  const py = (x, id) => x[ix(`py:${id}`)];
  const rad = (x, id) => x[ix(`r:${id}`)];
  const lineOf = (id) => sketch.entity(id);

  // Each residual: { f(x) -> number, w: weight }
  const residuals = [];
  const add = (f, w) => residuals.push({ f, w });

  const dir = (x, l) => ({ dx: px(x, l.p2) - px(x, l.p1), dy: py(x, l.p2) - py(x, l.p1) });
  const unitCross = (x, la, lb) => {
    const a = dir(x, la);
    const b = dir(x, lb);
    const den = Math.hypot(a.dx, a.dy) * Math.hypot(b.dx, b.dy) || 1e-9;
    return (a.dx * b.dy - a.dy * b.dx) / den;
  };
  const unitDot = (x, la, lb) => {
    const a = dir(x, la);
    const b = dir(x, lb);
    const den = Math.hypot(a.dx, a.dy) * Math.hypot(b.dx, b.dy) || 1e-9;
    return (a.dx * b.dx + a.dy * b.dy) / den;
  };

  for (const c of sketch.constraints) {
    switch (c.type) {
      case 'horizontal': {
        const l = lineOf(c.line);
        if (l) add((x) => py(x, l.p2) - py(x, l.p1), WEIGHT.constraint);
        break;
      }
      case 'vertical': {
        const l = lineOf(c.line);
        if (l) add((x) => px(x, l.p2) - px(x, l.p1), WEIGHT.constraint);
        break;
      }
      case 'parallel': {
        const la = lineOf(c.a);
        const lb = lineOf(c.b);
        if (la && lb) add((x) => unitCross(x, la, lb) * K_ANG, WEIGHT.constraint);
        break;
      }
      case 'perpendicular': {
        const la = lineOf(c.a);
        const lb = lineOf(c.b);
        if (la && lb) add((x) => unitDot(x, la, lb) * K_ANG, WEIGHT.constraint);
        break;
      }
      case 'equal': {
        const ea = lineOf(c.a);
        const eb = lineOf(c.b);
        if (ea && eb && ea.type === 'line' && eb.type === 'line') {
          add((x) => {
            const a = dir(x, ea);
            const b = dir(x, eb);
            return Math.hypot(a.dx, a.dy) - Math.hypot(b.dx, b.dy);
          }, WEIGHT.constraint);
        } else if (ea && eb && ea.type === 'circle' && eb.type === 'circle') {
          add((x) => rad(x, ea.id) - rad(x, eb.id), WEIGHT.constraint);
        }
        break;
      }
      case 'pointOnLine': {
        const l = lineOf(c.line);
        if (l && sketch.point(c.point)) {
          add((x) => {
            const d = dir(x, l);
            const len = Math.hypot(d.dx, d.dy) || 1e-9;
            const vx = px(x, c.point) - px(x, l.p1);
            const vy = py(x, c.point) - py(x, l.p1);
            return (vx * d.dy - vy * d.dx) / len; // perpendicular distance (px)
          }, WEIGHT.constraint);
        }
        break;
      }
      case 'fix': {
        if (sketch.point(c.point)) {
          add((x) => px(x, c.point) - c.x, WEIGHT.fix);
          add((x) => py(x, c.point) - c.y, WEIGHT.fix);
        }
        break;
      }
      case 'distance': {
        const v = dimValues.get(c.id);
        if (sketch.point(c.p1) && sketch.point(c.p2) && Number.isFinite(v)) {
          add((x) => Math.hypot(px(x, c.p2) - px(x, c.p1), py(x, c.p2) - py(x, c.p1)) - v,
            WEIGHT.constraint);
        }
        break;
      }
      case 'radius': {
        const v = dimValues.get(c.id);
        const circ = lineOf(c.circle);
        if (circ && Number.isFinite(v)) {
          add((x) => rad(x, circ.id) - v, WEIGHT.constraint);
        }
        break;
      }
      case 'angle': {
        const v = dimValues.get(c.id);
        const la = lineOf(c.a);
        const lb = lineOf(c.b);
        if (la && lb && Number.isFinite(v)) {
          const target = (v * Math.PI) / 180;
          add((x) => (Math.atan2(unitCross(x, la, lb), unitDot(x, la, lb)) - target) * K_ANG,
            WEIGHT.constraint);
        }
        break;
      }
      default:
        break;
    }
  }

  // The residual count that measures constraint satisfaction (before pins/priors
  // are appended) — used for the reported maxResidual.
  const hardCount = residuals.length;

  for (const [pointId, target] of pins) {
    if (!sketch.point(pointId)) continue;
    add((x) => px(x, pointId) - target.x, WEIGHT.drag);
    add((x) => py(x, pointId) - target.y, WEIGHT.drag);
  }

  for (let i = 0; i < x0.length; i++) {
    const start = x0[i];
    add((x) => x[i] - start, WEIGHT.prior);
  }

  return { x0, residuals, hardCount, varIndex };
}

function evalResiduals(residuals, x) {
  const r = new Array(residuals.length);
  for (let i = 0; i < residuals.length; i++) r[i] = residuals[i].f(x) * residuals[i].w;
  return r;
}

function normSq(v) {
  let s = 0;
  for (const a of v) s += a * a;
  return s;
}

// Solve (A + lambda*I) d = b in place; A is n×n dense. Returns d or null.
function solveLinear(A, b, lambda) {
  const n = b.length;
  const M = A.map((row, i) => {
    const r = row.slice();
    r[i] += lambda + 1e-12;
    return r;
  });
  const y = b.slice();
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(M[row][col]) > Math.abs(M[piv][col])) piv = row;
    }
    if (Math.abs(M[piv][col]) < 1e-14) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    [y[col], y[piv]] = [y[piv], y[col]];
    for (let row = col + 1; row < n; row++) {
      const f = M[row][col] / M[col][col];
      for (let k = col; k < n; k++) M[row][k] -= f * M[col][k];
      y[row] -= f * y[col];
    }
  }
  const d = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let s = y[row];
    for (let k = row + 1; k < n; k++) s -= M[row][k] * d[k];
    d[row] = s / M[row][row];
  }
  return d;
}

// One damped Gauss–Newton run from the sketch's current state; writes the
// solution back into the sketch and reports the worst hard-constraint residual.
function runGaussNewton(sketch, pins, dimValues) {
  const { x0, residuals, hardCount, varIndex } = buildSystem(sketch, pins, dimValues);
  const n = x0.length;
  if (n === 0) return { ok: true, maxResidual: 0, iterations: 0 };

  let x = x0.slice();
  let lambda = 1e-3;
  const MAX_ITER = 80;
  const TOL = 1e-8;
  let iter = 0;
  let r = evalResiduals(residuals, x);
  let cost = normSq(r);

  for (iter = 0; iter < MAX_ITER; iter++) {
    if (cost < TOL) break;

    // Finite-difference Jacobian (m×n), then normal equations JtJ d = -Jt r.
    const m = residuals.length;
    const J = [];
    const h = 1e-5;
    for (let j = 0; j < m; j++) J.push(new Array(n).fill(0));
    for (let col = 0; col < n; col++) {
      const saved = x[col];
      x[col] = saved + h;
      const rp = evalResiduals(residuals, x);
      x[col] = saved;
      for (let j = 0; j < m; j++) J[j][col] = (rp[j] - r[j]) / h;
    }
    const JtJ = [];
    const Jtr = new Array(n).fill(0);
    for (let a = 0; a < n; a++) {
      JtJ.push(new Array(n).fill(0));
      for (let b = a; b < n; b++) {
        let s = 0;
        for (let j = 0; j < m; j++) s += J[j][a] * J[j][b];
        JtJ[a][b] = s;
      }
      for (let j = 0; j < m; j++) Jtr[a] += J[j][a] * r[j];
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) JtJ[a][b] = JtJ[b][a];

    // Levenberg step with simple damping adaptation.
    let stepped = false;
    for (let tries = 0; tries < 8; tries++) {
      const d = solveLinear(JtJ, Jtr.map((v) => -v), lambda);
      if (d) {
        const xNew = x.map((v, i2) => v + d[i2]);
        const rNew = evalResiduals(residuals, xNew);
        const costNew = normSq(rNew);
        if (costNew < cost) {
          x = xNew;
          r = rNew;
          cost = costNew;
          lambda = Math.max(1e-9, lambda / 3);
          stepped = true;
          break;
        }
      }
      lambda *= 10;
    }
    if (!stepped) break; // stuck (conflict or numerical corner) — report as-is
  }

  // Write the solution back into the sketch.
  for (const p of sketch.points) {
    p.x = x[varIndex.get(`px:${p.id}`)];
    p.y = x[varIndex.get(`py:${p.id}`)];
  }
  for (const c of sketch.circles()) {
    c.r = Math.max(MIN_RADIUS, x[varIndex.get(`r:${c.id}`)]);
  }

  // Convergence is judged on the hard constraints only (not pins/priors).
  let maxResidual = 0;
  for (let j = 0; j < hardCount; j++) {
    maxResidual = Math.max(maxResidual, Math.abs(residuals[j].f(x)));
  }
  return { ok: maxResidual < 0.01, maxResidual, iterations: iter };
}

// solveSketch(sketch, { pins }) — mutates the sketch's point coords and circle
// radii toward a constraint-satisfying state and reports how well it converged.
//   pins: Map<pointId, {x, y}> — drag targets (medium weight, see above).
// Returns { ok, maxResidual, iterations }: `ok` means every hard constraint is
// satisfied to sub-pixel tolerance; false usually means conflicting constraints.
export function solveSketch(sketch, opts = {}) {
  const pins = opts.pins instanceof Map ? opts.pins : new Map(Object.entries(opts.pins || {}));

  // Dimension expressions are evaluated once per solve against current params.
  const dimValues = new Map();
  for (const c of sketch.constraints) {
    if (c.expr !== undefined) {
      try {
        dimValues.set(c.id, sketch.evalDim(c.expr));
      } catch (e) {
        dimValues.set(c.id, NaN); // unevaluable dimension: skipped this solve
      }
    }
  }

  let result = runGaussNewton(sketch, pins, dimValues);
  if (pins.size) {
    // A drag solve balances the pin against the constraints, leaving a tiny
    // weighted-least-squares violation. Polish with a pin-free pass (the prior
    // holds everything near the dragged solution) so constraints end exact.
    const polish = runGaussNewton(sketch, new Map(), dimValues);
    result = { ...polish, iterations: result.iterations + polish.iterations };
  }
  return result;
}
