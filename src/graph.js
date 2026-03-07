// src/graph.js — Chart.js rendering

import Chart from 'chart.js/auto';

let graphChart = null;

export function renderGraph(dataPoints, dependentVariable) {
  const graphContainer = document.getElementById('graph-container');
  if (!graphContainer) {
    console.error('Graph container not found');
    return;
  }

  graphContainer.style.display = 'block';

  const graphCanvas = document.getElementById('graph-canvas');
  if (!graphCanvas) {
    console.error('Graph canvas not found');
    return;
  }

  if (graphChart) {
    graphChart.destroy();
  }

  graphChart = new Chart(graphCanvas, {
    type: 'line',
    data: {
      datasets: [{
        label: `${dependentVariable} = f(x)`,
        data: dataPoints.map(p => ({ x: p.x, y: p.y })),
        borderColor: 'rgb(75, 192, 192)',
        tension: 0.1,
        fill: false,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { type: 'linear', position: 'bottom', title: { display: true, text: 'x' } },
        y: { title: { display: true, text: dependentVariable } },
      },
    },
  });
}
