// src/canvas-actions.js — execute assistant tool calls against the Fabric canvas.
//
// The voice assistant (Gemini Live) calls these via function-calling. All
// positions/sizes are percentages (0-100) of the visible board, origin top-left,
// converted here to scene coordinates (so it works under zoom/pan). Object
// targeting for erase/move/resize is spatial: find the object at a given point.

import { getCanvas, clearCanvas } from './canvas.js';
import { Line, Rect, Ellipse, IText, Path } from 'fabric';
import { renderGraph } from './graph.js';

const STROKE = 'black';
const STROKE_WIDTH = 4;

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

function arrowPath(a, b) {
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const len = Math.hypot(b.x - a.x, b.y - a.y);
  const hl = Math.max(10, Math.min(30, len * 0.25));
  const th = (28 * Math.PI) / 180;
  const h1 = { x: b.x - hl * Math.cos(ang - th), y: b.y - hl * Math.sin(ang - th) };
  const h2 = { x: b.x - hl * Math.cos(ang + th), y: b.y - hl * Math.sin(ang + th) };
  return `M ${a.x} ${a.y} L ${b.x} ${b.y} L ${h1.x} ${h1.y} M ${b.x} ${b.y} L ${h2.x} ${h2.y}`;
}

// executeAction(name, args) -> Promise<result>. Result is a small JSON object
// echoed back to the model so it knows the call succeeded/failed.
export async function executeAction(name, args = {}) {
  const canvas = getCanvas();
  if (!canvas) return { error: 'canvas not available' };
  const add = (obj) => { canvas.add(obj); canvas.requestRenderAll(); };

  switch (name) {
    case 'draw_line': {
      const a = pctToScene(canvas, args.x1, args.y1);
      const b = pctToScene(canvas, args.x2, args.y2);
      add(new Line([a.x, a.y, b.x, b.y], { stroke: STROKE, strokeWidth: STROKE_WIDTH }));
      return { ok: true };
    }
    case 'draw_rect': {
      const p = pctToScene(canvas, args.x, args.y);
      const s = pctLen(canvas, num(args.width, 10), num(args.height, 10));
      add(new Rect({ left: p.x, top: p.y, width: s.w, height: s.h, fill: 'transparent', stroke: STROKE, strokeWidth: STROKE_WIDTH }));
      return { ok: true };
    }
    case 'draw_ellipse': {
      const p = pctToScene(canvas, args.x, args.y);
      const s = pctLen(canvas, num(args.width, 10), num(args.height, 10));
      add(new Ellipse({ left: p.x, top: p.y, rx: s.w / 2, ry: s.h / 2, fill: 'transparent', stroke: STROKE, strokeWidth: STROKE_WIDTH }));
      return { ok: true };
    }
    case 'draw_arrow': {
      const a = pctToScene(canvas, args.x1, args.y1);
      const b = pctToScene(canvas, args.x2, args.y2);
      add(new Path(arrowPath(a, b), { stroke: STROKE, strokeWidth: STROKE_WIDTH, fill: '' }));
      return { ok: true };
    }
    case 'write_text': {
      const p = pctToScene(canvas, args.x, args.y);
      const fontSize = Math.max(10, pctLen(canvas, 0, num(args.size, 6)).h);
      add(new IText(String(args.text || ''), { left: p.x, top: p.y, fill: STROKE, fontSize, fontFamily: 'Caveat, cursive' }));
      return { ok: true };
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
    case 'erase_at': {
      const o = findObjectAt(canvas, pctToScene(canvas, args.x, args.y));
      if (!o) return { ok: false, message: 'no object at that location' };
      canvas.remove(o);
      canvas.requestRenderAll();
      return { ok: true };
    }
    case 'move_object': {
      const o = findObjectAt(canvas, pctToScene(canvas, args.x, args.y));
      if (!o) return { ok: false, message: 'no object at that location' };
      const d = pctLen(canvas, args.dx, args.dy);
      o.set({ left: o.left + d.w, top: o.top + d.h });
      o.setCoords();
      canvas.requestRenderAll();
      return { ok: true };
    }
    case 'scale_object': {
      const o = findObjectAt(canvas, pctToScene(canvas, args.x, args.y));
      if (!o) return { ok: false, message: 'no object at that location' };
      const f = num(args.factor, 1);
      if (f > 0) {
        o.set({ scaleX: (o.scaleX || 1) * f, scaleY: (o.scaleY || 1) * f });
        o.setCoords();
        canvas.requestRenderAll();
      }
      return { ok: true };
    }
    case 'get_objects': {
      const objects = canvas.getObjects()
        .filter((o) => o.selectable !== false && !o._isGhost)
        .map((o, i) => {
          const r = o.getBoundingRect();
          const tl = sceneToPct(canvas, r.left, r.top);
          const br = sceneToPct(canvas, r.left + r.width, r.top + r.height);
          const out = {
            index: i,
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
    case 'duplicate_object': {
      const o = findObjectAt(canvas, pctToScene(canvas, args.x, args.y));
      if (!o) return { ok: false, message: 'no object at that location' };
      const d = pctLen(canvas, args.dx, args.dy);
      const cloned = await o.clone();
      cloned.set({ left: o.left + d.w, top: o.top + d.h, evented: true, selectable: true });
      cloned.setCoords();
      canvas.add(cloned);
      canvas.requestRenderAll();
      return { ok: true };
    }
    case 'clear_board': {
      clearCanvas(canvas);
      return { ok: true };
    }
    default:
      return { error: 'unknown action: ' + name };
  }
}
