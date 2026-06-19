// src/index.js — thin orchestrator

import { getCanvas, resizeCanvas, addReadyIndicator } from './canvas.js';
import { initializeSpeechRecognition } from './speech.js';
import { initializeModelSelectionUI, setupCanvasEventListeners, initializeEventListeners } from './ui.js';
import { initModes } from './modes.js';
import { initOutputPanel } from './output.js';
import { solveEquation } from './api.js';

function handleCommand(command) {
  const canvas = getCanvas();
  if (command.includes('clear') && canvas) {
    canvas.clear();
    canvas.setBackgroundColor('white', canvas.renderAll.bind(canvas));
  } else if (command.includes('solve equation')) {
    solveEquation();
  } else {
    alert('Command not recognized.');
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const canvas = getCanvas();

  if (canvas) {
    resizeCanvas(canvas);
    window.addEventListener('resize', () => resizeCanvas(canvas));
    addReadyIndicator(canvas);
    setupCanvasEventListeners();
    initModes(canvas);
  } else {
    console.error('Failed to initialize canvas');
  }

  initializeSpeechRecognition(handleCommand);
  initializeModelSelectionUI();
  initializeEventListeners();
  initOutputPanel();

  // Expose globals for HTML inline usage
  window.getCanvas = getCanvas;
  window.solveEquation = solveEquation;
});
