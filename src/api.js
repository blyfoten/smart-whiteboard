// src/api.js — fetch calls to backend (solve, extract, graph)

import { getCanvas, getCanvasBoundingBox, cropCanvasToBoundingBox } from './canvas.js';
import { IText, Textbox } from 'fabric';
import { getCurrentModel } from './ui.js';
import { renderGraph } from './graph.js';
import { appendToOutput } from './output.js';
import { showEquationMenu, hideEquationMenu } from './equation-menu.js';

function appendOutput(html, isError) {
  appendToOutput(html, isError);
}

// Prettify an expression for display on the canvas (NOT for math.js). The Caveat
// font draws '*' as a raised glyph, so 4*x looks like "4ˣx"; drop the asterisk
// where multiplication is implicit (4*x → 4x, 2*(x+1) → 2(x+1), x*y → xy) and
// render any remaining number×number with a middle dot.
function formatEquationForDisplay(expr) {
  return String(expr)
    .replace(/([0-9a-zA-Z)\]])\s*\*\s*([a-zA-Z(])/g, '$1$2')
    .replace(/\s*\*\s*/g, ' · ');
}

// Parse `^` exponents out of a display string into raised spans. The exponent is
// a balanced (..) group or a run of alphanumerics; the `^` is dropped and the
// span recorded so it can be rendered as a real superscript (smaller + raised)
// in the SAME font — no Unicode glyphs, so nothing falls back to tofu. A lone
// `^` with no exponent stays literal. Nested powers just raise one level.
function parseSuperscripts(s) {
  let out = '';
  const ranges = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] !== '^') { out += s[i++]; continue; }
    i++; // skip the caret
    const start = out.length;
    if (s[i] === '(') {
      let depth = 0, j = i;
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')' && --depth === 0) { j++; break; }
      }
      out += s.slice(i, j);
      i = j;
    } else {
      let j = i;
      while (j < s.length && /[0-9a-zA-Z.]/.test(s[j])) j++;
      if (j === i) { out += '^'; continue; } // nothing to raise
      out += s.slice(i, j);
      i = j;
    }
    ranges.push([start, out.length]);
  }
  return { text: out, ranges };
}

// Render the recorded spans as superscripts via Fabric per-character styles
// (relative to the current base font, so it survives the fit-to-width rescale).
function applySuperscript(textObj, ranges, baseFont) {
  if (!ranges.length) return;
  const expFont = Math.max(8, Math.round(baseFont * 0.62));
  const deltaY = -Math.round(baseFont * 0.33);
  const line = {};
  ranges.forEach(([start, end]) => {
    for (let c = start; c < end; c++) line[c] = { fontSize: expFont, deltaY };
  });
  textObj.set({ styles: { 0: line } });
  textObj.initDimensions();
  textObj.setCoords();
}

// Tight bounding box (scene coords) of a set of Fabric objects, or null if empty.
function boundingBoxOf(objects) {
  if (!objects || objects.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  objects.forEach((o) => {
    const r = o.getBoundingRect(true, false);
    minX = Math.min(minX, r.left);
    minY = Math.min(minY, r.top);
    maxX = Math.max(maxX, r.left + r.width);
    maxY = Math.max(maxY, r.top + r.height);
  });
  return { minX, minY, maxX, maxY };
}

export function solveEquationFromText(equation, modelOverride) {
  const model = modelOverride || getCurrentModel();
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

// Strip light markdown/LaTeX so AI output reads cleanly as handwriting.
function cleanForBoard(s) {
  return String(s)
    .replace(/\*\*/g, '')
    .replace(/`/g, '')
    .replace(/^\s*#{1,6}\s*/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// A Caveat text block placed just below `anchor`, replacing any previous block
// tied to the same equation. Returned not-yet-added so the caller can add it.
function makeBoardBlock(canvas, anchor, initial) {
  canvas
    .getObjects()
    .filter((o) => o._isSteps && o._stepsFor === anchor)
    .forEach((o) => canvas.remove(o));

  const scaleX = anchor.scaleX || 1;
  const scaleY = anchor.scaleY || 1;
  const fontSize = Math.max(18, Math.min(anchor.fontSize || 28, 30));
  const block = new Textbox(initial, {
    left: anchor.left,
    top: anchor.top + anchor.height * scaleY + Math.max(12, fontSize * 0.4),
    width: Math.max(320, (anchor.width || 300) * scaleX),
    fontSize,
    fontFamily: 'Caveat, cursive',
    fill: '#1e40af',
    selectable: true,
    evented: true,
    editable: false,
  });
  block._isSteps = true;
  block._stepsFor = anchor;
  return block;
}

// Solve via the AI and render the answer on the whiteboard (Caveat, below the
// equation) as well as logging it to the output panel.
export async function solveToBoard(instruction, model, anchor, heading) {
  const canvas = getCanvas();
  appendOutput(`<b>${heading || 'Solving'}</b><br><i>Using model: ${model}</i><br><i>Processing…</i>`);

  let block = null;
  if (canvas && anchor) {
    block = makeBoardBlock(canvas, anchor, '⏳ solving…');
    canvas.add(block);
    canvas.requestRenderAll();
  }

  try {
    const resp = await fetch('/solve', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ equation: instruction, model }),
    });
    const data = await resp.json();
    const ok = !!data.success;
    const text = ok ? cleanForBoard(data.result) : `Error: ${data.message || 'solve failed'}`;

    if (block) {
      block.set({ text, fill: ok ? '#1e40af' : '#b91c1c' });
      block.initDimensions();
      block.setCoords();
      canvas.requestRenderAll();
    }
    appendOutput(
      ok
        ? `<b>${heading || 'Solution'}:</b><br>${escapeHtml(text).replace(/\n/g, '<br>')}`
        : `<b>Error:</b><br>${data.message || 'Unknown error'}`,
      !ok
    );
    return { ok, text };
  } catch (err) {
    console.error('Error:', err);
    if (block) {
      block.set({ text: `Error: ${err.message || err}`, fill: '#b91c1c' });
      canvas.requestRenderAll();
    }
    appendOutput(`<b>Error:</b><br>${err.message || 'Communication error with server'}`, true);
    return { ok: false, text: String(err.message || err) };
  }
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

  hideEquationMenu();

  const boundingBox = getCanvasBoundingBox(canvas);
  const croppedDataURL = await cropCanvasToBoundingBox(canvas);

  if (!croppedDataURL || !boundingBox) {
    alert('No objects found on the canvas to extract equation from.');
    return;
  }

  try {
    appendOutput(`<b>Extracting equation from canvas</b><br><i>Using model: ${model}</i><br><i>Processing...</i>`);

    // Unified endpoint; map the UI model to a vision provider (math/gpt → openai).
    const provider = { gemini: 'gemini', claude: 'claude' }[model] || 'openai';

    const response = await fetch('/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: croppedDataURL, provider }),
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

      // The handwriting we extracted from = everything except graphs and any
      // earlier extracted equation. We replace it in place with clean text.
      const inkObjects = canvas
        .getObjects()
        .filter((o) => !o._isGraph && !o._isExtracted);
      const inkBox = boundingBoxOf(inkObjects) || boundingBox;
      const boxWidth = inkBox.maxX - inkBox.minX;
      const boxHeight = inkBox.maxY - inkBox.minY;

      // Start from the box height, then shrink so the plain-text equation (which
      // is wider than handwriting — x^2 etc.) fits the original box width.
      const { text: displayText, ranges: supRanges } = parseSuperscripts(
        `${dependentVariable} = ${formatEquationForDisplay(equation)}`
      );
      let fontSize = Math.max(12, Math.round(boxHeight * 0.9));
      const eqText = new IText(displayText, {
        left: inkBox.minX,
        top: inkBox.minY,
        fill: 'green',
        fontSize,
        fontFamily: 'Caveat, cursive',
        selectable: true,
        evented: true,
      });
      applySuperscript(eqText, supRanges, fontSize);
      if (eqText.width > boxWidth && eqText.width > 0) {
        fontSize = Math.max(12, Math.floor(fontSize * (boxWidth / eqText.width)));
        eqText.set({ fontSize });
        applySuperscript(eqText, supRanges, fontSize);
      }
      // Vertically center the (now shorter) text within the original box.
      eqText.set({ top: inkBox.minY + Math.max(0, (boxHeight - eqText.height) / 2) });
      eqText._isExtracted = true;

      // Replace the handwriting in place, stashing it for a one-press Undo.
      eqText._replacedInk = inkObjects;
      inkObjects.forEach((o) => canvas.remove(o));
      canvas.add(eqText);

      window.extractedEquationData = { equation, dependentVariable, scope, ranges };

      // Leave the result selected and pop a content-aware action menu next to it
      // (Plot / Solve / Steps), Word-style — instead of auto-plotting.
      canvas.setActiveObject(eqText);
      canvas.requestRenderAll();
      showEquationMenu(eqText, window.extractedEquationData);
      return window.extractedEquationData;
    } else {
      appendOutput(`<b>Error extracting equation:</b><br>${data.message || 'Unknown error'}`, true);
      return null;
    }
  } catch (error) {
    console.error('Error:', error);
    appendOutput(`<b>Error:</b><br>${error.message || 'Unknown error during extraction'}`, true);
    return null;
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
