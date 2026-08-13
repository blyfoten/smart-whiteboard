// Plain-Node sanity tests for the pure CAD core: expression evaluator, sketch
// model, and constraint solver. No test framework.
// Run: node test/cad-core.test.mjs
import assert from 'node:assert';
import { evaluateExpression } from '../src/cad/expr.js';
import { Sketch } from '../src/cad/sketch.js';
import { solveSketch } from '../src/cad/solver.js';

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`FAIL  ${name}\n      ${err.message}`);
    process.exitCode = 1;
  }
}

const near = (a, b, tol = 1e-3) =>
  assert.ok(Math.abs(a - b) <= tol, `expected ${a} ≈ ${b} (±${tol})`);

// ---- expression evaluator ----

check('expr: arithmetic & precedence', () => {
  near(evaluateExpression('1 + 2 * 3'), 7);
  near(evaluateExpression('(1 + 2) * 3'), 9);
  near(evaluateExpression('10 / 4'), 2.5);
  near(evaluateExpression('2 ^ 3 ^ 2'), 512); // right-assoc
  near(evaluateExpression('-2 ^ 2'), -4);
  near(evaluateExpression('-3 + 5'), 2);
});

check('expr: params, constants & functions', () => {
  near(evaluateExpression('w / 2 + 5', { w: 100 }), 55);
  near(evaluateExpression('2 * pi'), 2 * Math.PI);
  near(evaluateExpression('sqrt(16)'), 4);
  near(evaluateExpression('max(3, 7)'), 7);
  near(evaluateExpression('min(3, 7, 1)'), 1);
});

check('expr: errors are thrown', () => {
  assert.throws(() => evaluateExpression('nope + 1'), /Unknown parameter/);
  assert.throws(() => evaluateExpression('2 +'), /expression/);
  assert.throws(() => evaluateExpression('2 3'), /trailing/);
  assert.throws(() => evaluateExpression('1 / 0 * 0'), /finite/); // Infinity*0 = NaN
  assert.throws(() => evaluateExpression('bogus(2)'), /Unknown function/);
});

// ---- sketch model ----

check('sketch: chain shares points and closes', () => {
  const s = new Sketch();
  const { points, lines } = s.addChain(
    [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }], true
  );
  assert.equal(points.length, 3);
  assert.equal(lines.length, 3); // closed triangle
  assert.equal(s.points.length, 3);
  // consecutive lines share their corner point
  assert.equal(lines[0].p2, lines[1].p1);
  assert.equal(lines[2].p2, lines[0].p1);
});

check('sketch: findOrAddPoint snaps to nearby existing point', () => {
  const s = new Sketch();
  const a = s.addPoint(10, 10);
  const b = s.findOrAddPoint(12, 11, 5);
  assert.equal(a.id, b.id);
  const c = s.findOrAddPoint(30, 30, 5);
  assert.notEqual(a.id, c.id);
});

check('sketch: mergePoints rewrites refs and drops degenerate lines', () => {
  const s = new Sketch();
  const p1 = s.addPoint(0, 0);
  const p2 = s.addPoint(100, 0);
  const p3 = s.addPoint(101, 1);
  const l1 = s.addLine(p1.id, p2.id);
  const l2 = s.addLine(p2.id, p3.id); // will collapse when p3 merges into p2
  s.addConstraint({ type: 'horizontal', line: l2.id });
  s.mergePoints(p2.id, p3.id);
  assert.equal(s.points.length, 2);
  assert.equal(s.entities.length, 1);
  assert.equal(s.entities[0].id, l1.id);
  // the constraint on the collapsed line is swept away
  assert.equal(s.constraints.length, 0);
});

check('sketch: removeEntity garbage-collects points and constraints', () => {
  const s = new Sketch();
  const { lines } = s.addChain([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }], false);
  s.addConstraint({ type: 'horizontal', line: lines[0].id });
  s.removeEntity(lines[0].id);
  assert.equal(s.entities.length, 1);
  assert.equal(s.points.length, 2); // the shared corner stays, the free end goes
  assert.equal(s.constraints.length, 0);
});

check('sketch: params evaluate in order, round-trips via JSON', () => {
  const s = new Sketch();
  s.setParam('w', '100');
  s.setParam('h', 'w / 2');
  const scope = s.paramScope();
  near(scope.h, 50);
  s.addCircle(10, 10, 30);
  const s2 = Sketch.fromJSON(JSON.parse(JSON.stringify(s.toJSON())));
  near(s2.paramScope().h, 50);
  assert.equal(s2.circles().length, 1);
  // ids keep incrementing without collision after a round-trip
  const p = s2.addPoint(0, 0);
  assert.ok(!s2.points.filter((q) => q !== p).some((q) => q.id === p.id));
});

// ---- solver ----

check('solver: horizontal + vertical square out an L', () => {
  const s = new Sketch();
  const { lines } = s.addChain(
    [{ x: 0, y: 0 }, { x: 100, y: 4 }, { x: 104, y: 100 }], false
  );
  s.addConstraint({ type: 'horizontal', line: lines[0].id });
  s.addConstraint({ type: 'vertical', line: lines[1].id });
  const res = solveSketch(s);
  assert.ok(res.ok, `residual ${res.maxResidual}`);
  const [a, b, c] = s.points;
  near(a.y, b.y, 1e-2);
  near(b.x, c.x, 1e-2);
});

check('solver: distance dimension resizes a line', () => {
  const s = new Sketch();
  const a = s.addPoint(0, 0);
  const b = s.addPoint(80, 0);
  s.addLine(a.id, b.id);
  s.addConstraint({ type: 'fix', point: a.id, x: 0, y: 0 });
  s.addConstraint({ type: 'distance', p1: a.id, p2: b.id, expr: '150' });
  const res = solveSketch(s);
  assert.ok(res.ok, `residual ${res.maxResidual}`);
  near(Math.hypot(b.x - a.x, b.y - a.y), 150, 0.05);
  near(a.x, 0, 0.05);
  near(a.y, 0, 0.05);
});

check('solver: dimension driven by a parameter expression', () => {
  const s = new Sketch();
  s.setParam('w', '200');
  const a = s.addPoint(0, 0);
  const b = s.addPoint(80, 0);
  s.addLine(a.id, b.id);
  s.addConstraint({ type: 'distance', p1: a.id, p2: b.id, expr: 'w / 2' });
  const res = solveSketch(s);
  assert.ok(res.ok, `residual ${res.maxResidual}`);
  near(Math.hypot(b.x - a.x, b.y - a.y), 100, 0.05);
});

check('solver: rectangle with H/V + dims solves to spec', () => {
  const s = new Sketch();
  const { lines } = s.addChain(
    [{ x: 0, y: 0 }, { x: 90, y: 3 }, { x: 93, y: 62 }, { x: -2, y: 60 }], true
  );
  s.addConstraint({ type: 'horizontal', line: lines[0].id });
  s.addConstraint({ type: 'vertical', line: lines[1].id });
  s.addConstraint({ type: 'horizontal', line: lines[2].id });
  s.addConstraint({ type: 'vertical', line: lines[3].id });
  s.addConstraint({ type: 'distance', p1: lines[0].p1, p2: lines[0].p2, expr: '120' });
  s.addConstraint({ type: 'distance', p1: lines[1].p1, p2: lines[1].p2, expr: '60' });
  const res = solveSketch(s);
  assert.ok(res.ok, `residual ${res.maxResidual}`);
  const w = Math.abs(s.point(lines[0].p2).x - s.point(lines[0].p1).x);
  const h = Math.abs(s.point(lines[1].p2).y - s.point(lines[1].p1).y);
  near(w, 120, 0.05);
  near(h, 60, 0.05);
});

check('solver: perpendicular + parallel + equal', () => {
  const s = new Sketch();
  const { lines } = s.addChain(
    [{ x: 0, y: 0 }, { x: 100, y: 10 }, { x: 110, y: 100 }, { x: 5, y: 95 }], false
  );
  s.addConstraint({ type: 'perpendicular', a: lines[0].id, b: lines[1].id });
  s.addConstraint({ type: 'parallel', a: lines[0].id, b: lines[2].id });
  s.addConstraint({ type: 'equal', a: lines[0].id, b: lines[2].id });
  const res = solveSketch(s);
  assert.ok(res.ok, `residual ${res.maxResidual}`);
  const d = (l) => {
    const p1 = s.point(l.p1), p2 = s.point(l.p2);
    return { x: p2.x - p1.x, y: p2.y - p1.y };
  };
  const d0 = d(lines[0]), d1 = d(lines[1]), d2 = d(lines[2]);
  near(d0.x * d1.x + d0.y * d1.y, 0, 0.5); // ⟂
  near(d0.x * d2.y - d0.y * d2.x, 0, 0.5); // ∥
  near(Math.hypot(d0.x, d0.y), Math.hypot(d2.x, d2.y), 0.05); // =
});

check('solver: radius dimension + equal circles', () => {
  const s = new Sketch();
  const c1 = s.addCircle(0, 0, 40);
  const c2 = s.addCircle(200, 0, 70);
  s.addConstraint({ type: 'radius', circle: c1.id, expr: '25' });
  s.addConstraint({ type: 'equal', a: c1.id, b: c2.id });
  const res = solveSketch(s);
  assert.ok(res.ok, `residual ${res.maxResidual}`);
  near(c1.r, 25, 0.05);
  near(c2.r, 25, 0.05);
});

check('solver: drag pin follows cursor but constraints win', () => {
  const s = new Sketch();
  const a = s.addPoint(0, 0);
  const b = s.addPoint(100, 0);
  const l = s.addLine(a.id, b.id);
  s.addConstraint({ type: 'fix', point: a.id, x: 0, y: 0 });
  s.addConstraint({ type: 'horizontal', line: l.id });
  // Drag b diagonally: x should follow, y must stay on the horizontal.
  const res = solveSketch(s, { pins: new Map([[b.id, { x: 150, y: 80 }]]) });
  assert.ok(res.ok, `residual ${res.maxResidual}`);
  near(b.x, 150, 1);
  near(b.y, 0, 0.05);
  near(a.x, 0, 0.05);
});

check('solver: angle dimension between two lines', () => {
  const s = new Sketch();
  const { lines } = s.addChain(
    [{ x: 100, y: 0 }, { x: 0, y: 0 }, { x: 100, y: 60 }], false
  );
  s.addConstraint({ type: 'fix', point: lines[0].p1, x: 100, y: 0 });
  s.addConstraint({ type: 'fix', point: lines[0].p2, x: 0, y: 0 });
  s.addConstraint({ type: 'angle', a: lines[0].id, b: lines[1].id, expr: '45' });
  const res = solveSketch(s);
  assert.ok(res.ok, `residual ${res.maxResidual}`);
  // The constraint fixes the SIGNED angle from line a's direction to line b's.
  const d = (l) => {
    const p1 = s.point(l.p1), p2 = s.point(l.p2);
    return { x: p2.x - p1.x, y: p2.y - p1.y };
  };
  const da = d(lines[0]), db = d(lines[1]);
  const rel = Math.atan2(da.x * db.y - da.y * db.x, da.x * db.x + da.y * db.y);
  near((rel * 180) / Math.PI, 45, 0.1);
});

check('solver: conflicting constraints report not-ok', () => {
  const s = new Sketch();
  const a = s.addPoint(0, 0);
  const b = s.addPoint(100, 0);
  s.addLine(a.id, b.id);
  s.addConstraint({ type: 'fix', point: a.id, x: 0, y: 0 });
  s.addConstraint({ type: 'fix', point: b.id, x: 100, y: 0 });
  s.addConstraint({ type: 'distance', p1: a.id, p2: b.id, expr: '500' });
  const res = solveSketch(s);
  assert.equal(res.ok, false);
});

check('solver: pointOnLine pulls a point onto the line', () => {
  const s = new Sketch();
  const a = s.addPoint(0, 0);
  const b = s.addPoint(100, 100);
  const l = s.addLine(a.id, b.id);
  const p = s.addPoint(60, 20);
  const stray = s.addPoint(-40, 7); // second entity so p stays referenced
  s.addLine(p.id, stray.id);
  s.addConstraint({ type: 'fix', point: a.id, x: 0, y: 0 });
  s.addConstraint({ type: 'fix', point: b.id, x: 100, y: 100 });
  s.addConstraint({ type: 'pointOnLine', point: p.id, line: l.id });
  const res = solveSketch(s);
  assert.ok(res.ok, `residual ${res.maxResidual}`);
  near(p.x, p.y, 0.1); // on the y = x line
});

console.log(`\n${passed} checks passed${process.exitCode ? ' (with failures)' : ''}`);
