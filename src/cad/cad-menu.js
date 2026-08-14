// src/cad/cad-menu.js — a floating context menu next to the current CAD
// selection (the CAD-mode sibling of equation-menu.js): tap sketch geometry
// and the relevant constraint/dimension actions pop up right there, instead
// of only living in the sub-toolbar.
//
// Content-aware: one line offers H/V toggles + a length dimension; two lines
// add perpendicular/parallel/equal and an angle dimension; circles offer
// radius/equal; points offer fix/merge/distance; a point + a line offers
// point-on-line. H, V and Fix act as toggles (active chip = constraint
// present; clicking again removes it). Constraint errors flash in the menu.

import { getCanvas } from '../canvas.js';
import { getMode } from '../modes.js';
import {
  getCadSelection, selectionDetails, applyConstraint, removeAxisFromSelection,
  addDimension, deleteCadSelection, clearCadSelection, onCadChanged, formatValue,
} from './cad-mode.js';

let menuEl = null;
let onAfterRender = null;
let msgTimer = null;

function button(label, title, handler, className) {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = title;
  if (className) b.className = className;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    handler();
  });
  return b;
}

// Flash a validation message (e.g. "Select exactly two lines.") in the menu.
function flash(text) {
  if (!menuEl || !text) return;
  let msg = menuEl.querySelector('.cm-msg');
  if (!msg) {
    msg = document.createElement('div');
    msg.className = 'cm-msg';
    menuEl.appendChild(msg);
  }
  msg.textContent = text;
  clearTimeout(msgTimer);
  msgTimer = setTimeout(() => { if (msg.parentNode) msg.remove(); positionMenu(); }, 2500);
  positionMenu();
}

// Run a command that returns null | error-string. On success the selection
// clears and the menu closes itself via the change event; on error it stays
// open and shows why.
function run(fn) {
  const err = fn();
  if (err) flash(err);
}

// Scene-space bounding box of the selected geometry.
function selectionBounds(d) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  const grow = (x, y) => {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  };
  d.points.forEach((p) => grow(p.x, p.y));
  d.lines.forEach((l) => {
    const a = d.sketch.point(l.p1);
    const b = d.sketch.point(l.p2);
    if (a) grow(a.x, a.y);
    if (b) grow(b.x, b.y);
  });
  d.circles.forEach((c) => {
    const ctr = d.sketch.point(c.c);
    if (ctr) {
      grow(ctr.x - c.r, ctr.y - c.r);
      grow(ctr.x + c.r, ctr.y + c.r);
    }
  });
  return minX === Infinity ? null : { minX, minY, maxX, maxY };
}

function positionMenu() {
  const canvas = getCanvas();
  if (!canvas || !menuEl) return;
  const d = selectionDetails();
  const bb = selectionBounds(d);
  if (!bb) return;
  const t = canvas.viewportTransform || [1, 0, 0, 1, 0, 0];
  const canvasRect = canvas.upperCanvasEl.getBoundingClientRect();
  const sx = (x) => canvasRect.left + x * t[0] + t[4];
  const sy = (y) => canvasRect.top + y * t[3] + t[5];
  const left = sx(bb.minX);
  const above = sy(bb.minY) - menuEl.offsetHeight - 12;
  const top = above > 8 ? above : sy(bb.maxY) + 12;
  const maxLeft = window.innerWidth - menuEl.offsetWidth - 8;
  menuEl.style.left = `${Math.max(8, Math.min(left, maxLeft))}px`;
  menuEl.style.top = `${top}px`;
}

function hideMenu() {
  const canvas = getCanvas();
  if (canvas && onAfterRender) canvas.off('after:render', onAfterRender);
  onAfterRender = null;
  clearTimeout(msgTimer);
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
  }
}

// What is selected, in words — the menu's little context label.
function selectionLabel(d) {
  const parts = [];
  if (d.lines.length) parts.push(`${d.lines.length} line${d.lines.length > 1 ? 's' : ''}`);
  if (d.circles.length) parts.push(`${d.circles.length} circle${d.circles.length > 1 ? 's' : ''}`);
  if (d.points.length) parts.push(`${d.points.length} point${d.points.length > 1 ? 's' : ''}`);
  return parts.join(' + ');
}

function buildMenu() {
  const d = selectionDetails();
  const nLines = d.lines.length;
  const nCircles = d.circles.length;
  const nPoints = d.points.length;

  menuEl = document.createElement('div');
  menuEl.id = 'cad-menu';
  const row = document.createElement('div');
  row.className = 'cm-row';
  menuEl.appendChild(row);

  const label = document.createElement('span');
  label.className = 'cm-label';
  label.textContent = selectionLabel(d);
  row.appendChild(label);

  // H / V — toggles on any selection of lines.
  if (nLines) {
    row.appendChild(button('▬ H', d.allHorizontal ? 'Remove horizontal constraint' : 'Make horizontal',
      () => run(() => (d.allHorizontal ? removeAxisFromSelection('horizontal') : applyConstraint('horizontal'))),
      d.allHorizontal ? 'active' : ''));
    row.appendChild(button('▮ V', d.allVertical ? 'Remove vertical constraint' : 'Make vertical',
      () => run(() => (d.allVertical ? removeAxisFromSelection('vertical') : applyConstraint('vertical'))),
      d.allVertical ? 'active' : ''));
  }

  // Pairwise line constraints.
  if (nLines === 2 && !nCircles && !nPoints) {
    row.appendChild(button('⟂', 'Make perpendicular', () => run(() => applyConstraint('perpendicular'))));
    row.appendChild(button('∥', 'Make parallel', () => run(() => applyConstraint('parallel'))));
  }
  if ((nLines >= 2 && !nCircles) || (nCircles >= 2 && !nLines)) {
    row.appendChild(button('=', nCircles ? 'Equal radius' : 'Equal length', () => run(() => applyConstraint('equal'))));
  }

  // Coincidence: merge two points, or stick a point onto a line.
  if (nPoints === 2 && !nLines && !nCircles) {
    row.appendChild(button('⌖', 'Merge into one point (coincident)', () => run(() => applyConstraint('coincident'))));
  }
  if (nPoints === 1 && nLines === 1 && !nCircles) {
    row.appendChild(button('⌖', 'Put the point on the line', () => run(() => applyConstraint('coincident'))));
  }

  // Fix — toggle on any selection of points.
  if (nPoints) {
    row.appendChild(button('📌', d.allFixed ? 'Unfix point(s)' : 'Fix point(s) in place',
      () => run(() => applyConstraint('fix')), d.allFixed ? 'active' : ''));
  }

  // Dimensions — labelled with the current measured value.
  if (nLines === 1 && !nCircles && !nPoints) {
    const len = d.sketch.lineLength(d.lines[0]);
    row.appendChild(button(`📏 ${formatValue(len)}`, 'Dimension: length (number or expression)', () => run(() => addDimension())));
  } else if (nPoints === 2 && !nLines && !nCircles) {
    const [p, q] = d.points;
    const dist = Math.hypot(q.x - p.x, q.y - p.y);
    row.appendChild(button(`📏 ${formatValue(dist)}`, 'Dimension: distance between the points', () => run(() => addDimension())));
  } else if (nCircles === 1 && !nLines && !nPoints) {
    row.appendChild(button(`📏 R${formatValue(d.circles[0].r)}`, 'Dimension: radius', () => run(() => addDimension())));
  } else if (nLines === 2 && !nCircles && !nPoints) {
    row.appendChild(button(`∠ ${formatValue(d.measuredAngle)}°`, 'Dimension: angle between the lines', () => run(() => addDimension())));
  }

  row.appendChild(button('🗑', 'Delete selected geometry (Del)', () => deleteCadSelection(), 'cm-del'));
  row.appendChild(button('✕', 'Dismiss (Esc)', () => clearCadSelection(), 'cm-close'));

  document.body.appendChild(menuEl);
}

// Re-evaluate on every CAD change: selection edited, mode switched, solve run.
function refresh() {
  const canvas = getCanvas();
  if (!canvas) return;
  const hasSelection = getCadSelection().length > 0;
  if (getMode() !== 'cad' || !hasSelection) {
    hideMenu();
    return;
  }
  hideMenu();
  buildMenu();
  positionMenu();
  onAfterRender = positionMenu; // stay glued through pan/zoom
  canvas.on('after:render', onAfterRender);
}

export function initCadMenu() {
  onCadChanged(refresh);
}
