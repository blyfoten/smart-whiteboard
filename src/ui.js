// src/ui.js — event listeners, model selection, output panel

import { getCanvas, undoLast, saveScreenshot, clearCanvas } from './canvas.js';
import { IText } from 'fabric';
import { solveEquation, solveEquationFromText, extractEquation, drawGraph } from './api.js';
import { toggleRecognition } from './speech.js';

let currentModel = 'math';

export function getCurrentModel() {
  return currentModel;
}

export function initializeModelSelectionUI() {
  const existingSelect = document.getElementById('model-select');

  if (existingSelect) {
    existingSelect.addEventListener('change', (e) => {
      currentModel = e.target.value;
      console.log(`Model changed to: ${e.target.value}`);
    });

    if (existingSelect.value) {
      currentModel = existingSelect.value;
    }
    return;
  }

  // Create dropdown if not in HTML
  const uiElement = document.querySelector('.ui-element');
  if (!uiElement) return;

  const container = document.createElement('div');
  container.style.marginTop = '10px';

  const label = document.createElement('label');
  label.textContent = 'AI Model: ';
  label.setAttribute('for', 'model-select');

  const select = document.createElement('select');
  select.id = 'model-select';

  [
    { value: 'math', text: 'Math.js (Simple)' },
    { value: 'gpt', text: 'GPT (Advanced)' },
    { value: 'gemini', text: 'Gemini (Advanced)' },
  ].forEach(opt => {
    const o = document.createElement('option');
    o.value = opt.value;
    o.textContent = opt.text;
    select.appendChild(o);
  });

  select.addEventListener('change', (e) => {
    currentModel = e.target.value;
  });

  container.appendChild(label);
  container.appendChild(select);
  uiElement.appendChild(container);
}

export function setupCanvasEventListeners() {
  const canvas = getCanvas();
  if (!canvas) return;

  canvas.on('mouse:dblclick', (options) => {
    const pointer = canvas.getPointer(options.e);
    const text = new IText('Write equation here', {
      left: pointer.x,
      top: pointer.y,
      fill: 'red',
      fontSize: 20,
      backgroundColor: 'transparent',
      selectable: true,
      editable: true,
      fontFamily: 'Arial',
    });
    canvas.add(text);
    canvas.setActiveObject(text);
    text.enterEditing();
    text.selectAll();
  });
}

export function initializeEventListeners() {
  const startRecordBtn = document.getElementById('start-record-btn');
  if (startRecordBtn) {
    startRecordBtn.addEventListener('click', toggleRecognition);
  }

  const extractEqBtn = document.getElementById('extract-eq-btn');
  if (extractEqBtn) {
    extractEqBtn.addEventListener('click', extractEquation);
  }

  const undoBtn = document.getElementById('undo-btn');
  if (undoBtn) {
    undoBtn.addEventListener('click', () => undoLast(getCanvas()));
  }

  const saveBtn = document.getElementById('save-btn');
  if (saveBtn) {
    saveBtn.addEventListener('click', () => saveScreenshot(getCanvas()));
  }

  const uiElement = document.querySelector('.ui-element');
  if (!uiElement) return;

  // Create solve button if missing
  if (!document.getElementById('solve-eq-btn')) {
    const solveBtn = document.createElement('button');
    solveBtn.id = 'solve-eq-btn';
    solveBtn.textContent = 'Solve Equation';
    solveBtn.addEventListener('click', solveEquation);
    uiElement.insertBefore(solveBtn, document.getElementById('status'));
  } else {
    document.getElementById('solve-eq-btn').addEventListener('click', solveEquation);
  }

  // Create graph button if missing
  if (!document.getElementById('graph-btn')) {
    const graphBtn = document.createElement('button');
    graphBtn.id = 'graph-btn';
    graphBtn.textContent = 'Draw Graph';
    graphBtn.addEventListener('click', drawGraph);
    const solveBtn = document.getElementById('solve-eq-btn');
    if (solveBtn) {
      uiElement.insertBefore(graphBtn, solveBtn.nextSibling);
    } else {
      uiElement.insertBefore(graphBtn, document.getElementById('status'));
    }
  } else {
    document.getElementById('graph-btn').addEventListener('click', drawGraph);
  }

  // Force solve button
  let forceSolveBtn = document.getElementById('force-solve-btn');
  if (!forceSolveBtn) {
    forceSolveBtn = document.createElement('button');
    forceSolveBtn.id = 'force-solve-btn';
    forceSolveBtn.textContent = 'Force Solve';
    forceSolveBtn.style.backgroundColor = '#ffdddd';
    const debugOutput = document.getElementById('debug-output');
    if (debugOutput) {
      uiElement.insertBefore(forceSolveBtn, debugOutput);
    } else {
      uiElement.appendChild(forceSolveBtn);
    }
  }
  forceSolveBtn.addEventListener('click', () => {
    const equation = prompt('Enter equation to solve (e.g. x^2 + 3*x - 5 = 0):');
    if (equation) solveEquationFromText(equation);
  });
}
