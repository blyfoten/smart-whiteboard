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
  const place = (obj) => {
    canvas.add(obj);
    canvas.requestRenderAll();
    return { ok: true, id: ensureId(obj) };
  };

  switch (name) {
    case 'draw_line': {
      const a = pctToScene(canvas, args.x1, args.y1);
      const b = pctToScene(canvas, args.x2, args.y2);
      const s = styleOf(args);
      return place(new Line([a.x, a.y, b.x, b.y], { stroke: s.color, strokeWidth: s.strokeWidth, _isShape: true }));
    }
    case 'draw_rect': {
      const p = pctToScene(canvas, args.x, args.y);
      const sz = pctLen(canvas, num(args.width, 10), num(args.height, 10));
      const s = styleOf(args);
      return place(new Rect({ left: p.x, top: p.y, width: sz.w, height: sz.h, rx: s.cornerRadius, ry: s.cornerRadius, fill: s.fill || 'transparent', stroke: s.color, strokeWidth: s.strokeWidth, _isShape: true }));
    }
    case 'draw_ellipse': {
      const p = pctToScene(canvas, args.x, args.y);
      const sz = pctLen(canvas, num(args.width, 10), num(args.height, 10));
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
      const p = pctToScene(canvas, args.x, args.y);
      const fontSize = Math.max(10, pctLen(canvas, 0, num(args.size, 6)).h);
      const color = args.color ? String(args.color) : STROKE;
      return place(new IText(String(args.text || ''), { left: p.x, top: p.y, fill: color, fontSize, fontFamily: 'Caveat, cursive' }));
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
      return { ok: true, id: ensureId(o) };
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
      return { ok: true, id: ensureId(o) };
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
    case 'clear_board': {
      clearCanvas(canvas);
      return { ok: true };
    }
    default:
      return { error: 'unknown action: ' + name };
  }
}
