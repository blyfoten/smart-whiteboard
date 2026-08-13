// src/draw-settings.js — pen/shape drawing settings (color, fill, corners).
//
// One active stroke colour applies to both the freehand pen and recognized smart
// shapes (shapes inherit the brush colour). Shapes additionally have a fill
// colour + opacity and a corner radius. Persisted in a cookie.

import { getCanvas } from './canvas.js';
import { getCookie, setCookie } from './state.js';

const COOKIE = 'sw_draw';

const state = {
  color: '#111111',     // stroke (pen + shape outline)
  fill: 'none',         // shape fill: 'none' or a hex colour
  fillOpacity: 0.3,
  cornerRadius: 0,      // rounded-rectangle radius (px)
  lineStyle: 'solid',   // 'solid' | 'dashed' | 'dotted' (pen + shape outline)
  snapMove: 'off',      // align a moved selection to other objects ('on'/'off')
  snapNodeOrtho: 'off', // snap a dragged node so a near-ortho segment goes H/V
};

// The strokeDashArray for a line style at a given stroke width (null = solid).
export function dashArrayFor(style, strokeWidth = 5) {
  const w = Math.max(1, strokeWidth);
  if (style === 'dashed') return [w * 3, w * 2];
  if (style === 'dotted') return [Math.max(1, w * 0.4), w * 1.9];
  return null;
}

function save() {
  setCookie(COOKIE, JSON.stringify(state));
}

export function getDrawColor() { return state.color; }
export function setDrawColor(c) { state.color = c; applyBrush(); save(); }

export function getShapeFill() { return state.fill; }
export function setShapeFill(c) { state.fill = c; save(); }

export function getFillOpacity() { return state.fillOpacity; }
export function setFillOpacity(v) { state.fillOpacity = Math.max(0, Math.min(1, v)); save(); }

export function getCornerRadius() { return state.cornerRadius; }
export function setCornerRadius(v) { state.cornerRadius = Math.max(0, v); save(); }

export function getLineStyle() { return state.lineStyle; }
export function setLineStyle(v) {
  if (['solid', 'dashed', 'dotted'].includes(v)) { state.lineStyle = v; applyBrush(); save(); }
}

export function getSnapMove() { return state.snapMove; }
export function setSnapMove(v) { state.snapMove = v; save(); }

export function getSnapNodeOrtho() { return state.snapNodeOrtho; }
export function setSnapNodeOrtho(v) { state.snapNodeOrtho = v; save(); }

export function applyBrush() {
  const c = getCanvas();
  if (c && c.freeDrawingBrush) {
    c.freeDrawingBrush.color = state.color;
    c.freeDrawingBrush.strokeDashArray = dashArrayFor(state.lineStyle, c.freeDrawingBrush.width || 5);
  }
}

function hexToRgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// The fill to give a recognized shape: '' (transparent) when none, else rgba.
export function computedShapeFill() {
  if (!state.fill || state.fill === 'none') return '';
  return hexToRgba(state.fill, state.fillOpacity);
}

export function initDrawSettings() {
  try {
    const saved = JSON.parse(getCookie(COOKIE) || '{}');
    Object.assign(state, saved);
  } catch (e) { /* ignore */ }
  applyBrush();
}
