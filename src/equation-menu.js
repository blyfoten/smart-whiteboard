// src/equation-menu.js — a Word-style floating action menu that appears next to
// a freshly analyzed equation. The actions are content-aware: a function like
// y = x^2 - 4x + 16 offers Plot / Solve =0 / Show steps, while a plain
// expression just offers Plot (when it has a variable) and Copy.

import { getCanvas } from './canvas.js';
import { drawGraph, solveEquationFromText } from './api.js';
import { getCurrentModel } from './ui.js';
import { appendToOutput } from './output.js';

let menuEl = null;
let target = null;
let onAfterRender = null;

// AI actions need an LLM; math.js can't produce symbolic solutions or steps.
function aiModel() {
  const m = getCurrentModel();
  return m === 'math' ? 'gpt' : m;
}

// Crude content analysis: highest power of the independent variable → suggested
// solving method, plus whether the expression actually involves that variable.
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

  let method = '';
  if (degree === 2) method = 'quadratic (p-q) formula';
  else if (degree >= 3) method = 'factoring or numerical methods';

  return { expr, indepVar, dep, degree, isFunction: hasVar, method };
}

function makeButton(label, title, handler) {
  const b = document.createElement('button');
  b.textContent = label;
  if (title) b.title = title;
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

// showEquationMenu(targetObj, data): pop the action menu next to targetObj.
export function showEquationMenu(targetObj, data) {
  hideEquationMenu();
  const canvas = getCanvas();
  if (!canvas || !targetObj) return;
  target = targetObj;

  const info = analyzeEquation(data);
  menuEl = document.createElement('div');
  menuEl.id = 'equation-menu';

  const label = document.createElement('span');
  label.className = 'em-label';
  label.textContent = info.isFunction ? `${info.dep} = ${info.expr}` : 'equation';
  menuEl.appendChild(label);

  if (info.isFunction && data.ranges && Object.keys(data.ranges).length) {
    menuEl.appendChild(makeButton('📈 Plot', 'Plot this function', () => drawGraph()));
  }

  if (info.isFunction) {
    menuEl.appendChild(
      makeButton(`Solve =0`, `Solve ${info.expr} = 0 for ${info.indepVar}`, () => {
        appendToOutput(`<b>Solving</b> ${info.expr} = 0 for ${info.indepVar}…`);
        solveEquationFromText(
          `Solve ${info.expr} = 0 for ${info.indepVar}. Give the exact solution(s), concisely.`,
          aiModel()
        );
      })
    );

    menuEl.appendChild(
      makeButton('📝 Steps', 'Show step-by-step solution', () => {
        const via = info.method ? ` using the ${info.method}` : '';
        appendToOutput(`<b>Step-by-step</b> for ${info.expr} = 0${via}…`);
        solveEquationFromText(
          `Solve ${info.expr} = 0 for ${info.indepVar} step by step${via}. ` +
            `Number each step and keep it concise.`,
          aiModel()
        );
      })
    );
  }

  menuEl.appendChild(
    makeButton('⧉ Copy', 'Copy equation text', () => {
      const text = target && target.text ? target.text : `${info.dep} = ${info.expr}`;
      if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {});
    })
  );

  const close = makeButton('✕', 'Dismiss', hideEquationMenu);
  close.className = 'em-close';
  menuEl.appendChild(close);

  document.body.appendChild(menuEl);
  positionMenu();

  // Keep the menu glued to the equation while panning/zooming, and dismiss it
  // when the selection is cleared.
  onAfterRender = positionMenu;
  canvas.on('after:render', onAfterRender);
  canvas.on('selection:cleared', hideEquationMenu);
}
