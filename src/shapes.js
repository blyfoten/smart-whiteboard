// src/shapes.js — turn a classified stroke descriptor into a tidy Fabric object.
//
// Pure geometry/classification lives in shape-classifier.js (no Fabric, unit
// tested). This module owns only the Fabric object construction.

import { Rect, Ellipse, Path, Polyline, Polygon } from 'fabric';
import { classifyStroke, pathToPoints } from './shape-classifier.js';
import { enablePointEditing } from './node-edit.js';

export { pathToPoints };

// A straight or multi-segment stroke becomes a Polyline/Polygon with draggable
// vertices. `closed` true → a Polygon (closed loop), else an open Polyline.
export function buildPoly(points, opts, closed) {
  const Ctor = closed ? Polygon : Polyline;
  const poly = new Ctor(points, {
    stroke: opts.color,
    strokeWidth: opts.strokeWidth,
    fill: opts.fill || '',
    strokeLineJoin: 'round',
    strokeLineCap: 'round',
    objectCaching: false,
  });
  enablePointEditing(poly);
  return poly;
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
  return new Path(d, { stroke: opts.color, strokeWidth: opts.strokeWidth, fill: '' });
}

// recognizeStroke(points, { strokeWidth, color, fill, cornerRadius }) -> { shape, type } | null
export function recognizeStroke(pts, opts = {}) {
  const desc = classifyStroke(pts);
  if (!desc) return null;

  const strokeWidth = opts.strokeWidth || 5;
  const color = opts.color || 'black';
  const fill = opts.fill || '';              // '' = transparent
  const radius = Math.max(0, opts.cornerRadius || 0);
  const common = { stroke: color, strokeWidth, fill };

  switch (desc.type) {
    case 'line':
      // Lines/arrows are never filled.
      return {
        type: 'line',
        shape: buildPoly([{ x: desc.a.x, y: desc.a.y }, { x: desc.b.x, y: desc.b.y }], { color, strokeWidth, fill: '' }, false),
      };
    case 'polyline':
      return { type: 'polyline', shape: buildPoly(desc.points, { color, strokeWidth, fill: '' }, false) };
    case 'polygon':
      return { type: 'polygon', shape: buildPoly(desc.points, { color, strokeWidth, fill }, true) };
    case 'arrow':
      return { type: 'arrow', shape: buildArrowPath(desc.a, desc.b, { color, strokeWidth }) };
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
