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
import { Line, Rect, Ellipse, IText, Path } from 'fabric';
import { renderGraph } from './graph.js';
import { extractEquation, solveToBoard } from './api.js';
import { getCurrentModel } from './ui.js';

const STROKE = 'black';
const STROKE_WIDTH = 4;

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
      return place(new Line([a.x, a.y, b.x, b.y], { stroke: STROKE, strokeWidth: STROKE_WIDTH }));
    }
    case 'draw_rect': {
      const p = pctToScene(canvas, args.x, args.y);
      const s = pctLen(canvas, num(args.width, 10), num(args.height, 10));
      return place(new Rect({ left: p.x, top: p.y, width: s.w, height: s.h, fill: 'transparent', stroke: STROKE, strokeWidth: STROKE_WIDTH }));
    }
    case 'draw_ellipse': {
      const p = pctToScene(canvas, args.x, args.y);
      const s = pctLen(canvas, num(args.width, 10), num(args.height, 10));
      return place(new Ellipse({ left: p.x, top: p.y, rx: s.w / 2, ry: s.h / 2, fill: 'transparent', stroke: STROKE, strokeWidth: STROKE_WIDTH }));
    }
    case 'draw_arrow': {
      const a = pctToScene(canvas, args.x1, args.y1);
      const b = pctToScene(canvas, args.x2, args.y2);
      return place(new Path(arrowPath(a, b), { stroke: STROKE, strokeWidth: STROKE_WIDTH, fill: '' }));
    }
    case 'write_text': {
      const p = pctToScene(canvas, args.x, args.y);
      const fontSize = Math.max(10, pctLen(canvas, 0, num(args.size, 6)).h);
      return place(new IText(String(args.text || ''), { left: p.x, top: p.y, fill: STROKE, fontSize, fontFamily: 'Caveat, cursive' }));
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
      if (data.success) { renderGraph(data.data, 'y'); return { ok: true, points: data.data.length }; }
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
