// src/api.js — fetch calls to backend (solve, extract, graph)

import { getCanvas, getCanvasBoundingBox, cropCanvasToBoundingBox } from './canvas.js';
import { IText } from 'fabric';
import { getCurrentModel } from './ui.js';
import { renderGraph } from './graph.js';

function appendOutput(html, isError) {
  if (window.appendToOutput) {
    window.appendToOutput(html, isError);
  }
}

export function solveEquationFromText(equation) {
  const model = getCurrentModel();
  appendOutput(`<b>Solving equation:</b> ${equation}<br><b>Using model:</b> ${model}<br><i>Loading...</i>`);

  fetch('/solve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ equation, model }),
  })
    .then(r => r.json())
    .then(data => {
      if (data.success) {
        appendOutput(`<b>Equation:</b> ${equation}<br><b>Model:</b> ${model}<br><b>Solution:</b><br>${data.result}`);
      } else {
        appendOutput(`<b>Error solving equation:</b><br>${data.message || 'Unknown error'}`, true);
      }
    })
    .catch(err => {
      console.error('Error:', err);
      appendOutput(`<b>Error:</b><br>${err.message || 'Communication error with server'}`, true);
    });
}

export function solveEquation() {
  const canvas = getCanvas();
  const model = getCurrentModel();

  if (!canvas) {
    const equation = prompt('Canvas not found. Enter an equation to solve directly (e.g. x^2 + 3*x - 5 = 0):');
    if (equation) solveEquationFromText(equation);
    return;
  }

  const objects = canvas.getObjects('i-text');
  let equation;

  if (objects.length === 0) {
    const allText = canvas.getObjects().filter(o => o.type === 'text' || o.type === 'i-text');
    if (allText.length === 0) {
      alert('No equation found to solve. Please add an equation first.');
      return;
    }
    equation = allText[0].text;
  } else {
    equation = objects[0].text;
  }

  solveEquationFromText(equation);
}

export async function extractEquation() {
  const canvas = getCanvas();
  const model = getCurrentModel();

  if (!canvas) {
    alert('Canvas not found! Please refresh the page and try again.');
    return;
  }

  const boundingBox = getCanvasBoundingBox(canvas);
  const croppedDataURL = await cropCanvasToBoundingBox(canvas);

  if (!croppedDataURL || !boundingBox) {
    alert('No objects found on the canvas to extract equation from.');
    return;
  }

  try {
    appendOutput(`<b>Extracting equation from canvas</b><br><i>Using model: ${model}</i><br><i>Processing...</i>`);

    const endpoint = model === 'gemini' ? '/extract-equation-gemini' : '/extract-equation';

    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: croppedDataURL }),
    });
    const data = await response.json();

    if (data.success) {
      const { equation, dependentVariable, scope, ranges } = data;

      let outputHtml = `<b>Extracted Equation:</b> ${dependentVariable} = ${equation}<br>`;
      outputHtml += `<b>Variables:</b> ${Object.keys(scope).join(', ')}<br>`;
      outputHtml += '<b>Ranges:</b><br>';
      for (const [variable, range] of Object.entries(ranges)) {
        outputHtml += `${variable}: [${range[0]}, ${range[1]}]<br>`;
      }
      appendOutput(outputHtml);

      const boxHeight = boundingBox.maxY - boundingBox.minY;
      const fontSize = Math.round(boxHeight * 0.9);
      const textTop = boundingBox.maxY + 10;

      const eqText = new IText(`${dependentVariable} = ${equation}`, {
        left: boundingBox.minX,
        top: textTop,
        fill: 'green',
        fontSize,
        fontFamily: 'Caveat, cursive',
        selectable: false,
        evented: false,
      });
      canvas.add(eqText);

      window.extractedEquationData = { equation, dependentVariable, scope, ranges };
      await drawGraph();
    } else {
      appendOutput(`<b>Error extracting equation:</b><br>${data.message || 'Unknown error'}`, true);
    }
  } catch (error) {
    console.error('Error:', error);
    appendOutput(`<b>Error:</b><br>${error.message || 'Unknown error during extraction'}`, true);
  }
}

export async function drawGraph() {
  if (!window.extractedEquationData) {
    appendOutput('<b>Error:</b><br>No equation extracted. Please extract an equation first.', true);
    return;
  }

  const { equation, dependentVariable, scope, ranges } = window.extractedEquationData;
  appendOutput(`<b>Graphing equation:</b> ${dependentVariable} = ${equation}<br><i>Processing...</i>`);

  try {
    const response = await fetch('/graph', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression: equation, dependentVariable, scope, ranges }),
    });
    const data = await response.json();

    if (data.success) {
      renderGraph(data.data, dependentVariable);
      const rangeKey = Object.keys(ranges)[0];
      appendOutput(
        `<b>Graph created for:</b> ${dependentVariable} = ${equation}<br>` +
        `<b>Points:</b> ${data.data.length}<br>` +
        `<b>Range:</b> [${ranges[rangeKey][0]}, ${ranges[rangeKey][1]}]<br>` +
        '<i>Graph displayed in bottom-right corner</i>'
      );
    } else {
      appendOutput(`<b>Error generating graph:</b><br>${data.message || 'Unknown error'}`, true);
    }
  } catch (error) {
    console.error('Error:', error);
    appendOutput(`<b>Error:</b><br>${error.message || 'Failed to generate graph'}`, true);
  }
}
