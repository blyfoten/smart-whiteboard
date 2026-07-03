// Plain-Node sanity tests for the pure stroke classifier (no test framework).
// Run: node test/shape-classifier.test.mjs
import assert from 'node:assert';
import { classifyStroke } from '../src/shape-classifier.js';

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

// ---- synthetic stroke generators (with a little jitter) ----
const jitter = (v, amt = 2) => v + (Math.random() - 0.5) * amt;

function line(a, b, n = 30) {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = i / n;
    return { x: jitter(a.x + (b.x - a.x) * t), y: jitter(a.y + (b.y - a.y) * t) };
  });
}

function ellipsePts(cx, cy, rx, ry, n = 60) {
  return Array.from({ length: n + 1 }, (_, i) => {
    const θ = (i / n) * 2 * Math.PI;
    return { x: jitter(cx + rx * Math.cos(θ)), y: jitter(cy + ry * Math.sin(θ)) };
  });
}

function rectPts(x, y, w, h, per = 15) {
  const corners = [
    [x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y],
  ].map(([px, py]) => ({ x: px, y: py }));
  const pts = [];
  for (let i = 0; i < corners.length - 1; i++) {
    pts.push(...line(corners[i], corners[i + 1], per));
  }
  return pts;
}

function arrowPts(a, b) {
  const shaft = line(a, b, 30);
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const headLen = 22;
  const θ = (28 * Math.PI) / 180;
  const h1 = { x: b.x - headLen * Math.cos(angle - θ), y: b.y - headLen * Math.sin(angle - θ) };
  return [...shaft, ...line(b, h1, 8)];
}

// A rectangle with shaky (not perfectly straight) sides — an unsteady hand on a
// touchscreen. The wobble oscillates along each side so it nets ~zero area
// change, the way real shaky-but-straight strokes do.
function wobblyRectPts(x, y, w, h, per = 22, bow = 9) {
  const corners = [
    [x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y],
  ].map(([px, py]) => ({ x: px, y: py }));
  const pts = [];
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    const nx = -dy / len, ny = dx / len; // perpendicular
    for (let j = 0; j <= per; j++) {
      const t = j / per;
      const off = Math.sin(t * Math.PI * 4) * bow; // oscillating wobble (net ~0)
      pts.push({ x: jitter(a.x + dx * t + nx * off, 4), y: jitter(a.y + dy * t + ny * off, 4) });
    }
  }
  return pts;
}

// A closed heart outline (classic parametric heart), scaled & centered.
function heartPts(cx, cy, scale, n = 80) {
  return Array.from({ length: n + 1 }, (_, i) => {
    const t = (i / n) * 2 * Math.PI;
    const x = 16 * Math.sin(t) ** 3;
    const y = 13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t);
    return { x: jitter(cx + x * scale), y: jitter(cy - y * scale) };
  });
}

// A closed triangle.
function trianglePts(cx, cy, r, per = 24) {
  const v = [0, 1, 2, 0].map((k) => ({
    x: cx + r * Math.cos((k * 2 * Math.PI) / 3 - Math.PI / 2),
    y: cy + r * Math.sin((k * 2 * Math.PI) / 3 - Math.PI / 2),
  }));
  const pts = [];
  for (let i = 0; i < 3; i++) pts.push(...line(v[i], v[i + 1], per));
  return pts;
}

// ---- tests ----
check('horizontal line → line', () => {
  const d = classifyStroke(line({ x: 40, y: 100 }, { x: 360, y: 108 }));
  assert.equal(d?.type, 'line');
});

check('diagonal line → line', () => {
  const d = classifyStroke(line({ x: 50, y: 60 }, { x: 300, y: 320 }));
  assert.equal(d?.type, 'line');
});

check('circle → circle', () => {
  const d = classifyStroke(ellipsePts(200, 200, 90, 90));
  assert.equal(d?.type, 'circle');
});

check('wide ellipse → ellipse', () => {
  const d = classifyStroke(ellipsePts(200, 200, 140, 70));
  assert.equal(d?.type, 'ellipse');
});

check('rectangle → rect', () => {
  const d = classifyStroke(rectPts(60, 60, 240, 140));
  assert.equal(d?.type, 'rect');
});

check('wobbly-sided rectangle → rect (not oval)', () => {
  const d = classifyStroke(wobblyRectPts(60, 60, 240, 150));
  assert.equal(d?.type, 'rect');
});

check('small square with shaky sides → rect', () => {
  const d = classifyStroke(wobblyRectPts(100, 100, 110, 95, 16, 7));
  assert.equal(d?.type, 'rect');
});

check('heart → not a rect (stays ink)', () => {
  const d = classifyStroke(heartPts(200, 200, 9));
  assert.notEqual(d?.type, 'rect');
});

check('triangle → polygon', () => {
  const d = classifyStroke(trianglePts(200, 200, 120));
  assert.equal(d?.type, 'polygon');
  assert.equal(d.points.length, 3);
});

check('closed notched (L) outline → polygon', () => {
  // A rectangle with a bite taken out of one corner (6 vertices), closed.
  const c = [
    { x: 60, y: 60 }, { x: 260, y: 60 }, { x: 260, y: 160 },
    { x: 160, y: 160 }, { x: 160, y: 260 }, { x: 60, y: 260 }, { x: 60, y: 60 },
  ];
  const pts = [];
  for (let i = 0; i < c.length - 1; i++) pts.push(...line(c[i], c[i + 1], 18));
  const d = classifyStroke(pts);
  assert.equal(d?.type, 'polygon');
  assert.ok(d.points.length >= 5 && d.points.length <= 7);
});

check('circle stays circle (not polygon)', () => {
  assert.equal(classifyStroke(ellipsePts(200, 200, 90, 90))?.type, 'circle');
});

check('clean rectangle stays rect (not polygon)', () => {
  assert.equal(classifyStroke(rectPts(60, 60, 240, 140))?.type, 'rect');
});

check('arrow → arrow', () => {
  const d = classifyStroke(arrowPts({ x: 60, y: 200 }, { x: 320, y: 200 }));
  assert.equal(d?.type, 'arrow');
});

check('L-shape → polyline (3 vertices)', () => {
  const pts = [
    ...line({ x: 80, y: 60 }, { x: 80, y: 260 }, 30),
    ...line({ x: 80, y: 260 }, { x: 300, y: 260 }, 30),
  ];
  const d = classifyStroke(pts);
  assert.equal(d?.type, 'polyline');
  assert.equal(d.points.length, 3);
});

check('staircase → polyline (multiple segments)', () => {
  const pts = [
    ...line({ x: 60, y: 60 }, { x: 160, y: 60 }, 20),
    ...line({ x: 160, y: 60 }, { x: 160, y: 160 }, 20),
    ...line({ x: 160, y: 160 }, { x: 260, y: 160 }, 20),
  ];
  const d = classifyStroke(pts);
  assert.equal(d?.type, 'polyline');
  assert.ok(d.points.length >= 4);
});

check('3-step staircase (alternating) → polyline', () => {
  const corners = [
    { x: 60, y: 60 }, { x: 160, y: 60 }, { x: 160, y: 160 }, { x: 260, y: 160 },
    { x: 260, y: 260 }, { x: 360, y: 260 },
  ];
  const pts = [];
  for (let i = 0; i < corners.length - 1; i++) pts.push(...line(corners[i], corners[i + 1], 20));
  const d = classifyStroke(pts);
  assert.equal(d?.type, 'polyline');
});

check('U-shape → polyline (4 vertices)', () => {
  const pts = [
    ...line({ x: 80, y: 60 }, { x: 80, y: 260 }, 25),
    ...line({ x: 80, y: 260 }, { x: 280, y: 260 }, 25),
    ...line({ x: 280, y: 260 }, { x: 280, y: 60 }, 25),
  ];
  const d = classifyStroke(pts);
  assert.equal(d?.type, 'polyline');
  assert.equal(d.points.length, 4);
});

check('L with a bowed segment → still polyline', () => {
  // Vertical leg, then a horizontal leg that bows (hand-drawn) — the bow must
  // not get rejected; it should merge out, leaving the one real corner.
  const horiz = Array.from({ length: 41 }, (_, i) => {
    const t = i / 40;
    return { x: jitter(80 + 220 * t), y: jitter(260 + Math.sin(t * Math.PI) * 14) };
  });
  const pts = [...line({ x: 80, y: 60 }, { x: 80, y: 260 }, 25), ...horiz];
  const d = classifyStroke(pts);
  assert.equal(d?.type, 'polyline');
});

check('straight line stays line (not polyline)', () => {
  const d = classifyStroke(line({ x: 40, y: 100 }, { x: 360, y: 108 }));
  assert.equal(d?.type, 'line');
});

check('slightly-bent line → line (not split into segments)', () => {
  const pts = [
    ...line({ x: 50, y: 100 }, { x: 230, y: 116 }, 20),
    ...line({ x: 230, y: 116 }, { x: 410, y: 104 }, 20),
  ];
  const d = classifyStroke(pts);
  assert.equal(d?.type, 'line');
});

check('near-horizontal line snaps to horizontal', () => {
  const d = classifyStroke(line({ x: 40, y: 100 }, { x: 360, y: 122 }));
  assert.equal(d?.type, 'line');
  assert.equal(d.a.y, d.b.y); // snapped flat
});

check('near-vertical line snaps to vertical', () => {
  const d = classifyStroke(line({ x: 100, y: 40 }, { x: 118, y: 340 }));
  assert.equal(d?.type, 'line');
  assert.equal(d.a.x, d.b.x); // snapped upright
});

check('smooth open arc → null (not polyline)', () => {
  // A half-circle arc: gentle, continuous bend — must NOT straighten to segments.
  // Low jitter keeps it an unambiguous curve (all turns one direction).
  const pts = Array.from({ length: 41 }, (_, i) => {
    const t = (i / 40) * Math.PI;
    return { x: jitter(200 + 120 * Math.cos(t), 0.8), y: jitter(200 + 120 * Math.sin(t), 0.8) };
  });
  assert.equal(classifyStroke(pts), null);
});

check('tiny stroke → null (stays ink)', () => {
  const d = classifyStroke(line({ x: 100, y: 100 }, { x: 110, y: 104 }));
  assert.equal(d, null);
});

check('scribble / handwriting → null (stays ink)', () => {
  // A messy zig-zag that is neither straight, closed, nor a clean primitive.
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    pts.push({ x: 80 + i * 4, y: 150 + Math.sin(i * 1.7) * 35 + (Math.random() - 0.5) * 20 });
  }
  assert.equal(classifyStroke(pts), null);
});

check('L-polyline ending in an arrowhead → polyline + arrowEnd', () => {
  // Right, then down, then a small V head drawn back up-left then up-right.
  const a = { x: 100, y: 100 };
  const b = { x: 280, y: 100 };
  const c = { x: 280, y: 260 }; // tip
  const w1 = { x: 262, y: 235 };
  const w2 = { x: 297, y: 236 };
  const pts = [...line(a, b, 25), ...line(b, c, 25), ...line(c, w1, 6), ...line(w1, c, 6), ...line(c, w2, 6)];
  const d = classifyStroke(pts);
  assert.equal(d?.type, 'polyline');
  assert.equal(d.arrowEnd, true);
  // Head stripped: the shaft keeps just its 3 corner vertices.
  assert.equal(d.points.length, 3);
});

check('straight stroke with one-wing head → arrow-ended line', () => {
  const a = { x: 100, y: 300 };
  const tip = { x: 330, y: 300 };
  const w = { x: 305, y: 282 };
  const pts = [...line(a, tip, 30), ...line(tip, w, 7)];
  const d = classifyStroke(pts);
  // Either the dedicated straight-arrow detector or the polyline path may
  // catch this — both must mark it as an arrow.
  assert.ok(d?.type === 'arrow' || (d?.type === 'line' && d.arrowEnd === true), `got ${JSON.stringify(d)}`);
});

check('plain L-polyline has no arrowEnd', () => {
  const pts = [
    ...line({ x: 100, y: 100 }, { x: 280, y: 100 }, 25),
    ...line({ x: 280, y: 100 }, { x: 280, y: 260 }, 25),
  ];
  const d = classifyStroke(pts);
  assert.equal(d?.type, 'polyline');
  assert.ok(!d.arrowEnd);
});

console.log(`\n${passed} checks passed.`);
