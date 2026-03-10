// src/graph.js — render Chart.js graph as fabric Image on canvas

import Chart from 'chart.js/auto';
import { getCanvas, getCanvasBoundingBox } from './canvas.js';
import { Image as FabricImage } from 'fabric';

// Offscreen canvas for rendering the chart
let _offscreenCanvas = null;

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

export function renderGraph(dataPoints, dependentVariable) {
  const canvas = getCanvas();
  if (!canvas) {
    console.error('Fabric canvas not found');
    return;
  }

  const offscreen = _getOffscreenCanvas();

  // Render chart on offscreen canvas
  const chart = new Chart(offscreen, {
    type: 'line',
    data: {
      datasets: [{
        label: `${dependentVariable} = f(x)`,
        data: dataPoints.map(p => ({ x: p.x, y: p.y })),
        borderColor: 'rgb(75, 192, 192)',
        backgroundColor: 'rgba(75, 192, 192, 0.1)',
        tension: 0.1,
        fill: true,
        pointRadius: 0,
      }],
    },
    options: {
      responsive: false,
      animation: false,
      scales: {
        x: { type: 'linear', position: 'bottom', title: { display: true, text: 'x' } },
        y: { title: { display: true, text: dependentVariable } },
      },
      plugins: {
        legend: { display: true, position: 'top' },
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
}
