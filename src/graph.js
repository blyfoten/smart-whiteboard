// src/graph.js — render Chart.js graph as fabric Image on canvas

import Chart from 'chart.js/auto';
import { getCanvas, getCanvasBoundingBox } from './canvas.js';
import { Image as FabricImage } from 'fabric';

// Offscreen canvas for rendering the chart
let _offscreenCanvas = null;
// Last graph rendered, so a settings change (gridlines) can re-render it.
let _lastGraph = null;

const INK = '#1f2937'; // slate ink for axes/labels — reads like pen on whiteboard

function _getOffscreenCanvas() {
  if (!_offscreenCanvas) {
    _offscreenCanvas = document.createElement('canvas');
    _offscreenCanvas.width = 500;
    _offscreenCanvas.height = 350;
    _offscreenCanvas.style.display = 'none';
    document.body.appendChild(_offscreenCanvas);
  }
  return _offscreenCanvas;
}

function _gridlinesOn() {
  const sel = document.getElementById('graph-grid-select');
  return sel ? sel.value === 'on' : false;
}

// Re-render the most recent graph (e.g. after toggling gridlines in settings).
export function redrawLastGraph() {
  if (_lastGraph) renderGraph(_lastGraph.dataPoints, _lastGraph.dependentVariable);
}

export function renderGraph(dataPoints, dependentVariable) {
  const canvas = getCanvas();
  if (!canvas) {
    console.error('Fabric canvas not found');
    return;
  }
  _lastGraph = { dataPoints, dependentVariable };

  const offscreen = _getOffscreenCanvas();
  const gridOn = _gridlinesOn();
  const axisFont = { family: 'Caveat, cursive', size: 16, weight: '600' };
  const tickFont = { family: 'Caveat, cursive', size: 15 };

  // A grid config: tick marks always (on the axes), full gridlines only when on.
  const grid = {
    display: true,
    drawOnChartArea: gridOn,
    drawTicks: true,
    tickColor: INK,
    tickLength: 6,
    color: 'rgba(31, 41, 55, 0.12)',
  };

  const draw = () => {
    // Clear so the exported PNG is transparent where nothing is drawn.
    const ctx = offscreen.getContext('2d');
    ctx.clearRect(0, 0, offscreen.width, offscreen.height);

    const chart = new Chart(offscreen, {
      type: 'line',
      data: {
        datasets: [{
          label: `${dependentVariable} = f(x)`,
          data: dataPoints.map(p => ({ x: p.x, y: p.y })),
          borderColor: 'rgb(75, 192, 192)',
          borderWidth: 2.5,
          tension: 0.25,
          fill: false,
          pointRadius: 0,
        }],
      },
      options: {
        responsive: false,
        animation: false,
        layout: { padding: 6 },
        scales: {
          x: {
            type: 'linear',
            position: { y: 0 }, // x-axis drawn through the origin
            title: { display: true, text: 'x', color: INK, font: axisFont },
            ticks: { color: INK, font: tickFont, maxTicksLimit: 11 },
            border: { color: INK, width: 2 },
            grid,
          },
          y: {
            position: { x: 0 }, // y-axis drawn through the origin
            title: { display: true, text: dependentVariable, color: INK, font: axisFont },
            ticks: { color: INK, font: tickFont, maxTicksLimit: 9 },
            border: { color: INK, width: 2 },
            grid,
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false },
        },
      },
    });

    // Chart.js needs a frame to render with animation:false
    requestAnimationFrame(() => {
      const dataURL = offscreen.toDataURL('image/png');
      chart.destroy();

      // Figure out placement: below the drawn equation content
      const bb = getCanvasBoundingBox(canvas);
      const left = bb ? bb.minX : 50;
      const top = bb ? bb.maxY + 30 : 200;

      const imgEl = new window.Image();
      imgEl.onload = () => {
        const fabricImg = new FabricImage(imgEl, {
          left,
          top,
          scaleX: 0.8,
          scaleY: 0.8,
          selectable: true,
          hasControls: true,
          hasBorders: true,
          lockRotation: true,
          cornerSize: 12,
          transparentCorners: false,
          _isGraph: true, // tag for identification
        });

        // Remove previous graph images
        canvas.getObjects().forEach(obj => {
          if (obj._isGraph) canvas.remove(obj);
        });

        canvas.add(fabricImg);
        // Temporarily disable drawing mode to allow interaction with graph
        canvas.setActiveObject(fabricImg);
        canvas.requestRenderAll();
      };
      imgEl.src = dataURL;
    });
  };

  // Make sure Caveat is loaded before Chart.js measures text, else it falls back.
  if (document.fonts && document.fonts.load) {
    document.fonts.load("16px 'Caveat'").then(draw).catch(draw);
  } else {
    draw();
  }
}
