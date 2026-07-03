// src/canvas-actions.js — execute assistant tool calls against the Fabric canvas.
//
// The voice assistant (Gemini Live) calls these via function-calling. Positions/
// sizes are percentages (0-100) of the visible board (origin top-left), converted
// here to scene coordinates (zoom/pan aware).
//
// Shapes are targeted by a STABLE id: drawing tools return the new shape's id, and
// get_objects lists ids — so the model can reliably adjust a specific shape later.
// (A spatial x,y fallback is kept for when no id is available.)

import { getCanvas, clearCanvas } from './canvas.js';
import { Line, Rect, Ellipse, IText, Path, Point } from 'fabric';
import { renderGraph } from './graph.js';
import { extractEquation, solveToBoard } from './api.js';
import { getCurrentModel } from './ui.js';
import { buildPoly } from './shapes.js';
import { snapPointToShapes, toTargetLocal } from './edge-snap.js';
import { suspend as historySuspend } from './history.js';
import { appendToOutput } from './output.js';

const STROKE = 'black';
const STROKE_WIDTH = 4;
const ANCHOR_PX = 22; // screen-pixel radius for anchoring a polyline vertex to a shape

// A CSS colour + optional opacity → an rgba() fill (hex only gets the alpha; a
// named colour is returned as-is). '' when no fill / transparent.
function toRgba(color, opacity) {
  if (color == null || color === 'none' || color === 'transparent' || color === '') return '';
  const a = Number.isFinite(Number(opacity)) ? Math.max(0, Math.min(1, Number(opacity))) : 1;
  const m = /^#?([0-9a-f]{6})$/i.exec(String(color));
  if (m) {
    const n = parseInt(m[1], 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }
  return String(color); // named colour — alpha only supported for hex
}

// Shared style options for a drawing tool: outline colour/width, fill, corners.
function styleOf(args) {
  return {
    color: args.color ? String(args.color) : STROKE,
    strokeWidth: num(args.strokeWidth, STROKE_WIDTH),
    fill: toRgba(args.fill, args.fillOpacity),
    cornerRadius: Math.max(0, num(args.cornerRadius, 0)),
  };
}

// Pin any polyline vertex placed close to an existing shape's edge onto that edge
// and record a sticky anchor, so the vertex follows the shape when it's moved —
// the same machinery the freehand smart-shape path uses. `scenePts` are the
// vertices in scene coords (== poly.points before its bounding box is recomputed).
function anchorPolyVertices(canvas, poly, scenePts) {
  const targets = canvas.getObjects().filter((o) => o._isShape && !o._isGhost && o !== poly);
  if (!targets.length) return;
  const maxDist = ANCHOR_PX / (canvas.getZoom() || 1);
  const anchors = {};
  let changed = false;
  scenePts.forEach((p, i) => {
    const hit = snapPointToShapes(p, targets, maxDist);
    if (hit) {
      poly.points[i] = new Point(hit.point.x, hit.point.y);
      anchors[i] = { target: hit.target, local: toTargetLocal(hit.target, hit.point) };
      changed = true;
    }
  });
  if (changed) {
    poly._edgeAnchors = anchors;
    poly.setBoundingBox(true);
    poly.setCoords();
  }
}

const round1 = (v) => Math.round(v * 10) / 10;

// Resolve a rect/ellipse's top-left scene position: by CENTER when cx,cy are
// given (the model usually thinks in centers — "on the cross", "around the
// point"), else by top-left x,y. `sz` is the scene-unit size.
function topLeftOf(canvas, args, sz) {
  if (args.cx != null && args.cy != null) {
    const c = pctToScene(canvas, args.cx, args.cy);
    return { x: c.x - sz.w / 2, y: c.y - sz.h / 2 };
  }
  return pctToScene(canvas, args.x, args.y);
}

// Least-squares fit delta ≈ b + m*(coord - c0), c0 = mean target coord. Gives a
// correction model ("your aim is off by b, plus m per unit away from c0") the
// assistant can invert when placing by eye.
function linFit(pairs) {
  const n = pairs.length;
  if (!n) return { b: 0, m: 0, c0: 50 };
  const c0 = pairs.reduce((a, p) => a + p[0], 0) / n;
  const dm = pairs.reduce((a, p) => a + p[1], 0) / n;
  let varc = 0;
  let cov = 0;
  pairs.forEach(([c, d]) => { varc += (c - c0) * (c - c0); cov += (c - c0) * (d - dm); });
  return { b: round1(dm), m: varc > 1e-6 ? Math.round((cov / varc) * 1000) / 1000 : 0, c0: round1(c0) };
}

function median(arr) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

// Robust per-axis fit. Outliers are judged against the LINE, not the median:
// a smooth stretch (delta growing linearly across the board — a real, correctable
// distortion in how the model reads the grid) must be captured as the model,
// while discrete misreads (snapping to a wrong gridline) are far off the line
// and get flagged as SLIPS and excluded from the fit.
function axisFit(pairs) {
  if (!pairs.length) return { b: 0, m: 0, c0: 50, slips: 0 };
  const resid = (fit, p) => p[1] - (fit.b + fit.m * (p[0] - fit.c0));
  let fit = linFit(pairs);
  const inliers = pairs.filter((p) => Math.abs(resid(fit, p)) <= 2.5);
  if (inliers.length >= 3 && inliers.length < pairs.length) fit = linFit(inliers);
  return { ...fit, slips: pairs.length - inliers.length };
}

// An object's ACTUAL bounding box in board percent — returned from every drawing
// tool so the model gets immediate ground truth on where things really landed
// (and can correct itself without waiting for the next video frame).
function bboxPct(canvas, o) {
  o.setCoords();
  const r = o.getBoundingRect();
  const tl = sceneToPct(canvas, r.left, r.top);
  const br = sceneToPct(canvas, r.left + r.width, r.top + r.height);
  return { x: round1(tl.x), y: round1(tl.y), width: round1(br.x - tl.x), height: round1(br.y - tl.y) };
}

// ---- self-calibration --------------------------------------------------------
//
// calibrate_start puts reference targets on the board (red crosses at known
// percent positions + a dashed text box); the assistant then draws marks where it
// SEES them in the video frame; calibrate_check measures the placement error,
// prints a report card to the output panel, cleans up, and returns the numbers so
// the assistant can correct its aim and iterate.

let _calib = null; // { crosses, box, targetObjs, beforeIds, round }
let _lastModel = null; // latest ABSOLUTE correction model (see calibrate_check)

// Fallback layout: 7 targets over 5+ DISTINCT values per axis (with repeated
// coords a discrete gridline snap and a genuine linear stretch are
// indistinguishable to the fit).
const CALIB_CROSSES = [
  { x: 15, y: 15 }, { x: 85, y: 15 }, { x: 50, y: 40 }, { x: 15, y: 85 }, { x: 85, y: 85 },
  { x: 35, y: 25 }, { x: 70, y: 70 },
];
const CALIB_BOX = { x: 35, y: 60, w: 30, h: 18 };

// Random target layout per round: the check report reveals the true target
// positions, so with a FIXED layout every round after the first tests the
// assistant's memory of the numbers, not its reading of the video.
function randCalibLayout() {
  const box = {
    x: Math.round(10 + Math.random() * 55),
    y: Math.round(15 + Math.random() * 50),
    w: 30,
    h: 18,
  };
  const crosses = [];
  let guard = 0;
  while (crosses.length < 7 && guard++ < 800) {
    const x = Math.round(8 + Math.random() * 84);
    const y = Math.round(8 + Math.random() * 84);
    if (x > box.x - 6 && x < box.x + box.w + 6 && y > box.y - 6 && y < box.y + box.h + 6) continue;
    if (crosses.some((p) => Math.hypot(p.x - x, p.y - y) < 15)) continue;
    crosses.push({ x, y });
  }
  return crosses.length >= 5 ? { box, crosses } : { box: CALIB_BOX, crosses: CALIB_CROSSES };
}

// The stored ABSOLUTE correction model (latest in this session, else persisted).
function readModel() {
  if (_lastModel) return _lastModel;
  try {
    return (JSON.parse(localStorage.getItem('sw_voicecal') || 'null') || {}).absolute || null;
  } catch (e) {
    return null;
  }
}

// An eye-read percent -> true board percent, per the correction model.
function correctRead(v, f) {
  return f ? v - (f.b + f.m * (v - (f.c0 || 50))) : v;
}

// fromVideo=true on a drawing tool means its coordinates were READ off the
// video frame: apply the stored calibration mechanically here. The assistant
// only tags the source — it never does the correction arithmetic itself (a
// signed formula applied per-call by the model proved error-prone).
function correctedArgs(args) {
  const model = readModel();
  if (!model || !model.x || !model.y) return args;
  const out = { ...args };
  ['x', 'cx', 'x1', 'x2'].forEach((k) => { if (out[k] != null) out[k] = correctRead(num(out[k]), model.x); });
  ['y', 'cy', 'y1', 'y2'].forEach((k) => { if (out[k] != null) out[k] = correctRead(num(out[k]), model.y); });
  if (Array.isArray(out.points)) {
    out.points = out.points.map((p) => ({ x: correctRead(num(p.x), model.x), y: correctRead(num(p.y), model.y) }));
  }
  return out;
}

function calibCleanup(canvas) {
  if (!_calib) return;
  const leftovers = [..._calib.targetObjs, ...(_calib.keptMarks || [])];
  const gone = leftovers.filter((o) => canvas.getObjects().includes(o));
  if (gone.length) historySuspend(() => gone.forEach((o) => canvas.remove(o)));
  _calib.targetObjs = [];
  _calib.keptMarks = [];
}

// Frame-capture + canvas geometry. Deterministic diagnostics for the report —
// mismatches here (aspect, retina scaling) would skew everything the model sees.
// MAX_FRAME_WIDTH mirrors voice.js.
function calibDiagnostics(canvas) {
  const el = canvas.lowerCanvasEl;
  const t = vpt(canvas);
  const scale = Math.min(1, 768 / el.width);
  return {
    cssSize: `${canvas.getWidth()}x${canvas.getHeight()}`,
    backingStore: `${el.width}x${el.height}`,
    devicePixelRatio: window.devicePixelRatio || 1,
    zoom: Math.round(canvas.getZoom() * 100) / 100,
    pan: [Math.round(t[4]), Math.round(t[5])],
    streamedFrame: `${Math.round(el.width * scale)}x${Math.round(el.height * scale)}`,
  };
}

// AI solve/steps need an LLM; math.js can't do symbolic work.
function aiModel() {
  const m = getCurrentModel();
  return m === 'math' ? 'gpt' : m;
}

// The most recently analyzed equation object — the anchor under which the voice
// agent writes its solution/steps block.
function lastAnalyzedEquation(canvas) {
  const ext = canvas.getObjects().filter((o) => o._isExtracted);
  return ext.length ? ext[ext.length - 1] : null;
}

// The independent variable of the last analyzed equation (defaults to x).
function independentVar() {
  const d = window.extractedEquationData;
  if (d && d.ranges && Object.keys(d.ranges).length) return Object.keys(d.ranges)[0];
  if (d && d.scope && Object.keys(d.scope).length) return Object.keys(d.scope)[0];
  return 'x';
}
let _idCounter = 0;

function num(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function vpt(canvas) {
  return canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
}

function pctToScene(canvas, xPct, yPct) {
  const t = vpt(canvas);
  const sx = (num(xPct) / 100) * canvas.getWidth();
  const sy = (num(yPct) / 100) * canvas.getHeight();
  return { x: (sx - t[4]) / t[0], y: (sy - t[5]) / t[3] };
}

function pctLen(canvas, wPct, hPct) {
  const t = vpt(canvas);
  return {
    w: ((num(wPct) / 100) * canvas.getWidth()) / t[0],
    h: ((num(hPct) / 100) * canvas.getHeight()) / t[3],
  };
}

function sceneToPct(canvas, sx, sy) {
  const t = vpt(canvas);
  const screenX = sx * t[0] + t[4];
  const screenY = sy * t[3] + t[5];
  return { x: (screenX / canvas.getWidth()) * 100, y: (screenY / canvas.getHeight()) * 100 };
}

function ensureId(o) {
  if (!o._aiId) o._aiId = 'o' + (++_idCounter);
  return o._aiId;
}

function findById(canvas, id) {
  return canvas.getObjects().find((o) => o._aiId === id) || null;
}

function findObjectAt(canvas, pt) {
  const objs = canvas.getObjects().filter((o) => o.selectable !== false && !o._isGhost);
  for (let i = objs.length - 1; i >= 0; i--) {
    const r = objs[i].getBoundingRect();
    if (pt.x >= r.left && pt.x <= r.left + r.width && pt.y >= r.top && pt.y <= r.top + r.height) {
      return objs[i];
    }
  }
  let best = null;
  let bestDist = Infinity;
  for (const o of objs) {
    const c = o.getCenterPoint();
    const d = Math.hypot(c.x - pt.x, c.y - pt.y);
    if (d < bestDist) { bestDist = d; best = o; }
  }
  return bestDist < 140 ? best : null;
}

// Resolve the target shape: by id (exact) if given, else by x,y location.
function resolveTarget(canvas, args) {
  if (args && args.id != null) {
    const o = findById(canvas, String(args.id));
    if (o) return o;
  }
  if (args && args.x != null && args.y != null) {
    return findObjectAt(canvas, pctToScene(canvas, args.x, args.y));
  }
  return null;
}

function arrowPath(a, b) {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const hl = Math.max(10, Math.min(30, len * 0.25));
  const th = (28 * Math.PI) / 180;
  const h1 = { x: b.x - hl * Math.cos(ang - th), y: b.y - hl * Math.sin(ang - th) };
  const h2 = { x: b.x - hl * Math.cos(ang + th), y: b.y - hl * Math.sin(ang + th) };
  return `M ${a.x} ${a.y} L ${b.x} ${b.y} L ${h1.x} ${h1.y} M ${b.x} ${b.y} L ${h2.x} ${h2.y}`;
}

function applyColor(o, color) {
  o.set({ stroke: color });
  if (o.type === 'i-text' || o.type === 'text') o.set({ fill: color });
  else if (o.fill && o.fill !== 'transparent' && o.fill !== '') o.set({ fill: color });
}

// executeAction(name, args) -> Promise<result>. Drawing tools return the new
// shape's id; the model echoes results back so it knows what succeeded.
export async function executeAction(name, args = {}) {
  const canvas = getCanvas();
  if (!canvas) return { error: 'canvas not available' };

  const DRAW_TOOLS = ['draw_line', 'draw_rect', 'draw_ellipse', 'draw_arrow', 'draw_polyline', 'draw_polygon', 'write_text'];
  const fromVideo = args && args.fromVideo === true;
  if (fromVideo && DRAW_TOOLS.includes(name)) args = correctedArgs(args);

  const place = (obj) => {
    if (fromVideo) obj._fromVideo = true; // lets calibrate_check compose models truthfully
    canvas.add(obj);
    canvas.requestRenderAll();
    return { ok: true, id: ensureId(obj), bbox: bboxPct(canvas, obj) };
  };

  switch (name) {
    case 'draw_line': {
      const a = pctToScene(canvas, args.x1, args.y1);
      const b = pctToScene(canvas, args.x2, args.y2);
      const s = styleOf(args);
      return place(new Line([a.x, a.y, b.x, b.y], { stroke: s.color, strokeWidth: s.strokeWidth, _isShape: true }));
    }
    case 'draw_rect': {
      const sz = pctLen(canvas, num(args.width, 10), num(args.height, 10));
      const p = topLeftOf(canvas, args, sz);
      const s = styleOf(args);
      return place(new Rect({ left: p.x, top: p.y, width: sz.w, height: sz.h, rx: s.cornerRadius, ry: s.cornerRadius, fill: s.fill || 'transparent', stroke: s.color, strokeWidth: s.strokeWidth, _isShape: true }));
    }
    case 'draw_ellipse': {
      const sz = pctLen(canvas, num(args.width, 10), num(args.height, 10));
      const p = topLeftOf(canvas, args, sz);
      const s = styleOf(args);
      return place(new Ellipse({ left: p.x, top: p.y, rx: sz.w / 2, ry: sz.h / 2, fill: s.fill || 'transparent', stroke: s.color, strokeWidth: s.strokeWidth, _isShape: true }));
    }
    case 'draw_arrow': {
      const a = pctToScene(canvas, args.x1, args.y1);
      const b = pctToScene(canvas, args.x2, args.y2);
      const s = styleOf(args);
      return place(new Path(arrowPath(a, b), { stroke: s.color, strokeWidth: s.strokeWidth, fill: '', _isShape: true }));
    }
    case 'draw_polyline':
    case 'draw_polygon': {
      const closed = name === 'draw_polygon' || args.closed === true;
      const raw = Array.isArray(args.points) ? args.points : [];
      if (raw.length < 2) return { ok: false, message: 'need at least 2 points (each {x, y} in percent)' };
      const scenePts = raw.map((pt) => pctToScene(canvas, pt.x, pt.y));
      const s = styleOf(args);
      const poly = buildPoly(scenePts, { color: s.color, strokeWidth: s.strokeWidth, fill: closed ? s.fill : '' }, closed);
      poly.set({ _isShape: true });
      // Anchor vertices near an existing shape's edge (default on) so the line
      // sticks to shapes when they move — pass anchor:false to opt out.
      if (args.anchor !== false) anchorPolyVertices(canvas, poly, scenePts);
      return place(poly);
    }
    case 'write_text': {
      const color = args.color ? String(args.color) : STROKE;
      const text = new IText(String(args.text || ''), {
        left: 0, top: 0, fill: color,
        fontSize: Math.max(10, pctLen(canvas, 0, num(args.size, 6)).h),
        fontFamily: 'Caveat, cursive',
      });

      // boxId: auto-fit the text inside an existing shape — centered, sized to
      // fill ~80% of the box height but never overflowing its width.
      const box = args.boxId != null ? findById(canvas, String(args.boxId)) : null;
      if (args.boxId != null && !box) return { ok: false, message: 'boxId shape not found' };
      if (box) {
        const r = box.getBoundingRect();
        text.set({ fontSize: Math.max(10, r.height * 0.8) });
        const fit = Math.min((r.width * 0.85) / (text.width || 1), (r.height * 0.8) / (text.height || 1));
        if (fit < 1) text.set({ fontSize: Math.max(10, text.fontSize * fit) });
        text.set({
          left: r.left + (r.width - text.width) / 2,
          top: r.top + (r.height - text.height) / 2,
        });
      } else if (args.cx != null && args.cy != null) {
        // Center placement: we know the rendered size, the model doesn't.
        const c = pctToScene(canvas, args.cx, args.cy);
        text.set({ left: c.x - text.width / 2, top: c.y - text.height / 2 });
      } else {
        const p = pctToScene(canvas, num(args.x, 10), num(args.y, 10));
        text.set({ left: p.x, top: p.y });
      }
      return place(text);
    }
    case 'plot_function': {
      const variable = String(args.variable || 'x');
      const xmin = num(args.xmin, -10);
      const xmax = num(args.xmax, 10);
      const scope = { [variable]: 0 };
      const ranges = { [variable]: [xmin, xmax] };
      const resp = await fetch('/graph', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ expression: String(args.expression || ''), dependentVariable: 'y', scope, ranges }),
      });
      const data = await resp.json();
      if (data.success) {
        renderGraph(data.data, 'y', {
          expression: String(args.expression || ''), dependentVariable: 'y', variable,
          xmin, xmax, ymin: null, ymax: null, fontScale: 1,
        });
        return { ok: true, points: data.data.length };
      }
      return { error: data.message || 'graph failed' };
    }
    case 'get_objects': {
      const objects = canvas.getObjects()
        .filter((o) => o.selectable !== false && !o._isGhost)
        .map((o) => {
          const r = o.getBoundingRect();
          const tl = sceneToPct(canvas, r.left, r.top);
          const br = sceneToPct(canvas, r.left + r.width, r.top + r.height);
          const out = {
            id: ensureId(o),
            type: o.type,
            x: Math.round(tl.x),
            y: Math.round(tl.y),
            width: Math.round(br.x - tl.x),
            height: Math.round(br.y - tl.y),
          };
          if (o.text) out.text = String(o.text).slice(0, 40);
          return out;
        });
      return { objects };
    }
    case 'delete_object':
    case 'erase_at': {
      const o = resolveTarget(canvas, args);
      if (!o) return { ok: false, message: 'shape not found' };
      canvas.remove(o);
      canvas.requestRenderAll();
      return { ok: true };
    }
    case 'move_object': {
      const o = resolveTarget(canvas, args);
      if (!o) return { ok: false, message: 'shape not found' };
      const d = pctLen(canvas, args.dx, args.dy);
      o.set({ left: o.left + d.w, top: o.top + d.h });
      o.setCoords();
      canvas.requestRenderAll();
      return { ok: true, id: ensureId(o), bbox: bboxPct(canvas, o) };
    }
    case 'resize_object':
    case 'scale_object': {
      const o = resolveTarget(canvas, args);
      if (!o) return { ok: false, message: 'shape not found' };
      const f = num(args.factor, 1);
      if (f > 0) {
        o.set({ scaleX: (o.scaleX || 1) * f, scaleY: (o.scaleY || 1) * f });
        o.setCoords();
        canvas.requestRenderAll();
      }
      return { ok: true, id: ensureId(o), bbox: bboxPct(canvas, o) };
    }
    case 'set_color': {
      const o = resolveTarget(canvas, args);
      if (!o) return { ok: false, message: 'shape not found' };
      applyColor(o, String(args.color || 'black'));
      canvas.requestRenderAll();
      return { ok: true, id: ensureId(o) };
    }
    case 'style_object': {
      const o = resolveTarget(canvas, args);
      if (!o) return { ok: false, message: 'shape not found' };
      if (args.color != null) o.set({ stroke: String(args.color) });
      if (args.strokeWidth != null) o.set({ strokeWidth: num(args.strokeWidth, o.strokeWidth) });
      if (args.fill != null || args.fillOpacity != null) {
        // Text keeps a solid fill (its colour); geometry gets an rgba fill.
        if (o.type === 'i-text' || o.type === 'text') {
          if (args.fill != null) o.set({ fill: String(args.fill) });
        } else {
          o.set({ fill: toRgba(args.fill != null ? args.fill : o.fill, args.fillOpacity) });
        }
      }
      if (args.cornerRadius != null && o.type === 'rect') {
        const r = Math.max(0, num(args.cornerRadius, 0));
        o.set({ rx: r, ry: r });
      }
      o.set({ dirty: true });
      canvas.requestRenderAll();
      return { ok: true, id: ensureId(o) };
    }
    case 'duplicate_object': {
      const o = resolveTarget(canvas, args);
      if (!o) return { ok: false, message: 'shape not found' };
      const d = pctLen(canvas, args.dx, args.dy);
      const cloned = await o.clone();
      cloned._aiId = undefined; // give the copy its own id
      cloned.set({ left: o.left + d.w, top: o.top + d.h, evented: true, selectable: true });
      cloned.setCoords();
      canvas.add(cloned);
      canvas.requestRenderAll();
      return { ok: true, id: ensureId(cloned) };
    }
    case 'analyze_equation': {
      const data = await extractEquation();
      if (!data) return { ok: false, message: 'could not read an equation from the board' };
      return { ok: true, equation: `${data.dependentVariable} = ${data.equation}` };
    }
    case 'solve_equation':
    case 'show_steps': {
      const expr = String(args.expression || (window.extractedEquationData && window.extractedEquationData.equation) || '').trim();
      if (!expr) return { ok: false, message: 'no equation — call analyze_equation first or pass expression' };
      const variable = independentVar();
      const anchor = lastAnalyzedEquation(canvas);
      let instruction;
      let heading;
      if (name === 'show_steps') {
        const via = args.method ? ` using ${args.method}` : '';
        instruction = `${expr} = 0 for ${variable}. Show a concise numbered step-by-step solution${via}. Plain text only — no markdown or LaTeX.`;
        heading = args.method ? `Steps · ${args.method}` : 'Steps';
      } else {
        instruction = `${expr} = 0 for ${variable}. Give the exact solution(s) only, concise. Plain text only — no markdown or LaTeX.`;
        heading = 'Solution';
      }
      const res = await solveToBoard(instruction, aiModel(), anchor, heading);
      return res && res.ok ? { ok: true, result: res.text } : { ok: false, message: (res && res.text) || 'solve failed' };
    }
    case 'calibrate_start': {
      calibCleanup(canvas);
      const layout = randCalibLayout();
      const targetObjs = [];
      historySuspend(() => {
        layout.crosses.forEach((c) => {
          const p = pctToScene(canvas, c.x, c.y);
          const arm = pctLen(canvas, 2, 0).w;
          const cross = new Path(
            `M ${p.x - arm} ${p.y} L ${p.x + arm} ${p.y} M ${p.x} ${p.y - arm} L ${p.x} ${p.y + arm}`,
            { stroke: '#d11', strokeWidth: 2, fill: '', selectable: false, evented: false, excludeFromExport: true, _noHistory: true, _isCalib: true }
          );
          canvas.add(cross);
          targetObjs.push(cross);
        });
        const tl = pctToScene(canvas, layout.box.x, layout.box.y);
        const sz = pctLen(canvas, layout.box.w, layout.box.h);
        const rect = new Rect({
          left: tl.x, top: tl.y, width: sz.w, height: sz.h, fill: '',
          stroke: '#15c', strokeWidth: 2, strokeDashArray: [6, 4],
          selectable: false, evented: false, excludeFromExport: true, _noHistory: true, _isCalib: true,
        });
        canvas.add(rect);
        targetObjs.push(rect);
      });
      canvas.requestRenderAll();
      const beforeIds = new Set(canvas.getObjects().filter((o) => !o._isCalib).map((o) => ensureId(o)));
      _calib = {
        targetObjs,
        beforeIds,
        crosses: layout.crosses,
        box: layout.box,
        modelUsed: readModel(), // model in effect while the marks are drawn
        round: _calib ? _calib.round + 1 : 1,
      };
      return {
        ok: true,
        round: _calib.round,
        instructions:
          `Calibration round ${_calib.round}. YOU do everything in this test YOURSELF with tool calls, RIGHT NOW — the user draws nothing, do not ask them to do anything, and do not wait for permission or confirmation. ` +
          `The board now shows ${layout.crosses.length} red crosses and 1 dashed blue rectangle — their positions are RANDOM this round, so read them off the grid, do not reuse positions from an earlier round. ` +
          'Look at the NEXT video frame (about a second away), then: (1) for each red cross, draw a small ellipse (width 3, height 3) with cx,cy set to the cross position you read — and fromVideo=true, so your stored calibration is applied automatically (never apply correction math yourself). ' +
          'Strong NUMBERED gridlines mark the 10s; thin faint lines mark the 5s (15, 25, 35...). A cross often sits ON a thin 5-line or between lines — read each coordinate to the nearest 1, never snap to the nearest numbered line. ' +
          '(2) Write the word CAL with cx,cy set to the CENTER of the dashed blue rectangle as you read it, fromVideo=true, size roughly 70% of the box height — do NOT use boxId here. ' +
          'IMPORTANT: cx,cy is where the MIDDLE of the ellipse/text will land — pass the target point directly, never pre-offset it by half the size (the tool centers for you). ' +
          'When all marks are placed, call calibrate_check immediately.',
      };
    }
    case 'calibrate_check': {
      if (!_calib) return { ok: false, message: 'call calibrate_start first' };
      if (_calib.checked) {
        return {
          ok: false,
          message: 'This round was already checked and its targets are stale. You MUST call calibrate_start to lay out NEW targets before drawing the next round\'s marks.',
        };
      }
      _calib.checked = true;
      const marks = canvas.getObjects().filter((o) => !o._isCalib && o._aiId && !_calib.beforeIds.has(o._aiId));
      const texts = marks.filter((o) => o.type === 'i-text' || o.type === 'text');
      const dots = marks.filter((o) => o.type !== 'i-text' && o.type !== 'text');

      // Pair each cross with the nearest unused mark and measure the miss.
      const used = new Set();
      const perTarget = (_calib.crosses || CALIB_CROSSES).map((c) => {
        let best = null;
        let bestD = Infinity;
        for (const m of dots) {
          if (used.has(m)) continue;
          const ctr = m.getCenterPoint();
          const p = sceneToPct(canvas, ctr.x, ctr.y);
          const d = Math.hypot(p.x - c.x, p.y - c.y);
          if (d < bestD) { bestD = d; best = { m, p }; }
        }
        if (!best) return { target: c, hit: null };
        used.add(best.m);
        return { target: c, hit: { x: round1(best.p.x), y: round1(best.p.y) }, dx: round1(best.p.x - c.x), dy: round1(best.p.y - c.y), err: round1(bestD) };
      });

      const hits = perTarget.filter((r) => r.hit);
      const mean = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0);
      const stats = {
        marksPlaced: dots.length,
        targetsHit: hits.length,
        meanDx: round1(mean(hits.map((r) => r.dx))),
        meanDy: round1(mean(hits.map((r) => r.dy))),
        meanErr: round1(mean(hits.map((r) => r.err))),
        maxErr: round1(hits.reduce((a, r) => Math.max(a, r.err), 0)),
      };

      // Text test: how well does CAL sit inside the dashed box?
      const box = _calib.box || CALIB_BOX;
      let textReport = null;
      if (texts.length) {
        const b = bboxPct(canvas, texts[texts.length - 1]); // most recent CAL
        const boxCx = box.x + box.w / 2;
        const boxCy = box.y + box.h / 2;
        textReport = {
          bbox: b,
          centerOffset: { dx: round1(b.x + b.width / 2 - boxCx), dy: round1(b.y + b.height / 2 - boxCy) },
          fitsInBox: b.x >= box.x && b.y >= box.y &&
            b.x + b.width <= box.x + box.w && b.y + b.height <= box.y + box.h,
          heightVsBox: round1((b.height / box.h) * 100) + '%',
        };
      }

      // Fit a robust linear correction model per axis (outlier slips excluded):
      // how far off the aim is (offset) and how the miss grows across the board.
      const correction = {
        x: axisFit(hits.map((r) => [r.target.x, r.dx])),
        y: axisFit(hits.map((r) => [r.target.y, r.dy])),
      };

      // Corrections are stored ABSOLUTE (raw eye-read -> target). If the
      // assistant aimed this round WITH a correction applied
      // (appliedCorrection=true), this measurement is only the residual on top
      // of that model — compose them, or a perfect verification round would
      // overwrite the stored model with "no correction needed".
      const norm = (f) => ({ b: round1(f.b + f.m * (50 - f.c0)), m: f.m, c0: 50 });
      const addFits = (a, b2) => ({ b: round1(a.b + b2.b), m: Math.round((a.m + b2.m) * 1000) / 1000, c0: 50 });
      let absolute = { x: norm(correction.x), y: norm(correction.y) };
      // Auto-detect whether the marks were drawn corrected: fromVideo-tagged
      // marks had the model applied by the tool itself, which beats trusting
      // the assistant's appliedCorrection self-report.
      const applied = marks.some((o) => o._fromVideo) || args.appliedCorrection === true;
      const prev = _calib.modelUsed;
      if (applied && prev && prev.x && prev.y) {
        absolute = { x: addFits(norm(prev.x), absolute.x), y: addFits(norm(prev.y), absolute.y) };
      }
      _lastModel = absolute;
      hits.forEach((r) => {
        const rx = r.dx - (correction.x.b + correction.x.m * (r.target.x - correction.x.c0));
        const ry = r.dy - (correction.y.b + correction.y.m * (r.target.y - correction.y.c0));
        r.slip = Math.abs(rx) > 2.5 || Math.abs(ry) > 2.5;
        r.resid = round1(Math.hypot(rx, ry));
      });
      const slips = hits.filter((r) => r.slip).length;
      const cleanHits = hits.filter((r) => !r.slip);
      stats.slips = slips;
      stats.cleanErr = round1(mean(cleanHits.map((r) => r.err)));
      // Expected error if the assistant applies the correction model.
      stats.fitResidual = round1(mean(cleanHits.map((r) => r.resid)));
      const corrText =
        `aim_x = intended_x - (${absolute.x.b} + ${absolute.x.m}*(intended_x - 50)); ` +
        `aim_y = intended_y - (${absolute.y.b} + ${absolute.y.m}*(intended_y - 50))`;

      const diagnostics = calibDiagnostics(canvas);
      const round = _calib.round;

      // Clean the board: remove targets AND the assistant's marks, off the
      // record. keep=true leaves everything visible (e.g. for a screenshot);
      // the next calibrate_start still starts from a clean slate.
      if (args.keep) {
        _calib.keptMarks = marks; // swept by the next calibrate_start
      } else {
        calibCleanup(canvas);
        historySuspend(() => marks.forEach((o) => canvas.remove(o)));
      }
      canvas.requestRenderAll();

      const summary = { ok: true, round, stats, perTarget, text: textReport, correction, absolute, diagnostics };

      // Persist the ABSOLUTE model so future voice sessions start pre-calibrated
      // (voice.js injects it as a context note right after connecting). Store on
      // every round with enough inliers — gating on zero slips froze the stored
      // model whenever reading was noisy, so a bad model could never heal; with
      // composition each round's residual pulls the model back toward truth.
      if (hits.length - slips >= 5) {
        try {
          localStorage.setItem('sw_voicecal', JSON.stringify({ corrText, absolute, measured: correction, stats, round, when: Date.now() }));
        } catch (e) { /* storage unavailable — session-only calibration */ }
      }

      // Report card in the output panel — copy/paste-able for debugging.
      const rows = perTarget.map((r, i) =>
        r.hit
          ? `<tr><td>#${i + 1} (${r.target.x},${r.target.y})</td><td>(${r.hit.x},${r.hit.y})</td><td>${r.dx}, ${r.dy}</td><td>${r.err}${r.slip ? ' ⚠ slip' : ''}</td></tr>`
          : `<tr><td>#${i + 1} (${r.target.x},${r.target.y})</td><td colspan="3">missed (no mark)</td></tr>`
      ).join('');
      appendToOutput(
        `<b>🎯 Voice-agent calibration — round ${round}</b><br>` +
        `<table border="1" cellpadding="3" style="border-collapse:collapse;font-size:12px;margin:4px 0">` +
        `<tr><th>target %</th><th>placed %</th><th>Δx, Δy</th><th>err</th></tr>${rows}</table>` +
        `Bias (robust): Δx=${correction.x.b}, Δy=${correction.y.b} · clean err ${stats.cleanErr} · after-correction ~${stats.fitResidual} · ${slips} slipped · raw mean ${stats.meanErr} · max ${stats.maxErr} (percent units)<br>` +
        `Correction model: <code>${corrText}</code><br>` +
        (textReport
          ? `Text: center off (${textReport.centerOffset.dx}, ${textReport.centerOffset.dy}), ` +
            `${textReport.fitsInBox ? 'fits in box ✔' : 'OVERFLOWS box ✘'}, height ${textReport.heightVsBox} of box<br>`
          : 'Text: no CAL text was placed<br>') +
        `<pre style="font-size:11px;white-space:pre-wrap;margin:4px 0">${JSON.stringify({ stats, correction: { measured: correction, absolute }, text: textReport, diagnostics }, null, 1)}</pre>`
      );

      summary.advice = slips > 0
        ? `${slips} mark(s) landed far off the trend of your other marks — misreads, not bias. Remember: strong numbered lines are the 10s, thin faint lines are the 5s (15, 25...), and a target can sit anywhere between lines — read to the nearest 1. To retry you MUST call calibrate_start FIRST (it lays out NEW random targets; these are now stale), then immediately draw fresh marks yourself with fromVideo=true and check again (max 3 rounds).`
        : (stats.meanErr <= 1.5
          ? `Excellent — mean error ${stats.meanErr}%. Calibration is stored and applied automatically whenever you pass fromVideo=true on a drawing tool. Briefly tell the user the mean error.`
          : `A systematic distortion in your grid reading was measured and STORED (residual error ${stats.meanErr}% this round, expected ~${stats.fitResidual}% next). It is applied automatically whenever you pass fromVideo=true on a drawing tool — never do correction math yourself. To verify, call calibrate_start FIRST (new targets), then immediately draw the marks yourself with fromVideo=true (max 3 rounds).`);
      return summary;
    }
    case 'clear_board': {
      clearCanvas(canvas);
      return { ok: true };
    }
    default:
      return { error: 'unknown action: ' + name };
  }
}
