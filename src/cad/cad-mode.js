// src/cad/cad-mode.js — the CAD interaction mode: parametric sketching on the
// whiteboard, Fusion/SolveSpace-style but hand-drawn.
//
// The flow reuses the smart-shape pipeline: a freehand stroke is classified
// (shape-classifier.js), but instead of becoming a plain Fabric shape it is
// converted into sketch entities (sketch.js) — lines get shared endpoint
// points, rectangles become four constrained lines, circles a centre + radius.
// Auto-constraints are inferred (H/V from the classifier's axis snap,
// coincidence by drawing near an existing point, point-on-line by ending a
// stroke on a line). The solver (solver.js) then keeps everything consistent:
// dragging a point in Select mode, editing a dimension, or changing a
// parameter re-solves the sketch and the Fabric rendering follows.
//
// The sketch model is the source of truth; every Fabric object here is a
// disposable rendering (excludeFromExport + _noHistory), rebuilt after each
// change. Undo works on sketch snapshots pushed as composite history steps.
//
// In CAD mode the canvas stays in drawing mode: strokes sketch, while a click
// (the "stray dot" a tap leaves) selects entities/dimensions for the toolbar's
// constraint buttons. Point-dragging happens in Select mode (or held Space).

import { Line as FabricLine, Circle as FabricCircle, Path as FabricPath, FabricText } from 'fabric';
import { classifyStroke, pathToPoints, MIN_SIZE } from '../shape-classifier.js';
import { pointerSlop } from '../pointer.js';
import { Sketch } from './sketch.js';
import { solveSketch } from './solver.js';
import {
  suspend as historySuspend,
  pushComposite,
  onAfterUndo,
} from '../history.js';

const COLOR = {
  entity: '#0b7285',
  selected: '#e8590c',
  pointFill: '#ffffff',
  fixedFill: '#0b7285',
  dim: '#9c36b5',
  glyph: '#868e96',
};

const POINT_R = 4;
const HIT_POINT = 18;   // px: click-select radius for points
const HIT_EDGE = 16;    // px: click-select distance for lines/circles
const HIT_DIM = 24;     // px: click radius for dimension labels
const SNAP_MERGE = 14;  // px: endpoint drawn near an existing point merges
const SNAP_ONLINE = 10; // px: endpoint drawn near an existing line sticks to it

// Priority nudge (in normalized-distance units) for targets that are small or
// float above the geometry, so they win a near-tie against a line underneath.
const BIAS = { dim: 0.25, point: 0.35, entity: 0 };

let _canvas = null;
let _getMode = () => 'draw';
let _sketch = new Sketch();
let _selection = [];     // [{ kind: 'point'|'entity'|'dim', id }]
let _status = { ok: true, maxResidual: 0 };
let _fxObjects = [];     // every Fabric object currently rendered for the sketch
let _dragBefore = null;  // sketch snapshot at the start of a point drag
let _dragMarkers = [];   // point markers being dragged (one, or a multi-selection)
const _listeners = [];

// --- change notification (toolbar chip + panel subscribe) ---

export function onCadChanged(cb) {
  _listeners.push(cb);
}

function emitChanged() {
  _listeners.forEach((cb) => {
    try { cb(); } catch (e) { /* ignore */ }
  });
}

export function getSketch() {
  return _sketch;
}

export function getSolveStatus() {
  return _status;
}

export function getCadSelection() {
  return _selection.slice();
}

// --- solving & undo ---

function solve(pins) {
  _status = solveSketch(_sketch, pins ? { pins } : {});
  return _status;
}

// Push one undo step that restores the sketch to `beforeJSON` (and optionally
// re-adds Fabric objects, e.g. the original ink stroke of a recognition).
function pushSketchUndo(beforeJSON, extraUndo) {
  pushComposite((c) => {
    _sketch = Sketch.fromJSON(beforeJSON);
    _selection = [];
    solve();
    render();
    if (extraUndo) extraUndo(c);
    emitChanged();
  });
}

// --- rendering (model -> Fabric) ---

function baseProps(kind, id, extra) {
  return {
    _cad: { kind, id },
    _noHistory: true,
    excludeFromExport: true,
    selectable: false,
    evented: false,
    hasControls: false,
    hasBorders: false,
    objectCaching: false,
    ...extra,
  };
}

function isSelected(kind, id) {
  return _selection.some((s) => s.kind === kind && s.id === id);
}

function fmt(n) {
  return Math.abs(n - Math.round(n)) < 0.05 ? String(Math.round(n)) : n.toFixed(1);
}

// A dimension label's text: plain numbers show their value, expressions show
// "expr = value" so the parametric link stays visible on the canvas.
function dimText(c) {
  let val;
  try {
    val = _sketch.evalDim(c.expr);
  } catch (e) {
    return `${c.expr} = ?`;
  }
  const plain = /^\s*-?\d+(\.\d+)?\s*$/.test(String(c.expr));
  const prefix = c.type === 'radius' ? 'R' : '';
  const suffix = c.type === 'angle' ? '°' : '';
  if (plain) return `${prefix}${fmt(val)}${suffix}`;
  return `${c.expr} = ${prefix}${fmt(val)}${suffix}`;
}

function dimLabelPosition(c) {
  if (c.type === 'distance') {
    const a = _sketch.point(c.p1);
    const b = _sketch.point(c.p2);
    if (!a || !b) return null;
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    // Perpendicular offset so the label sits beside the measured span.
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    return { x: (a.x + b.x) / 2 + nx * 16, y: (a.y + b.y) / 2 + ny * 16 };
  }
  if (c.type === 'radius') {
    const circ = _sketch.entity(c.circle);
    const ctr = circ && _sketch.point(circ.c);
    if (!ctr) return null;
    const k = Math.SQRT1_2;
    return { x: ctr.x + circ.r * k + 10, y: ctr.y - circ.r * k - 10 };
  }
  if (c.type === 'angle') {
    const la = _sketch.entity(c.a);
    const lb = _sketch.entity(c.b);
    if (!la || !lb) return null;
    const mid = (l) => {
      const p1 = _sketch.point(l.p1);
      const p2 = _sketch.point(l.p2);
      return { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
    };
    const ma = mid(la);
    const mb = mid(lb);
    return { x: (ma.x + mb.x) / 2, y: (ma.y + mb.y) / 2 };
  }
  return null;
}

function isPointFixed(pointId) {
  return _sketch.constraints.some((c) => c.type === 'fix' && c.point === pointId);
}

// An SVG arc-path "d" string for a circular arc around (cx, cy), rendered as
// a single stroked segment (same convention as shapes.js's freehand arcs).
function arcPathD(cx, cy, r, startAngle, endAngle) {
  const x1 = cx + r * Math.cos(startAngle);
  const y1 = cy + r * Math.sin(startAngle);
  const x2 = cx + r * Math.cos(endAngle);
  const y2 = cy + r * Math.sin(endAngle);
  const sweep = endAngle - startAngle;
  const largeArc = Math.abs(sweep) > Math.PI ? 1 : 0;
  const sweepFlag = sweep > 0 ? 1 : 0;
  return `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} ${sweepFlag} ${x2} ${y2}`;
}

// Wrap `a` (radians) to (-PI, PI].
function wrapAngle(a) {
  a = a % (2 * Math.PI);
  if (a > Math.PI) a -= 2 * Math.PI;
  if (a <= -Math.PI) a += 2 * Math.PI;
  return a;
}

// Is `theta` (radians) within the arc's sweep from startAngle to endAngle,
// travelling in whichever direction that sweep actually goes?
function angleInArc(theta, startAngle, endAngle) {
  const sweep = endAngle - startAngle;
  let d = wrapAngle(theta - startAngle);
  if (sweep >= 0) {
    if (d < 0) d += 2 * Math.PI;
    return d <= sweep + 1e-6;
  }
  if (d > 0) d -= 2 * Math.PI;
  return d >= sweep - 1e-6;
}

// Small H/V letters at a constrained line's midpoint — enough feedback to see
// which segments are locked without a full constraint-glyph system.
function lineGlyphs(lineId) {
  const out = [];
  for (const c of _sketch.constraints) {
    if (c.type === 'horizontal' && c.line === lineId) out.push('H');
    if (c.type === 'vertical' && c.line === lineId) out.push('V');
  }
  return out;
}

// Build the Fabric objects rendering the whole sketch, in stacking order
// (lines and circles under markers). `skipPoints` names point markers that are
// mid-drag: Fabric owns their position during a transform, so rebuilding them
// underneath would fight the drag (and, inside a multi-selection, corrupt it).
function buildObjects(skipPoints) {
  const out = [];

  for (const e of _sketch.entities) {
    const selected = isSelected('entity', e.id);
    const stroke = selected ? COLOR.selected : COLOR.entity;
    if (e.type === 'line') {
      const a = _sketch.point(e.p1);
      const b = _sketch.point(e.p2);
      if (!a || !b) continue;
      out.push(new FabricLine([a.x, a.y, b.x, b.y], baseProps('entity', e.id, {
        stroke, strokeWidth: 2, strokeLineCap: 'round',
      })));
      const glyphs = lineGlyphs(e.id);
      if (glyphs.length) {
        out.push(new FabricText(glyphs.join(''), baseProps('glyph', e.id, {
          left: (a.x + b.x) / 2 + 6,
          top: (a.y + b.y) / 2 + 6,
          fontSize: 11,
          fontFamily: 'sans-serif',
          fill: COLOR.glyph,
        })));
      }
    } else if (e.type === 'circle') {
      const ctr = _sketch.point(e.c);
      if (!ctr) continue;
      out.push(new FabricCircle(baseProps('entity', e.id, {
        left: ctr.x, top: ctr.y, originX: 'center', originY: 'center',
        radius: Math.max(1, e.r), fill: '', stroke, strokeWidth: 2,
      })));
    } else if (e.type === 'arc') {
      const ctr = _sketch.point(e.c);
      if (!ctr) continue;
      const d = arcPathD(ctr.x, ctr.y, Math.max(1, e.r), e.startAngle, e.endAngle);
      out.push(new FabricPath(d, baseProps('entity', e.id, {
        stroke, strokeWidth: 2, fill: '', strokeLineCap: 'round',
      })));
    }
  }

  // Point markers — the only selectable CAD rendering. Dragging one (or a
  // marquee full of them) in Select mode moves the geometry via the solver.
  for (const p of _sketch.points) {
    if (skipPoints && skipPoints.has(p.id)) continue;
    const selected = isSelected('point', p.id);
    const fixed = isPointFixed(p.id);
    out.push(new FabricCircle(baseProps('point', p.id, {
      left: p.x, top: p.y, originX: 'center', originY: 'center',
      radius: selected ? POINT_R + 1.5 : POINT_R,
      fill: fixed ? COLOR.fixedFill : COLOR.pointFill,
      stroke: selected ? COLOR.selected : COLOR.entity,
      strokeWidth: 2,
      selectable: true,
      evented: true,
      hoverCursor: 'move',
    })));
  }

  // Dimension labels are derived annotations anchored to their geometry, like
  // the H/V glyphs: not selectable, so a Select-mode marquee can never scoop
  // one up and drag it away from what it measures. Edit them by tapping in CAD
  // mode, or through the CAD context menu.
  for (const c of _sketch.constraints) {
    if (c.expr === undefined) continue;
    const pos = dimLabelPosition(c);
    if (!pos) continue;
    out.push(new FabricText(dimText(c), baseProps('dim', c.id, {
      left: pos.x, top: pos.y, originX: 'center', originY: 'center',
      fontSize: 14,
      fontFamily: 'sans-serif',
      fill: isSelected('dim', c.id) ? COLOR.selected : COLOR.dim,
      backgroundColor: 'rgba(255,255,255,0.85)',
    })));
  }

  return out;
}

export function render() {
  if (!_canvas) return;
  historySuspend(() => {
    _fxObjects.forEach((o) => _canvas.remove(o));
    _fxObjects = buildObjects(null);
    _fxObjects.forEach((o) => _canvas.add(o));
  });
  _canvas.requestRenderAll();
}

// --- stroke recognition (CAD flavour) ---

// Which chain segments the classifier already snapped to an axis — those get a
// real H/V constraint so the property survives later edits. Checked BEFORE
// endpoint merging, which may move a vertex off-axis (the solver restores it).
function axisOf(a, b) {
  if (Math.abs(a.y - b.y) < 1e-6) return 'horizontal';
  if (Math.abs(a.x - b.x) < 1e-6) return 'vertical';
  return null;
}

function distToSegment(p, a, b) {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  if (!l2) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

function findLineNear(x, y, tol, excludeIds = new Set()) {
  let best = null;
  let bestD = tol;
  for (const e of _sketch.lines()) {
    if (excludeIds.has(e.id)) continue;
    const a = _sketch.point(e.p1);
    const b = _sketch.point(e.p2);
    if (!a || !b) continue;
    const d = distToSegment({ x, y }, a, b);
    if (d <= bestD) { best = e; bestD = d; }
  }
  return best;
}

// Add a recognized chain (open polyline / closed polygon / rect sides) to the
// sketch: shared corner points, per-segment H/V constraints, endpoint merge
// onto nearby existing points, and point-on-line for open ends dropped on a
// line. Returns the constraints/entities created (for status text).
function addChainToSketch(vertices, closed) {
  const zoom = (_canvas && _canvas.getZoom()) || 1;
  const mergeTol = SNAP_MERGE / zoom;

  // Axis facts from the raw (classifier-snapped) vertex list, per segment.
  const segAxis = [];
  const segCount = closed ? vertices.length : vertices.length - 1;
  for (let i = 0; i < segCount; i++) {
    segAxis.push(axisOf(vertices[i], vertices[(i + 1) % vertices.length]));
  }

  const before = new Set(_sketch.points.map((p) => p.id));
  const { points, lines } = _sketch.addChain(vertices, closed, mergeTol);

  lines.forEach((l, i) => {
    if (segAxis[i]) _sketch.addConstraint({ type: segAxis[i], line: l.id });
  });

  // Open ends that landed on an existing line (not one we just made) stick.
  if (!closed) {
    const newIds = new Set(lines.map((l) => l.id));
    for (const endIdx of [0, points.length - 1]) {
      const p = points[endIdx];
      if (!before.has(p.id)) {
        const hit = findLineNear(p.x, p.y, SNAP_ONLINE / zoom, newIds);
        if (hit) _sketch.addConstraint({ type: 'pointOnLine', point: p.id, line: hit.id });
      }
    }
  }
  return { points, lines };
}

// Entry point from modes.js for a completed freehand stroke in CAD mode.
export function cadHandleStroke(path) {
  if (!_canvas) return;
  const pts = pathToPoints(path);
  const desc = classifyStroke(pts);
  if (!desc) return; // unrecognized: stays as plain ink annotation

  const before = _sketch.toJSON();

  switch (desc.type) {
    case 'line':
    case 'arrow': // an arrowhead has no CAD meaning — take the shaft as a line
      addChainToSketch([desc.a, desc.b], false);
      break;
    case 'polyline':
      addChainToSketch(desc.points, false);
      break;
    case 'polygon':
      addChainToSketch(desc.points, true);
      break;
    case 'rect': {
      const { x, y, w, h } = desc;
      addChainToSketch(
        [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }],
        true
      );
      break;
    }
    case 'circle':
    case 'ellipse': // an ellipse becomes its mean circle (sketches have no ellipse entity)
      _sketch.addCircle(desc.cx, desc.cy, (desc.rx + desc.ry) / 2);
      break;
    case 'arc':
      _sketch.addArc(desc.cx, desc.cy, desc.r, desc.startAngle, desc.endAngle);
      break;
    default:
      return;
  }

  // Swap ink for the parametric rendering; one undo restores both sketch & ink.
  historySuspend(() => _canvas.remove(path));
  solve();
  render();
  pushSketchUndo(before, (c) => c.add(path));
  emitChanged();
}

// --- click selection (CAD mode) ---

// What's under a tap at (x, y). Rather than returning the first target in a
// fixed priority order, every candidate within its radius is scored by how
// close it is relative to that radius, so a line directly under the finger
// beats a point at the edge of its own reach; the BIAS nudges keep small
// floating targets (dimension labels, points) winning near-ties.
// `slop` widens every radius by how far the tap itself wandered.
function hitTest(x, y, slop = 0) {
  const zoom = (_canvas && _canvas.getZoom()) || 1;
  const radius = (px) => pointerSlop(px) / zoom + slop;

  let best = null;
  let bestScore = Infinity;
  const consider = (hit, distance, r) => {
    if (distance > r) return;
    const score = distance / r - BIAS[hit.kind];
    if (score < bestScore) {
      bestScore = score;
      best = hit;
    }
  };

  for (const c of _sketch.constraints) {
    if (c.expr === undefined) continue;
    const pos = dimLabelPosition(c);
    if (pos) consider({ kind: 'dim', id: c.id }, Math.hypot(pos.x - x, pos.y - y), radius(HIT_DIM));
  }
  for (const p of _sketch.points) {
    consider({ kind: 'point', id: p.id }, Math.hypot(p.x - x, p.y - y), radius(HIT_POINT));
  }
  for (const e of _sketch.circles()) {
    const ctr = _sketch.point(e.c);
    if (ctr) {
      consider({ kind: 'entity', id: e.id }, Math.abs(Math.hypot(ctr.x - x, ctr.y - y) - e.r), radius(HIT_EDGE));
    }
  }
  for (const e of _sketch.arcs()) {
    const ctr = _sketch.point(e.c);
    if (ctr && angleInArc(Math.atan2(y - ctr.y, x - ctr.x), e.startAngle, e.endAngle)) {
      consider({ kind: 'entity', id: e.id }, Math.abs(Math.hypot(ctr.x - x, ctr.y - y) - e.r), radius(HIT_EDGE));
    }
  }
  for (const e of _sketch.lines()) {
    const a = _sketch.point(e.p1);
    const b = _sketch.point(e.p2);
    if (a && b) consider({ kind: 'entity', id: e.id }, distToSegment({ x, y }, a, b), radius(HIT_EDGE));
  }
  return best;
}

// A stroke too small for the recognizer to ever turn into geometry. In CAD
// mode that's a tap, not ink: a poke that slipped a few pixels should select
// what's under it instead of leaving an ink speck on the board.
export function isCadTap(path) {
  if (!path) return false;
  return Math.hypot(path.width || 0, path.height || 0) < MIN_SIZE;
}

// Entry point from modes.js for a tap in CAD mode. The tap's own size feeds
// back into the search radius — a poke that wandered 20px was evidently an
// imprecise aim, so it gets a correspondingly more forgiving reach.
export function cadHandleClick(dotPath) {
  if (!_canvas) return;
  const w = dotPath.width || 0;
  const h = dotPath.height || 0;
  const x = (dotPath.left || 0) + w / 2;
  const y = (dotPath.top || 0) + h / 2;
  const hit = hitTest(x, y, Math.hypot(w, h) / 2);
  if (!hit) {
    if (_selection.length) {
      _selection = [];
      render();
      emitChanged();
    }
    return;
  }
  if (hit.kind === 'dim') {
    editDimension(hit.id);
    return;
  }
  const i = _selection.findIndex((s) => s.kind === hit.kind && s.id === hit.id);
  if (i >= 0) _selection.splice(i, 1); // click again to deselect
  else _selection.push(hit);
  render();
  emitChanged();
}

export function clearCadSelection() {
  if (!_selection.length) return;
  _selection = [];
  render();
  emitChanged();
}

// --- constraint & dimension commands (called by the CAD toolbar) ---

function selectedLines() {
  return _selection
    .filter((s) => s.kind === 'entity')
    .map((s) => _sketch.entity(s.id))
    .filter((e) => e && e.type === 'line');
}

// Named "circles" for historical reasons but covers both circles and arcs —
// they share a centre + radius and behave identically for equal/radius dims.
function selectedCircles() {
  return _selection
    .filter((s) => s.kind === 'entity')
    .map((s) => _sketch.entity(s.id))
    .filter((e) => e && (e.type === 'circle' || e.type === 'arc'));
}

function selectedPoints() {
  return _selection
    .filter((s) => s.kind === 'point')
    .map((s) => _sketch.point(s.id))
    .filter(Boolean);
}

function commit(before) {
  solve();
  render();
  pushSketchUndo(before);
  emitChanged();
}

// The shared constraint-application core: `sel` is { lines, circles, points }
// (model objects). Mutates the sketch; returns null on success or a
// human-readable reason the selection didn't fit. Used by both the toolbar
// (current CAD selection) and the voice agent (explicit ids).
// Does an equivalent constraint already exist? Keeps repeated clicks (and
// repeated voice calls) from stacking redundant constraints.
function hasLineAxis(type, lineId) {
  return _sketch.constraints.some((c) => c.type === type && c.line === lineId);
}

function hasPair(type, aId, bId) {
  return _sketch.constraints.some(
    (c) => c.type === type && ((c.a === aId && c.b === bId) || (c.a === bId && c.b === aId))
  );
}

function constrainCore(type, sel) {
  const { lines, circles, points } = sel;

  switch (type) {
    case 'horizontal':
    case 'vertical': {
      if (!lines.length) return 'Select one or more lines first.';
      const todo = lines.filter((l) => !hasLineAxis(type, l.id));
      if (!todo.length) return `Already ${type}.`;
      todo.forEach((l) => _sketch.addConstraint({ type, line: l.id }));
      break;
    }
    case 'parallel':
    case 'perpendicular': {
      if (lines.length !== 2) return 'Select exactly two lines.';
      if (hasPair(type, lines[0].id, lines[1].id)) return `Already ${type}.`;
      _sketch.addConstraint({ type, a: lines[0].id, b: lines[1].id });
      break;
    }
    case 'equal': {
      if (lines.length >= 2) {
        for (let i = 1; i < lines.length; i++) {
          if (!hasPair('equal', lines[0].id, lines[i].id)) {
            _sketch.addConstraint({ type: 'equal', a: lines[0].id, b: lines[i].id });
          }
        }
      } else if (circles.length >= 2) {
        for (let i = 1; i < circles.length; i++) {
          if (!hasPair('equal', circles[0].id, circles[i].id)) {
            _sketch.addConstraint({ type: 'equal', a: circles[0].id, b: circles[i].id });
          }
        }
      } else {
        return 'Select two or more lines, or two or more circles.';
      }
      break;
    }
    case 'coincident': {
      if (points.length === 2) {
        _sketch.mergePoints(points[0].id, points[1].id);
      } else if (points.length === 1 && lines.length === 1) {
        if (_sketch.constraints.some((c) => c.type === 'pointOnLine' && c.point === points[0].id && c.line === lines[0].id)) {
          return 'Already on that line.';
        }
        _sketch.addConstraint({ type: 'pointOnLine', point: points[0].id, line: lines[0].id });
      } else {
        return 'Select two points (merge), or a point and a line.';
      }
      break;
    }
    case 'fix': {
      if (!points.length) return 'Select one or more points first.';
      points.forEach((p) => {
        const existing = _sketch.constraints.find((c) => c.type === 'fix' && c.point === p.id);
        if (existing) _sketch.removeConstraint(existing.id);
        else _sketch.addConstraint({ type: 'fix', point: p.id, x: p.x, y: p.y });
      });
      break;
    }
    default:
      return `Unknown constraint '${type}'.`;
  }
  return null;
}

// Toolbar entry point: apply a constraint to the current CAD selection.
// Returns null on success, or a human-readable reason the selection didn't fit.
export function applyConstraint(type) {
  const sel = { lines: selectedLines(), circles: selectedCircles(), points: selectedPoints() };
  const before = _sketch.toJSON();
  const err = constrainCore(type, sel);
  if (err) return err;
  _selection = [];
  commit(before);
  return null;
}

// The current CAD selection as model objects + which constraints it already
// carries — drives the context menu's content-aware buttons and toggle states.
export function selectionDetails() {
  const lines = selectedLines();
  const circles = selectedCircles();
  const points = selectedPoints();
  return {
    sketch: _sketch,
    lines,
    circles,
    points,
    allHorizontal: lines.length > 0 && lines.every((l) => hasLineAxis('horizontal', l.id)),
    allVertical: lines.length > 0 && lines.every((l) => hasLineAxis('vertical', l.id)),
    allFixed: points.length > 0 && points.every((p) => isPointFixed(p.id)),
    measuredAngle: lines.length === 2 ? measuredAngle(lines[0], lines[1]) : null,
  };
}

// Remove an axis (horizontal/vertical) constraint from every selected line —
// the context menu's "toggle off" for an active H/V chip.
export function removeAxisFromSelection(type) {
  const lines = selectedLines();
  const ids = _sketch.constraints
    .filter((c) => c.type === type && lines.some((l) => l.id === c.line))
    .map((c) => c.id);
  if (!ids.length) return `Nothing ${type} in the selection.`;
  const before = _sketch.toJSON();
  ids.forEach((id) => _sketch.removeConstraint(id));
  _selection = [];
  commit(before);
  return null;
}

// modes.js pokes this on every mode switch so mode-dependent CAD UI (the
// context menu) re-evaluates without a modes → cad UI import cycle.
export function notifyModeChanged() {
  emitChanged();
}

// Shared number formatting for on-canvas labels and menu chips.
export function formatValue(n) {
  return fmt(n);
}

// Signed angle (degrees) from line a's direction to line b's.
function measuredAngle(la, lb) {
  const d = (l) => {
    const p1 = _sketch.point(l.p1);
    const p2 = _sketch.point(l.p2);
    return { x: p2.x - p1.x, y: p2.y - p1.y };
  };
  const a = d(la);
  const b = d(lb);
  return (Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y) * 180) / Math.PI;
}

// What dimension fits `sel` ({ lines, circles, points }): line → length, two
// points → distance, circle → radius, two lines → angle. Returns
// { constraint (sans expr), label, current } or null.
function dimensionDraft(sel) {
  const { lines, circles, points } = sel;

  let draft = null;
  if (lines.length === 1 && !points.length && !circles.length) {
    const l = lines[0];
    draft = {
      constraint: { type: 'distance', p1: l.p1, p2: l.p2 },
      label: 'Length',
      current: _sketch.lineLength(l),
    };
  } else if (points.length === 2 && !lines.length) {
    draft = {
      constraint: { type: 'distance', p1: points[0].id, p2: points[1].id },
      label: 'Distance',
      current: Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y),
    };
  } else if (circles.length === 1 && !lines.length && !points.length) {
    draft = {
      constraint: { type: 'radius', circle: circles[0].id },
      label: 'Radius',
      current: circles[0].r,
    };
  } else if (lines.length === 2) {
    draft = {
      constraint: { type: 'angle', a: lines[0].id, b: lines[1].id },
      label: 'Angle (°)',
      current: measuredAngle(lines[0], lines[1]),
    };
  }
  return draft;
}

const DIM_HINT = 'Select a line (length), two points (distance), a circle (radius), or two lines (angle).';

// Toolbar entry point: dimension the current selection, prompting with the
// measured value (input accepts parameter expressions). Returns null or a reason.
export function addDimension(promptFn = window.prompt) {
  const draft = dimensionDraft({ lines: selectedLines(), circles: selectedCircles(), points: selectedPoints() });
  if (!draft) return DIM_HINT;

  const input = promptFn(`${draft.label} — number or expression (params allowed):`, fmt(draft.current));
  if (input === null || input.trim() === '') return null; // cancelled
  try {
    _sketch.evalDim(input); // validate before committing
  } catch (e) {
    return `Bad expression: ${e.message}`;
  }

  const before = _sketch.toJSON();
  _sketch.addConstraint({ ...draft.constraint, expr: input.trim() });
  _selection = [];
  commit(before);
  return null;
}

// Re-prompt for an existing dimension's expression (click on its label).
export function editDimension(constraintId, promptFn = window.prompt) {
  const c = _sketch.constraint(constraintId);
  if (!c || c.expr === undefined) return;
  const input = promptFn('New value or expression:', c.expr);
  if (input === null || input.trim() === '' || input.trim() === c.expr) return;
  try {
    _sketch.evalDim(input);
  } catch (e) {
    if (typeof window !== 'undefined' && window.alert) window.alert(`Bad expression: ${e.message}`);
    return;
  }
  const before = _sketch.toJSON();
  c.expr = input.trim();
  commit(before);
}

// Delete the current selection: entities (with their constraints/orphan
// points) and dimension constraints. Selected bare points are ignored.
export function deleteCadSelection() {
  if (!_selection.length) return;
  const before = _sketch.toJSON();
  let changed = false;
  for (const s of _selection) {
    if (s.kind === 'entity' && _sketch.entity(s.id)) {
      _sketch.removeEntity(s.id);
      changed = true;
    } else if (s.kind === 'dim' && _sketch.constraint(s.id)) {
      _sketch.removeConstraint(s.id);
      changed = true;
    }
  }
  _selection = [];
  if (changed) commit(before);
  else { render(); emitChanged(); }
}

export function removeConstraintById(id) {
  if (!_sketch.constraint(id)) return;
  const before = _sketch.toJSON();
  _sketch.removeConstraint(id);
  commit(before);
}

// --- programmatic API (the voice agent's cad_* tools) ---
//
// Mirrors the toolbar commands but addresses geometry by id instead of the
// interactive CAD selection, so the voice assistant can sketch, constrain,
// dimension and parametrize without touching the UI. All coordinates here are
// SCENE units (canvas-actions.js converts from board percent).

function resolveRefs(entityIds, pointIds) {
  const lines = [];
  const circles = [];
  const missing = [];
  (entityIds || []).forEach((id) => {
    const e = _sketch.entity(String(id));
    if (!e) missing.push(String(id));
    else if (e.type === 'line') lines.push(e);
    else circles.push(e);
  });
  const points = [];
  (pointIds || []).forEach((id) => {
    const p = _sketch.point(String(id));
    if (!p) missing.push(String(id));
    else points.push(p);
  });
  return { lines, circles, points, missing };
}

// A connected chain of scene-coordinate vertices → sketch lines, with the same
// auto-constraints as hand-drawn strokes (exact-axis segments get H/V,
// endpoints merge onto nearby points, open ends stick to lines).
export function cadApiSketchChain(sceneVerts, closed) {
  if (!Array.isArray(sceneVerts) || sceneVerts.length < 2) return { error: 'need at least 2 points' };
  const before = _sketch.toJSON();
  const { points, lines } = addChainToSketch(
    sceneVerts.map((v) => ({ x: Number(v.x), y: Number(v.y) })),
    !!closed
  );
  commit(before);
  return {
    ok: true,
    lineIds: lines.map((l) => l.id),
    pointIds: points.map((p) => p.id),
  };
}

export function cadApiSketchCircle(cx, cy, r) {
  const before = _sketch.toJSON();
  const c = _sketch.addCircle(Number(cx), Number(cy), Math.max(1, Number(r)));
  commit(before);
  return { ok: true, id: c.id, centerPointId: c.c };
}

// startAngleDeg/endAngleDeg are measured the same way as the on-canvas
// coordinate grid: 0° = +x, 90° = +y (down), sweeping from start to end.
export function cadApiSketchArc(cx, cy, r, startAngleDeg, endAngleDeg) {
  const before = _sketch.toJSON();
  const startAngle = (Number(startAngleDeg) * Math.PI) / 180;
  const endAngle = (Number(endAngleDeg) * Math.PI) / 180;
  const e = _sketch.addArc(Number(cx), Number(cy), Math.max(1, Number(r)), startAngle, endAngle);
  commit(before);
  return { ok: true, id: e.id, centerPointId: e.c };
}

// Apply a constraint by ids. Returns null on success or a reason string.
export function cadApiConstrain(type, entityIds, pointIds) {
  const sel = resolveRefs(entityIds, pointIds);
  if (sel.missing.length) return `Unknown id(s): ${sel.missing.join(', ')} — call cad_get_sketch for current ids.`;
  const before = _sketch.toJSON();
  const err = constrainCore(type, sel);
  if (err) return err;
  commit(before);
  return null;
}

// Add a dimension by ids (expr in sketch units / degrees), or change an
// existing dimension's expression when dimId is given.
export function cadApiDimension({ entityIds, pointIds, expr, dimId }) {
  if (expr == null || String(expr).trim() === '') return { error: 'expr is required' };
  const text = String(expr).trim();
  try {
    _sketch.evalDim(text);
  } catch (e) {
    return { error: `Bad expression: ${e.message}` };
  }

  const before = _sketch.toJSON();
  if (dimId != null) {
    const c = _sketch.constraint(String(dimId));
    if (!c || c.expr === undefined) return { error: `No dimension with id '${dimId}'.` };
    c.expr = text;
    commit(before);
    return { ok: true, id: c.id };
  }

  const sel = resolveRefs(entityIds, pointIds);
  if (sel.missing.length) return { error: `Unknown id(s): ${sel.missing.join(', ')} — call cad_get_sketch for current ids.` };
  const draft = dimensionDraft(sel);
  if (!draft) return { error: DIM_HINT };
  const con = _sketch.addConstraint({ ...draft.constraint, expr: text });
  commit(before);
  return { ok: true, id: con.id, kind: draft.constraint.type };
}

export function cadApiSetParam(name, expr, remove) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(String(name || ''))) return { error: 'Invalid parameter name.' };
  const before = _sketch.toJSON();
  if (remove) {
    _sketch.removeParam(String(name));
  } else {
    const prev = _sketch.params.find((p) => p.name === name);
    _sketch.setParam(String(name), String(expr == null ? '0' : expr));
    if (!Number.isFinite(_sketch.paramScope()[name])) {
      // Reject an expression that doesn't evaluate (typo'd reference etc.).
      if (prev) _sketch.setParam(String(name), prev.expr);
      else _sketch.removeParam(String(name));
      return { error: `Expression for '${name}' does not evaluate — check names/syntax.` };
    }
  }
  commit(before);
  return { ok: true, params: _sketch.params.map((p) => ({ ...p })) };
}

// Delete entities and/or constraints (dimensions included) by id.
export function cadApiDelete(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(String);
  const before = _sketch.toJSON();
  let removed = 0;
  for (const id of list) {
    if (_sketch.entity(id)) { _sketch.removeEntity(id); removed++; }
    else if (_sketch.constraint(id)) { _sketch.removeConstraint(id); removed++; }
  }
  if (!removed) return { error: 'No matching entity or constraint ids.' };
  _selection = [];
  commit(before);
  return { ok: true, removed };
}

// A full, plain-JSON view of the sketch in SCENE coordinates: entities with
// their geometry, constraints (dimensions carry expr + value), parameters,
// DOF and solve status. canvas-actions.js converts coords to board percent.
export function cadApiSummary() {
  const scope = _sketch.paramScope();
  const entities = _sketch.entities.map((e) => {
    if (e.type === 'line') {
      const a = _sketch.point(e.p1);
      const b = _sketch.point(e.p2);
      return {
        id: e.id, type: 'line', p1: e.p1, p2: e.p2,
        a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y },
        length: Math.hypot(b.x - a.x, b.y - a.y),
      };
    }
    const ctr = _sketch.point(e.c);
    if (e.type === 'arc') {
      return {
        id: e.id, type: 'arc', centerPointId: e.c, center: { x: ctr.x, y: ctr.y }, radius: e.r,
        startAngleDeg: (e.startAngle * 180) / Math.PI, endAngleDeg: (e.endAngle * 180) / Math.PI,
      };
    }
    return { id: e.id, type: 'circle', centerPointId: e.c, center: { x: ctr.x, y: ctr.y }, radius: e.r };
  });
  const constraints = _sketch.constraints.map((c) => {
    const out = { id: c.id, type: c.type };
    ['line', 'a', 'b', 'circle', 'point', 'p1', 'p2'].forEach((k) => { if (c[k] !== undefined) out[k] = c[k]; });
    if (c.expr !== undefined) {
      out.expr = c.expr;
      try { out.value = _sketch.evalDim(c.expr); } catch (e) { out.value = null; }
    }
    return out;
  });
  return {
    points: _sketch.points.map((p) => ({ id: p.id, x: p.x, y: p.y, fixed: isPointFixed(p.id) })),
    entities,
    constraints,
    params: _sketch.params.map((p) => ({ name: p.name, expr: p.expr, value: scope[p.name] })),
    degreesOfFreedom: _sketch.degreesOfFreedom(),
    solve: { ok: _status.ok, maxResidual: _status.maxResidual },
  };
}

// --- persistence (boards) ---

export function getSketchJSON() {
  return _sketch.isEmpty() && !_sketch.params.length ? null : _sketch.toJSON();
}

export function loadSketchJSON(data) {
  _sketch = data ? Sketch.fromJSON(data) : new Sketch();
  _selection = [];
  _status = { ok: true, maxResidual: 0 };
  if (!_sketch.isEmpty()) solve();
  render();
  emitChanged();
}

// --- init & drag wiring ---

export function initCad(canvas, opts = {}) {
  _canvas = canvas;
  if (opts.getMode) _getMode = opts.getMode;

  // Dragging point markers in Select mode — one marker, or a whole marquee of
  // them: each is pinned to where Fabric has moved it and the sketch re-solves
  // live, so the lines follow the markers instead of being left behind, while
  // constraints still win over the drag.
  canvas.on('mouse:down', (e) => {
    _dragMarkers = cadPointMarkers(e.target);
    _dragBefore = _dragMarkers.length ? _sketch.toJSON() : null;
  });

  canvas.on('object:moving', () => {
    if (!_dragMarkers.length) return;
    const pins = new Map();
    for (const marker of _dragMarkers) {
      const p = _sketch.point(marker._cad.id);
      if (p) pins.set(p.id, markerScenePosition(marker));
    }
    if (!pins.size) return;
    solve(pins);
    syncFromModel(_dragMarkers);
  });

  canvas.on('object:modified', () => {
    if (!_dragMarkers.length || !_dragBefore) return;
    const before = _dragBefore;
    _dragBefore = null;
    _dragMarkers = [];
    solve();
    render();
    pushSketchUndo(before);
    emitChanged();
  });

  window.addEventListener('keydown', (ev) => {
    if (_getMode() !== 'cad') return;
    const el = document.activeElement;
    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
    if (ev.key === 'Escape') {
      clearCadSelection();
    } else if ((ev.key === 'Delete' || ev.key === 'Backspace') && _selection.length) {
      ev.preventDefault();
      deleteCadSelection();
    }
  });

  // After ANY undo the sketch may have been restored — re-render to match.
  onAfterUndo(() => render());

  // Debug/test bridge (same spirit as window.canvas / window.solveEquation).
  window.cadDebug = { getSketch, getSolveStatus, getCadSelection };
}

// The CAD point markers a drag target covers: the object itself when a lone
// marker is grabbed, or every marker inside a multi-object selection. Markers
// whose point has since vanished from the model are filtered out.
function cadPointMarkers(target) {
  if (!target) return [];
  const candidates = target._cad
    ? [target]
    : (typeof target.getObjects === 'function' ? target.getObjects() : []);
  return candidates.filter(
    (o) => o._cad && o._cad.kind === 'point' && _sketch.point(o._cad.id)
  );
}

// A marker's centre in scene coordinates. Inside a multi-selection an object's
// own left/top are group-relative, so the full transform matrix is the only
// honest source — its translation is the centre (markers are centre-origin).
function markerScenePosition(marker) {
  const m = marker.calcTransformMatrix();
  return { x: m[4], y: m[5] };
}

// Live update of the rendering from the model during a drag. The markers being
// dragged are left alone (Fabric owns their position mid-transform, and inside
// a multi-selection removing one would corrupt the selection); everything else
// is cheap to rebuild wholesale.
function syncFromModel(draggedMarkers) {
  const keep = draggedMarkers.filter((o) => _fxObjects.includes(o));
  const skipPoints = new Set(keep.map((o) => o._cad && o._cad.id).filter(Boolean));
  historySuspend(() => {
    _fxObjects.forEach((o) => { if (!keep.includes(o)) _canvas.remove(o); });
    const rebuilt = buildObjects(skipPoints);
    rebuilt.forEach((o) => _canvas.add(o));
    _fxObjects = [...keep, ...rebuilt];
    // A single dragged marker stays on top of the freshly added geometry. (For
    // a multi-selection Fabric manages the group's own stacking.)
    if (keep.length === 1) _canvas.bringObjectToFront(keep[0]);
  });
  _canvas.requestRenderAll();
}
