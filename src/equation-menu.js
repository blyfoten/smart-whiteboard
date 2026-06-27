// src/equation-menu.js — a Word-style floating action menu that appears next to
// a freshly analyzed equation. The actions are content-aware: a function like
// y = x^2 - 4x + 16 offers Plot / Solve =0 / Steps (with a choice of method when
// several apply), while a plain expression just offers Plot and Copy.

import { getCanvas } from './canvas.js';
import { drawGraph, solveToBoard, parseTypedEquation } from './api.js';
import { getCurrentModel } from './ui.js';

let menuEl = null;
let target = null;
let onAfterRender = null;

// AI actions need an LLM; math.js can't produce symbolic solutions or steps.
function aiModel() {
  const m = getCurrentModel();
  return m === 'math' ? 'gpt' : m;
}

// Crude content analysis: highest power of the independent variable → degree,
// plus whether the expression actually involves that variable.
function analyzeEquation(data) {
  const expr = String(data.expression || data.equation || '');
  const indepVar =
    (data.ranges && Object.keys(data.ranges)[0]) ||
    (data.scope && Object.keys(data.scope)[0]) ||
    'x';
  const dep = data.dependentVariable || 'y';
  const hasVar = new RegExp(`(^|[^a-zA-Z])${indepVar}([^a-zA-Z]|$)`).test(expr);

  let degree = hasVar ? 1 : 0;
  const re = new RegExp(`${indepVar}\\s*\\^\\s*(\\d+)`, 'g');
  let m;
  while ((m = re.exec(expr))) degree = Math.max(degree, parseInt(m[1], 10));

  return { expr, indepVar, dep, degree, isFunction: hasVar };
}

// Solving methods that apply to a given degree (first one is the default).
function methodsFor(degree, indepVar) {
  if (degree === 1) {
    return [{ label: `Isolate ${indepVar}`, phrase: 'isolating the variable' }];
  }
  if (degree === 2) {
    return [
      { label: 'p-q formula', phrase: 'the p-q formula' },
      { label: 'Quadratic formula', phrase: 'the quadratic formula' },
      { label: 'Completing the square', phrase: 'completing the square' },
      { label: 'Factoring', phrase: 'factoring' },
    ];
  }
  if (degree >= 3) {
    return [
      { label: 'Factoring', phrase: 'factoring' },
      { label: 'Numerical', phrase: 'a numerical method such as Newton–Raphson' },
    ];
  }
  return [];
}

function makeButton(label, title, handler, className) {
  const b = document.createElement('button');
  b.textContent = label;
  if (title) b.title = title;
  if (className) b.className = className;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    handler();
  });
  return b;
}

function positionMenu() {
  const canvas = getCanvas();
  if (!canvas || !target || !menuEl) return;
  const rect = target.getBoundingRect();
  const canvasRect = canvas.upperCanvasEl.getBoundingClientRect();
  const left = canvasRect.left + rect.left;
  const above = canvasRect.top + rect.top - menuEl.offsetHeight - 10;
  const top = above > 8 ? above : canvasRect.top + rect.top + rect.height + 10;
  const maxLeft = window.innerWidth - menuEl.offsetWidth - 8;
  menuEl.style.left = `${Math.max(8, Math.min(left, maxLeft))}px`;
  menuEl.style.top = `${top}px`;
}

export function hideEquationMenu() {
  const canvas = getCanvas();
  if (canvas && onAfterRender) {
    canvas.off('after:render', onAfterRender);
    canvas.off('selection:cleared', hideEquationMenu);
  }
  onAfterRender = null;
  target = null;
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
  }
}

// The equation data behind a selected object: stored on extracted/typed
// equations, or parsed live from a text object that looks like an equation.
function equationDataFor(obj) {
  if (!obj) return null;
  if (obj._equationData) return obj._equationData;
  if ((obj.type === 'i-text' || obj.type === 'text') &&
      typeof obj.text === 'string' && obj.text.includes('=')) {
    return parseTypedEquation(obj.text);
  }
  return null;
}

// Show the menu whenever a single equation object is selected; hide otherwise.
function onSelectionChanged() {
  const canvas = getCanvas();
  if (!canvas) return;
  const active = canvas.getActiveObject();
  if (!active || active.type === 'activeselection') {
    if (active && active.type === 'activeselection') hideEquationMenu();
    return;
  }
  const data = equationDataFor(active);
  if (data) {
    window.extractedEquationData = data; // Plot/Solve/Steps act on the selected one
    showEquationMenu(active, data);
  } else {
    hideEquationMenu();
  }
}

// Wire the menu to selection: selecting an equation (in Select mode) shows it.
export function initEquationSelection(canvas) {
  if (!canvas) return;
  canvas.on('selection:created', onSelectionChanged);
  canvas.on('selection:updated', onSelectionChanged);
}

// showEquationMenu(targetObj, data): pop the action menu next to targetObj.
export function showEquationMenu(targetObj, data) {
  hideEquationMenu();
  const canvas = getCanvas();
  if (!canvas || !targetObj) return;
  target = targetObj;

  const info = analyzeEquation(data);
  const methods = info.isFunction ? methodsFor(info.degree, info.indepVar) : [];

  menuEl = document.createElement('div');
  menuEl.id = 'equation-menu';

  const row = document.createElement('div');
  row.className = 'em-row';
  menuEl.appendChild(row);

  // Method picker row (revealed when Steps is clicked, if several methods apply).
  const methodRow = document.createElement('div');
  methodRow.className = 'em-methods hidden';

  const runSteps = (method) => {
    const via = method ? ` using ${method.phrase}` : '';
    solveToBoard(
      `${info.expr} = 0 for ${info.indepVar}. Show a concise numbered step-by-step ` +
        `solution${via}. Plain text only — no markdown or LaTeX.`,
      aiModel(),
      target,
      method ? `Steps · ${method.label}` : 'Steps'
    );
  };

  methods.forEach((method) => {
    methodRow.appendChild(
      makeButton(method.label, `Step-by-step using ${method.phrase}`, () => {
        methodRow.classList.add('hidden');
        positionMenu();
        runSteps(method);
      })
    );
  });

  const label = document.createElement('span');
  label.className = 'em-label';
  label.textContent = info.isFunction ? `${info.dep} = ${info.expr}` : 'equation';
  row.appendChild(label);

  if (info.isFunction && data.ranges && Object.keys(data.ranges).length) {
    row.appendChild(makeButton('📈 Plot', 'Plot this function', () => drawGraph()));
  }

  if (info.isFunction) {
    row.appendChild(
      makeButton('Solve =0', `Solve ${info.expr} = 0 for ${info.indepVar}`, () => {
        solveToBoard(
          `${info.expr} = 0 for ${info.indepVar}. Give the exact solution(s) only, ` +
            `concise. Plain text only — no markdown or LaTeX.`,
          aiModel(),
          target,
          'Solution'
        );
      })
    );

    if (methods.length > 1) {
      row.appendChild(
        makeButton('📝 Steps ▾', 'Show step-by-step (choose a method)', () => {
          methodRow.classList.toggle('hidden');
          positionMenu();
        })
      );
    } else if (methods.length === 1) {
      row.appendChild(
        makeButton('📝 Steps', `Step-by-step (${methods[0].label})`, () => runSteps(methods[0]))
      );
    }
  }

  row.appendChild(
    makeButton(
      '⧉ Copy',
      'Copy equation text',
      () => {
        const text = target && target.text ? target.text : `${info.dep} = ${info.expr}`;
        if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
      }
    )
  );

  const close = makeButton('✕', 'Dismiss', hideEquationMenu, 'em-close');
  row.appendChild(close);

  menuEl.appendChild(methodRow);
  document.body.appendChild(menuEl);
  positionMenu();

  // Keep the menu glued to the equation while panning/zooming, and dismiss it
  // when the selection is cleared.
  onAfterRender = positionMenu;
  canvas.on('after:render', onAfterRender);
  canvas.on('selection:cleared', hideEquationMenu);
}
