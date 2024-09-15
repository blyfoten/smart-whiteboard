// src/index.js

import { Canvas, IText, Text, Rect, PencilBrush, StaticCanvas } from 'fabric';
import Chart from 'chart.js/auto';

// Function to adjust canvas size
function resizeCanvas(canvas) {
  const container = document.getElementById('container');
  const width = container.clientWidth;
  const height = container.clientHeight;
  canvas.setWidth(width);
  canvas.setHeight(height);
  canvas.renderAll();
}

// Function to find the smallest bounding box containing all objects
function getCanvasBoundingBox(canvas) {
  if (canvas.getObjects().length === 0) {
    return null; // No objects on the canvas
  }

  // Calculate bounding box for all objects
  const objects = canvas.getObjects();
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  objects.forEach(obj => {
    const objRect = obj.getBoundingRect(true, false);
    if (objRect.left < minX) minX = objRect.left;
    if (objRect.top < minY) minY = objRect.top;
    if ((objRect.left + objRect.width) > maxX) maxX = objRect.left + objRect.width;
    if ((objRect.top + objRect.height) > maxY) maxY = objRect.top + objRect.height;
  });

  return { minX, minY, maxX, maxY };
}

// Function to crop the canvas to the bounding box
async function cropCanvasToBoundingBox(canvas) {
  const boundingBox = getCanvasBoundingBox(canvas);
  
  if (!boundingBox) {
    alert('No objects found on the canvas to crop.');
    return null;
  }

  // Calculate width and height
  const width = boundingBox.maxX - boundingBox.minX;
  const height = boundingBox.maxY - boundingBox.minY;

  // Create a temporary canvas to draw the cropped image
  const tempCanvas = new StaticCanvas(null, {
    backgroundColor: 'white',
    width: width,
    height: height,
  });

  // Duplicate all objects and adjust their positions relative to the bounding box
  const clonedObjects = await Promise.all(
    canvas.getObjects().map(obj => obj.clone())
  );

  clonedObjects.forEach(obj => {
    obj.set({
      left: obj.left - boundingBox.minX,
      top: obj.top - boundingBox.minY,
      selectable: false, // Make objects non-selectable on tempCanvas
      evented: false,    // Make objects non-interactive on tempCanvas
    });
    tempCanvas.add(obj);
  });

  // Render the temporary canvas
  tempCanvas.renderAll();

  // Export the cropped canvas as a Data URL
  const croppedDataURL = tempCanvas.toDataURL({
    format: 'jpeg',
    quality: 0.8,
  });

  return croppedDataURL;
}

// Initialize Fabric.js canvas with white background
const canvas = new Canvas('whiteboard', {
  backgroundColor: 'white', // Set background color to white
  isDrawingMode: true,       // Activate drawing mode
});

// Configure drawing tool (brush)
canvas.freeDrawingBrush = new PencilBrush(canvas);
canvas.freeDrawingBrush.color = "black";
canvas.freeDrawingBrush.width = 5;

// Adjust canvas on window resize
window.addEventListener('resize', () => resizeCanvas(canvas));
resizeCanvas(canvas);

// Speech recognition
let recognition;
let recognizing = false;
const status = document.getElementById('status');

// Check if Web Speech API is supported
if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SpeechRecognition();
  recognition.lang = 'en-US'; // English
  recognition.continuous = false;
  recognition.interimResults = false;

  recognition.onstart = function() {
    recognizing = true;
    status.textContent = 'Speech recognition started. Speak now.';
  };

  recognition.onresult = function(event) {
    const transcript = event.results[0][0].transcript.trim().toLowerCase();
    status.textContent = 'You said: "' + transcript + '"';
    handleCommand(transcript);
    recognizing = false;
  };

  recognition.onerror = function(event) {
    status.textContent = 'Speech recognition error: ' + event.error;
    recognizing = false;
  };

  recognition.onend = function() {
    recognizing = false;
    status.textContent = 'Speech recognition ended.';
  };
} else {
  status.textContent = 'Web Speech API is not supported in this browser.';
}

// Add event listener to the speech recognition button
document.getElementById('start-record-btn').addEventListener('click', function() {
  if (recognizing) {
    recognition.stop();
    recognizing = false;
  } else {
    recognition.start();
  }
});

// Handle voice commands
function handleCommand(command) {
  if (command.includes('clear')) {
    canvas.clear();
    // Reset background color after clearing
    canvas.setBackgroundColor('white', canvas.renderAll.bind(canvas));
  } else if (command.includes('solve equation')) {
    solveEquation();
  } else if (command.includes('draw graph')) {
    drawGraph();
  } else {
    alert('Command not recognized.');
  }
}

// Function to solve equation
function solveEquation() {
  const objects = canvas.getObjects('i-text');
  if (objects.length === 0) {
    alert('No equation found to solve.');
    return;
  }
  const equation = objects[0].text;
  fetch('/solve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ equation })
  })
  .then(response => response.json())
  .then(data => {
    if (data.success) {
      // Display the result on the canvas
      const resultText = new Text(`Result: ${data.solution}`, {
        left: 10,
        top: 50,
        fill: 'blue',
        fontSize: 20,
        selectable: false,
        evented: false,
      });
      canvas.add(resultText);
    } else {
      alert(data.message);
    }
  })
  .catch(error => {
    console.error('Error:', error);
  });
}

// Update the drawGraph function
async function drawGraph() {
  if (!window.extractedEquationData) {
    alert('No equation extracted. Please extract an equation first.');
    return;
  }

  const { equation, dependentVariable, scope, ranges } = window.extractedEquationData;

  try {
    const response = await fetch('/graph', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression: equation, dependentVariable, scope, ranges })
    });
    const data = await response.json();

    if (data.success) {
      renderGraph(data.data, dependentVariable);
    } else {
      alert(data.message);
    }
  } catch (error) {
    console.error('Error:', error);
    alert('An error occurred while generating the graph.');
  }
}

// Update the renderGraph function
function renderGraph(dataPoints, dependentVariable) {
  const ctx = document.getElementById('graph-canvas').getContext('2d');
  if (window.graphChart) {
    window.graphChart.destroy();
  }

  window.graphChart = new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        label: `${dependentVariable} = f(x)`,
        data: dataPoints,
        borderColor: 'rgba(75, 192, 192, 1)',
        borderWidth: 2,
        fill: false,
        pointRadius: 0
      }]
    },
    options: {
      scales: {
        x: {
          type: 'linear',
          position: 'bottom',
          title: {
            display: true,
            text: 'x'
          }
        },
        y: {
          title: {
            display: true,
            text: dependentVariable
          }
        }
      }
    }
  });
}

// Update the extractEquation function
async function extractEquation() {
  const boundingBox = getCanvasBoundingBox(canvas);
  const croppedDataURL = await cropCanvasToBoundingBox(canvas);
  
  if (!croppedDataURL || !boundingBox) {
    alert('No objects found on the canvas to extract equation from.');
    return;
  }

  try {
    const response = await fetch('/extract-equation', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: croppedDataURL })
    });
    const data = await response.json();

    if (data.success) {
      const { equation, dependentVariable, scope, ranges } = data;
      console.log(`Extracted Equation: ${equation}`);
      
      // Calculate font size and position
      const boxHeight = boundingBox.maxY - boundingBox.minY;
      const fontSize = Math.round(boxHeight * 0.9);
      const textTop = boundingBox.maxY + 10; // 10px padding below the bounding box

      // Add the equation to the canvas
      const eqText = new IText(`${dependentVariable} = ${equation}`, {
        left: boundingBox.minX,
        top: textTop,
        fill: 'green',
        fontSize: fontSize,
        fontFamily: 'Caveat, cursive', // A handwriting-style font
        selectable: false,
        evented: false,
      });
      canvas.add(eqText);

      // Store the equation data for later use
      window.extractedEquationData = { equation, dependentVariable, scope, ranges };
    } else {
      alert(`Error: ${data.message}`);
    }
  } catch (error) {
    console.error('Error:', error);
    alert('An error occurred while processing the equation.');
  }
}

// Update event listener
document.getElementById('extract-eq-btn').addEventListener('click', extractEquation);

// Add text object to canvas on double-click
canvas.on('mouse:dblclick', function(options) {
  const pointer = canvas.getPointer(options.e);
  const text = new IText('Write equation here', {
    left: pointer.x,
    top: pointer.y,
    fill: 'red',
    fontSize: 20,
    backgroundColor: 'transparent', // No background color
    selectable: true,
    evented: true,
  });
  canvas.add(text);
  canvas.setActiveObject(text);
});
