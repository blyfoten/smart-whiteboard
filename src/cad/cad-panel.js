// src/cad/cad-panel.js — the CAD side panel: solve status & DOF, named
// parameters (editable expressions), and the constraint list (deletable).
//
// The panel is created lazily on first open and re-rendered on every sketch
// change (via onCadChanged). It is pure DOM — the sketch model and all
// mutations live in cad-mode.js / sketch.js.

import {
  getSketch, getSolveStatus, onCadChanged, removeConstraintById, render as renderCad,
} from './cad-mode.js';
import { solveSketch } from './solver.js';

let _panel = null;
let _open = false;

const CONSTRAINT_LABELS = {
  horizontal: 'Horizontal', vertical: 'Vertical', parallel: 'Parallel',
  perpendicular: 'Perpendicular', equal: 'Equal', pointOnLine: 'Point on line',
  fix: 'Fixed point', distance: 'Distance', radius: 'Radius', angle: 'Angle',
};

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function describeConstraint(c) {
  const base = CONSTRAINT_LABELS[c.type] || c.type;
  if (c.expr !== undefined) return `${base} = ${c.expr}`;
  return base;
}

function statusRow() {
  const sketch = getSketch();
  const status = getSolveStatus();
  const row = el('div', 'cad-status');
  if (sketch.isEmpty()) {
    row.textContent = 'Empty sketch — draw in CAD mode to add geometry.';
    return row;
  }
  const dof = sketch.degreesOfFreedom();
  if (!status.ok) {
    row.classList.add('cad-status-bad');
    row.textContent = `⚠ Constraints conflict (residual ${status.maxResidual.toFixed(2)}) — delete one below.`;
  } else if (dof <= 0) {
    row.classList.add('cad-status-good');
    row.textContent = '✓ Fully constrained';
  } else {
    row.textContent = `✓ Solved — ${dof} degree${dof === 1 ? '' : 's'} of freedom left`;
  }
  return row;
}

function resolveAndRefresh() {
  const sketch = getSketch();
  if (!sketch.isEmpty()) solveSketch(sketch);
  renderCad();
  refresh();
}

function paramsSection() {
  const sketch = getSketch();
  const scope = sketch.paramScope();
  const sec = el('div', 'cad-section');
  sec.appendChild(el('div', 'cad-section-title', 'Parameters'));

  sketch.params.forEach((p) => {
    const row = el('div', 'cad-row');
    row.appendChild(el('span', 'cad-param-name', p.name));

    const input = document.createElement('input');
    input.className = 'cad-param-input';
    input.value = p.expr;
    input.title = 'Expression (may reference earlier parameters)';
    input.addEventListener('change', () => {
      sketch.setParam(p.name, input.value);
      resolveAndRefresh();
    });
    row.appendChild(input);

    const val = scope[p.name];
    row.appendChild(el('span', 'cad-param-value', Number.isFinite(val) ? `= ${+val.toFixed(3)}` : '= ?'));

    const del = el('button', 'cad-del', '✕');
    del.title = 'Delete parameter';
    del.addEventListener('click', () => {
      sketch.removeParam(p.name);
      resolveAndRefresh();
    });
    row.appendChild(del);
    sec.appendChild(row);
  });

  const addRow = el('div', 'cad-row');
  const name = document.createElement('input');
  name.className = 'cad-param-name-input';
  name.placeholder = 'name';
  const expr = document.createElement('input');
  expr.className = 'cad-param-input';
  expr.placeholder = 'value or expression';
  const add = el('button', 'cad-add', '+ Add');
  add.addEventListener('click', () => {
    const n = name.value.trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) return;
    sketch.setParam(n, expr.value.trim() || '0');
    resolveAndRefresh();
  });
  addRow.appendChild(name);
  addRow.appendChild(expr);
  addRow.appendChild(add);
  sec.appendChild(addRow);
  return sec;
}

function constraintsSection() {
  const sketch = getSketch();
  const sec = el('div', 'cad-section');
  sec.appendChild(el('div', 'cad-section-title', `Constraints (${sketch.constraints.length})`));
  if (!sketch.constraints.length) {
    sec.appendChild(el('div', 'cad-empty', 'None yet — select geometry and use the toolbar.'));
    return sec;
  }
  sketch.constraints.forEach((c) => {
    const row = el('div', 'cad-row');
    row.appendChild(el('span', 'cad-con-label', describeConstraint(c)));
    const del = el('button', 'cad-del', '✕');
    del.title = 'Delete constraint';
    del.addEventListener('click', () => removeConstraintById(c.id));
    row.appendChild(del);
    sec.appendChild(row);
  });
  return sec;
}

function refresh() {
  if (!_panel || !_open) return;
  _panel.innerHTML = '';
  const header = el('div', 'cad-panel-header');
  header.appendChild(el('span', null, '📐 CAD sketch'));
  const close = el('button', 'cad-del', '✕');
  close.title = 'Close panel';
  close.addEventListener('click', () => toggleCadPanel(false));
  header.appendChild(close);
  _panel.appendChild(header);
  _panel.appendChild(statusRow());
  _panel.appendChild(paramsSection());
  _panel.appendChild(constraintsSection());
}

function ensurePanel() {
  if (_panel) return _panel;
  _panel = el('div');
  _panel.id = 'cad-panel';
  _panel.classList.add('hidden');
  const container = document.getElementById('container') || document.body;
  container.appendChild(_panel);
  return _panel;
}

export function isCadPanelOpen() {
  return _open;
}

export function toggleCadPanel(force) {
  const panel = ensurePanel();
  _open = force !== undefined ? !!force : !_open;
  panel.classList.toggle('hidden', !_open);
  if (_open) refresh();
}

export function initCadPanel() {
  onCadChanged(refresh);
}
