// src/graph.js — render Chart.js graph as fabric Image on canvas

import Chart from 'chart.js/auto';
import { getCanvas, getCanvasBoundingBox } from './canvas.js';
import { Image as FabricImage } from 'fabric';

// Offscreen canvas for rendering the chart
let _offscreenCanvas = null;
// Last graph rendered, so a settings change (gridlines) can re-render it.
let _lastGraph = null;

const INK = '#1f2937'; // slate ink for axes/labels — reads like pen on whiteboard

// A small filled arrowhead at the positive end of an axis. dir: 'right' | 'up'.
function _arrowhead(ctx, x, y, dir) {
  const s = 7;
  ctx.beginPath();
  if (dir === 'right') {
    ctx.moveTo(x, y);
    ctx.lineTo(x - s, y - s * 0.6);
    ctx.lineTo(x - s, y + s * 0.6);
  } else {
    ctx.moveTo(x, y);
    ctx.lineTo(x - s * 0.6, y + s);
    ctx.lineTo(x + s * 0.6, y + s);
  }
  ctx.closePath();
  ctx.fill();
}

// Chart.js plugin: draw arrowheads at the axis ends and the axis names (x and
// the dependent variable) beside those ends, instead of Chart's built-in axis
// titles (which sit awkwardly mid-axis when the axes pass through the origin).
function _axesPlugin(depVar) {
  return {
    id: 'handDrawnAxes',
    afterDatasetsDraw(chart) {
      const xs = chart.scales.x;
      const ys = chart.scales.y;
      if (!xs || !ys) return;
      const x0 = xs.getPixelForValue(0);
      const y0 = ys.getPixelForValue(0);

      const ctx = chart.ctx;
      ctx.save();
      ctx.fillStyle = INK;

      // y-axis numbers — drawn ourselves to the LEFT of the axis. Chart renders
      // them centered on the line for an origin-positioned axis, so its own y
      // labels are disabled (ticks.display:false) and we place them here. Skip 0
      // (the x-axis already labels the origin).
      ctx.font = "15px 'Caveat', cursive";
      ctx.textAlign = 'right';
      ctx.textBaseline = 'middle';
      (ys.ticks || []).forEach((t) => {
        if (t.value === 0) return;
        ctx.fillText(String(t.value), x0 - 8, ys.getPixelForValue(t.value));
      });

      // Arrowheads: extend the axis a little past the last tick into the
      // layout padding, then the axis names just outside the arrowheads.
      const xEnd = xs.right + 14;
      const yEnd = ys.top - 14;
      ctx.strokeStyle = INK;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(xs.right, y0);
      ctx.lineTo(xEnd, y0);
      ctx.moveTo(x0, ys.top);
      ctx.lineTo(x0, yEnd);
      ctx.stroke();
      _arrowhead(ctx, xEnd, y0, 'right');
      _arrowhead(ctx, x0, yEnd, 'up');

      ctx.font = "600 18px 'Caveat', cursive";
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText('x', xEnd + 6, y0);
      ctx.textBaseline = 'bottom';
      ctx.fillText(depVar, x0 + 8, yEnd - 2);
      ctx.restore();
    },
  };
}

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
        // Extra right/top room so the axis arrows + x/y names sit past the last tick.
        layout: { padding: { left: 8, right: 34, top: 26, bottom: 8 } },
        scales: {
          x: {
            type: 'linear',
            position: { y: 0 }, // x-axis drawn through the origin
            // Hide the 0 at the origin; the axes crossing already marks it.
            ticks: { color: INK, font: tickFont, maxTicksLimit: 11, padding: 6, callback: (v) => (v === 0 ? '' : v) },
            border: { color: INK, width: 2 },
            grid,
          },
          y: {
            position: { x: 0 }, // y-axis drawn through the origin
            // Chart centers labels on an origin axis; we draw them ourselves to
            // the left in the plugin. Keep the tick marks (grid.drawTicks).
            ticks: { display: false, maxTicksLimit: 9 },
            border: { color: INK, width: 2 },
            grid,
          },
        },
        plugins: {
          legend: { display: false },
          tooltip: { enabled: false },
        },
      },
      plugins: [_axesPlugin(dependentVariable)],
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
