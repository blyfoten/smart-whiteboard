// src/index.js — thin orchestrator

import { getCanvas, resizeCanvas, addReadyIndicator } from './canvas.js';
import { initializeSpeechRecognition } from './speech.js';
import { initializeModelSelectionUI, setupCanvasEventListeners, initializeEventListeners } from './ui.js';
import { initModes } from './modes.js';
import { initOutputPanel } from './output.js';
import { initVoice } from './voice.js';
import { initHistory } from './history.js';
import { initStatePersistence } from './state.js';
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
  const status = document.getElementById('status');
  try {
    // Restore saved preferences onto the controls before any module reads them.
    initStatePersistence();

    const canvas = getCanvas();

    if (canvas) {
      resizeCanvas(canvas);
      window.addEventListener('resize', () => resizeCanvas(canvas));
      addReadyIndicator(canvas);
      // Start recording undo history after the ready indicator so it isn't undoable.
      initHistory(canvas);
      setupCanvasEventListeners();
      initModes(canvas);

      // Web fonts load async and Fabric renders text to the canvas, so re-render
      // once Caveat is available (otherwise the first text uses a fallback font).
      if (document.fonts && document.fonts.load) {
        document.fonts.load("24px 'Caveat'")
          .then(() => canvas.requestRenderAll())
          .catch(() => {});
      }
    } else {
      throw new Error('getCanvas() returned null — Fabric canvas not initialized.');
    }

    initializeSpeechRecognition(handleCommand);
    initializeModelSelectionUI();
    initializeEventListeners();
    initOutputPanel();
    initVoice();

    // Expose globals for HTML inline usage
    window.getCanvas = getCanvas;
    window.solveEquation = solveEquation;
  } catch (err) {
    // Surface init failures instead of leaving a silently-dead page.
    console.error('Initialization error:', err);
    if (status) {
      status.textContent = 'Init error: ' + (err && err.message ? err.message : err);
      status.style.color = 'red';
    }
  }
});
