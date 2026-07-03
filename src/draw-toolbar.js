// src/draw-toolbar.js — contextual sub-toolbar below the top bar.
//
// Re-clicking the active Draw or Shapes mode button toggles this bar. It shows
// colour swatches + a picker (both modes), and for Shapes also fill colour /
// opacity and corner radius.

import {
  getDrawColor, setDrawColor,
  getShapeFill, setShapeFill,
  getFillOpacity, setFillOpacity,
  getCornerRadius, setCornerRadius,
  getLineStyle, setLineStyle,
  getSnapMove, setSnapMove,
  getSnapNodeOrtho, setSnapNodeOrtho,
} from './draw-settings.js';

const LINE_STYLES = [
  { key: 'solid', label: '—', title: 'Solid line' },
  { key: 'dashed', label: '– –', title: 'Dashed line' },
  { key: 'dotted', label: '· · ·', title: 'Dotted line' },
];

const SWATCHES = [
  { name: 'Black', value: '#111111' },
  { name: 'Red', value: '#e53935' },
  { name: 'Green', value: '#2e7d32' },
  { name: 'Blue', value: '#1565c0' },
];

let _mode = null;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function colorRow() {
  const group = el('div', 'sub-group');
  group.appendChild(el('span', 'sub-label', 'Color'));
  const current = (getDrawColor() || '').toLowerCase();
  SWATCHES.forEach((s) => {
    const sw = el('button', 'swatch' + (s.value.toLowerCase() === current ? ' active' : ''));
    sw.style.background = s.value;
    sw.title = s.name;
    sw.addEventListener('click', () => { setDrawColor(s.value); render(_mode); });
    group.appendChild(sw);
  });
  const picker = document.createElement('input');
  picker.type = 'color';
  picker.className = 'sub-picker';
  picker.title = 'Custom colour';
  picker.value = /^#[0-9a-f]{6}$/i.test(getDrawColor()) ? getDrawColor() : '#111111';
  picker.addEventListener('input', () => { setDrawColor(picker.value); render(_mode); });
  group.appendChild(picker);

  group.appendChild(el('span', 'sub-label', 'Line'));
  LINE_STYLES.forEach((s) => {
    const chip = el('button', 'sub-chip' + (getLineStyle() === s.key ? ' active' : ''), s.label);
    chip.title = s.title;
    chip.addEventListener('click', () => { setLineStyle(s.key); render(_mode); });
    group.appendChild(chip);
  });
  return group;
}

function shapeRow() {
  const group = el('div', 'sub-group');

  group.appendChild(el('span', 'sub-label', 'Fill'));
  const none = el('button', 'sub-chip' + (getShapeFill() === 'none' ? ' active' : ''), 'None');
  none.addEventListener('click', () => { setShapeFill('none'); render(_mode); });
  group.appendChild(none);

  const fillPicker = document.createElement('input');
  fillPicker.type = 'color';
  fillPicker.className = 'sub-picker';
  fillPicker.title = 'Fill colour';
  fillPicker.value = /^#[0-9a-f]{6}$/i.test(getShapeFill()) ? getShapeFill() : '#1565c0';
  fillPicker.addEventListener('input', () => { setShapeFill(fillPicker.value); render(_mode); });
  group.appendChild(fillPicker);

  const opacity = document.createElement('input');
  opacity.type = 'range';
  opacity.min = '0'; opacity.max = '100'; opacity.value = String(Math.round(getFillOpacity() * 100));
  opacity.className = 'sub-range';
  opacity.title = 'Fill opacity';
  opacity.addEventListener('input', () => setFillOpacity(Number(opacity.value) / 100));
  group.appendChild(opacity);

  group.appendChild(el('span', 'sub-label', 'Corners'));
  const corners = document.createElement('input');
  corners.type = 'range';
  corners.min = '0'; corners.max = '40'; corners.value = String(getCornerRadius());
  corners.className = 'sub-range';
  corners.title = 'Rounded-rectangle corner radius';
  corners.addEventListener('input', () => setCornerRadius(Number(corners.value)));
  group.appendChild(corners);

  return group;
}

// A small on/off toggle chip bound to a getter/setter ('on'/'off').
function toggleChip(label, title, get, set) {
  const chip = el('button', 'sub-chip' + (get() === 'on' ? ' active' : ''), label);
  chip.title = title;
  chip.addEventListener('click', () => { set(get() === 'on' ? 'off' : 'on'); render(_mode); });
  return chip;
}

function selectRow() {
  const group = el('div', 'sub-group');
  group.appendChild(el('span', 'sub-label', 'Snap'));
  group.appendChild(toggleChip('Align', 'Align moves & resizes to other objects', getSnapMove, setSnapMove));
  group.appendChild(toggleChip('⟂ Nodes', 'Snap a dragged node so a near-straight segment becomes horizontal/vertical', getSnapNodeOrtho, setSnapNodeOrtho));
  return group;
}

function render(mode) {
  const bar = document.getElementById('sub-toolbar');
  if (!bar) return;
  bar.innerHTML = '';
  if (mode === 'select') {
    bar.appendChild(selectRow());
    return;
  }
  bar.appendChild(colorRow());
  if (mode === 'shapes') bar.appendChild(shapeRow());
}

export function isSubToolbarOpen() {
  const bar = document.getElementById('sub-toolbar');
  return !!bar && !bar.classList.contains('hidden');
}

// Open the bar (or re-render it for `mode` if already open).
export function showSubToolbar(mode) {
  const bar = document.getElementById('sub-toolbar');
  if (!bar) return;
  _mode = mode;
  render(mode);
  bar.classList.remove('hidden');
  const container = document.getElementById('container');
  if (container) container.classList.add('subbar-open');
}

// Toggle the bar for a mode. Returns true if it ended up open.
export function toggleSubToolbar(mode) {
  if (isSubToolbarOpen() && _mode === mode) {
    hideSubToolbar();
    return false;
  }
  showSubToolbar(mode);
  return true;
}

export function hideSubToolbar() {
  const bar = document.getElementById('sub-toolbar');
  if (bar) bar.classList.add('hidden');
  const container = document.getElementById('container');
  if (container) container.classList.remove('subbar-open');
  _mode = null;
}
