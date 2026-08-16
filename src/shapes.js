// src/shapes.js — turn a classified stroke descriptor into a tidy Fabric object.
//
// Pure geometry/classification lives in shape-classifier.js (no Fabric, unit
// tested). This module owns only the Fabric object construction.

import { Rect, Ellipse, Path, Polyline, Polygon } from 'fabric';
import { classifyStroke, pathToPoints } from './shape-classifier.js';
import { enablePointEditing } from './node-edit.js';
import { dashArrayFor } from './draw-settings.js';

export { pathToPoints };

// A straight or multi-segment stroke becomes a Polyline/Polygon with draggable
// vertices. `closed` true → a Polygon (closed loop), else an open Polyline.
export function buildPoly(points, opts, closed) {
  const Ctor = closed ? Polygon : Polyline;
  const poly = new Ctor(points, {
    stroke: opts.color,
    strokeWidth: opts.strokeWidth,
    fill: opts.fill || '',
    strokeDashArray: opts.dashArray || null,
    strokeLineJoin: 'round',
    strokeLineCap: 'round',
    objectCaching: false,
  });
  enablePointEditing(poly);
  return poly;
}

// Append the two wing points of an arrowhead to an open polyline's point list:
// [..., tip] -> [..., tip, w1, tip, w2]. The polyline then renders shaft + V
// head as one editable object (the wings get node handles too).
export function withArrowhead(points) {
  const n = points.length;
  if (n < 2) return points;
  const tip = points[n - 1];
  const prev = points[n - 2];
  const segLen = Math.hypot(tip.x - prev.x, tip.y - prev.y);
  const ang = Math.atan2(tip.y - prev.y, tip.x - prev.x);
  const len = Math.max(10, Math.min(26, 0.35 * segLen));
  const th = (28 * Math.PI) / 180;
  const w1 = { x: tip.x - len * Math.cos(ang - th), y: tip.y - len * Math.sin(ang - th) };
  const w2 = { x: tip.x - len * Math.cos(ang + th), y: tip.y - len * Math.sin(ang + th) };
  return [...points, w1, { x: tip.x, y: tip.y }, w2];
}

function dist(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function buildArrowPath(a, b, opts) {
  const angle = Math.atan2(b.y - a.y, b.x - a.x);
  const len = dist(a, b);
  const headLen = Math.max(10, Math.min(28, len * 0.25));
  const θ = (28 * Math.PI) / 180;
  const h1 = { x: b.x - headLen * Math.cos(angle - θ), y: b.y - headLen * Math.sin(angle - θ) };
  const h2 = { x: b.x - headLen * Math.cos(angle + θ), y: b.y - headLen * Math.sin(angle + θ) };
  const d =
    `M ${a.x} ${a.y} L ${b.x} ${b.y} ` +
    `L ${h1.x} ${h1.y} M ${b.x} ${b.y} L ${h2.x} ${h2.y}`;
  return new Path(d, { stroke: opts.color, strokeWidth: opts.strokeWidth, fill: '', strokeDashArray: opts.dashArray || null });
}

// A clean circular arc, rendered as a single SVG arc-path segment.
function buildArcPath(cx, cy, r, startAngle, endAngle, opts) {
  const x1 = cx + r * Math.cos(startAngle);
  const y1 = cy + r * Math.sin(startAngle);
  const x2 = cx + r * Math.cos(endAngle);
  const y2 = cy + r * Math.sin(endAngle);
  const sweep = endAngle - startAngle;
  const largeArc = Math.abs(sweep) > Math.PI ? 1 : 0;
  const sweepFlag = sweep > 0 ? 1 : 0;
  const d = `M ${x1} ${y1} A ${r} ${r} 0 ${largeArc} ${sweepFlag} ${x2} ${y2}`;
  return new Path(d, {
    stroke: opts.color,
    strokeWidth: opts.strokeWidth,
    fill: '',
    strokeDashArray: opts.dashArray || null,
    strokeLineCap: 'round',
  });
}

// recognizeStroke(points, { strokeWidth, color, fill, cornerRadius }) -> { shape, type } | null
export function recognizeStroke(pts, opts = {}) {
  const desc = classifyStroke(pts);
  if (!desc) return null;

  const strokeWidth = opts.strokeWidth || 5;
  const color = opts.color || 'black';
  const fill = opts.fill || '';              // '' = transparent
  const radius = Math.max(0, opts.cornerRadius || 0);
  const dashArray = dashArrayFor(opts.lineStyle || 'solid', strokeWidth);
  const common = { stroke: color, strokeWidth, fill, strokeDashArray: dashArray };

  switch (desc.type) {
    case 'line': {
      // Lines/arrows are never filled. An arrowEnd (hand-drawn V at the tip)
      // becomes wing points appended to the editable polyline.
      let pts2 = [{ x: desc.a.x, y: desc.a.y }, { x: desc.b.x, y: desc.b.y }];
      if (desc.arrowEnd) pts2 = withArrowhead(pts2);
      return {
        type: desc.arrowEnd ? 'arrow' : 'line',
        shape: buildPoly(pts2, { color, strokeWidth, fill: '', dashArray }, false),
      };
    }
    case 'polyline': {
      const pts2 = desc.arrowEnd ? withArrowhead(desc.points) : desc.points;
      return { type: 'polyline', arrowEnd: !!desc.arrowEnd, shape: buildPoly(pts2, { color, strokeWidth, fill: '', dashArray }, false) };
    }
    case 'polygon':
      return { type: 'polygon', shape: buildPoly(desc.points, { color, strokeWidth, fill, dashArray }, true) };
    case 'arrow':
      return { type: 'arrow', shape: buildArrowPath(desc.a, desc.b, { color, strokeWidth, dashArray }) };
    case 'arc':
      return {
        type: 'arc',
        shape: buildArcPath(desc.cx, desc.cy, desc.r, desc.startAngle, desc.endAngle, { color, strokeWidth, dashArray }),
      };
    case 'circle':
    case 'ellipse':
      return {
        type: desc.type,
        shape: new Ellipse({
          left: desc.cx - desc.rx,
          top: desc.cy - desc.ry,
          rx: desc.rx,
          ry: desc.ry,
          ...common,
        }),
      };
    case 'rect':
      return {
        type: 'rect',
        shape: new Rect({ left: desc.x, top: desc.y, width: desc.w, height: desc.h, rx: radius, ry: radius, ...common }),
      };
    default:
      return null;
  }
}
