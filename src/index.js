// src/index.js

import { Canvas, IText, Text, Rect, PencilBrush, StaticCanvas } from 'fabric';
import Chart from 'chart.js/auto';

// Make PencilBrush globally available
window.PencilBrush = PencilBrush;

// Global variables for model selection
let currentModel = 'math'; // Default model: math, gpt, or gemini
let canvasInstance = null;
let graphChart = null;

// Add a global function to get or create the canvas
window.getCanvas = function() {
  if (canvasInstance) {
    return canvasInstance;
  }
  
  try {
    const canvasElement = document.getElementById('whiteboard');
    if (canvasElement) {
      // Check if it's already been initialized with Fabric
      if (canvasElement.__canvas) {
        canvasInstance = canvasElement.__canvas;
        console.log("Retrieved existing Fabric canvas instance");
      } else {
        // Create a new instance
        canvasInstance = new Canvas('whiteboard');
        console.log("Created new Fabric canvas instance");
      }
      
      // Make sure the canvas is properly set up
      if (canvasInstance) {
        // Set drawing mode
        canvasInstance.isDrawingMode = true;
        
        // Initialize the brush if needed
        if (!canvasInstance.freeDrawingBrush) {
          console.log("Creating new drawing brush");
          canvasInstance.freeDrawingBrush = new PencilBrush(canvasInstance);
        }
        
        // Only set brush properties if freeDrawingBrush exists
        if (canvasInstance.freeDrawingBrush) {
          canvasInstance.freeDrawingBrush.color = "black";
          canvasInstance.freeDrawingBrush.width = 5;
          console.log("Drawing brush configured");
        } else {
          console.warn("Could not initialize freeDrawingBrush");
        }
        
        // Store references globally
        window.canvas = canvasInstance;
        window.fabricCanvas = canvasInstance;
      }
      
      return canvasInstance;
    } else {
      console.error("Canvas element 'whiteboard' not found in DOM");
      return null;
    }
  } catch (e) {
    console.error("Error getting/creating canvas:", e);
    return null;
  }
};

// Expose the currentModel to the window object
window.currentModel = currentModel;
window.setCurrentModel = function(model) {
  currentModel = model;
  window.currentModel = model;
  console.log(`Model changed to: ${model}`);
};

// Function to adjust canvas size
function resizeCanvas(canvas) {
  const container = document.getElementById('container');
  if (!container || !canvas) return;
  
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
  const debugOutput = document.getElementById('debug-output');
  if (debugOutput) {
    debugOutput.textContent = 'solveEquation function called';
  }
  
  console.log("Solve equation function called");
  
  // Get canvas using our global function
  const canvasToUse = window.getCanvas();
  
  if (!canvasToUse) {
    console.error("Failed to get canvas - falling back to direct equation input");
    // Offer the user a chance to enter an equation directly
    const equation = prompt("Canvas not found. Enter an equation to solve directly (e.g. x^2 + 3*x - 5 = 0):");
    if (!equation) return;
    
    console.log(`Using direct equation input: ${equation}`);
    if (debugOutput) {
      debugOutput.textContent = `Using direct equation: ${equation}`;
    }
    
    // Send to server
    solveEquationFromText(equation);
    return;
  }
  
  // Log all objects on canvas
  console.log("All canvas objects:", canvasToUse.getObjects().map(o => `${o.type}: ${o.text || 'no text'}`));
  
  const objects = canvasToUse.getObjects('i-text');
  let equation;
  
  if (objects.length === 0) {
    // Try to find any text objects if i-text is not found
    const allTextObjects = canvasToUse.getObjects().filter(obj => 
      obj.type === 'text' || obj.type === 'i-text');
    
    if (allTextObjects.length === 0) {
      if (debugOutput) {
        debugOutput.textContent = 'No equation found on canvas';
      }
      alert('No equation found to solve. Please add an equation first.');
      return;
    }
    
    // Use the first text object found
    equation = allTextObjects[0].text;
    console.log(`Found equation: ${equation} (type: ${allTextObjects[0].type})`);
    if (debugOutput) {
      debugOutput.textContent = `Found equation: ${equation}`;
    }
  } else {
    equation = objects[0].text;
    console.log(`Found i-text equation: ${equation}`);
    if (debugOutput) {
      debugOutput.textContent = `Found i-text equation: ${equation}`;
    }
  }
  
  console.log(`Using model: ${currentModel} to solve equation: ${equation}`);
  if (debugOutput) {
    debugOutput.textContent += ` - Using model: ${currentModel}`;
  }
  
  // Use a separate function for the actual solving
  solveEquationFromText(equation);
}

// Function to solve equation from text
function solveEquationFromText(equation) {
  // Show loading indicator in output panel
  if (window.appendToOutput) {
    window.appendToOutput(`<b>Solving equation:</b> ${equation}<br><b>Using model:</b> ${currentModel}<br><i>Loading...</i>`);
  }
  
  fetch('/solve', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ equation, model: currentModel })
  })
  .then(response => {
    console.log("Received response from server");
    return response.json();
  })
  .then(data => {
    console.log("Response data:", data);
    
    if (data.success) {
      // Display the result in the output panel instead of on the canvas
      if (window.appendToOutput) {
        let outputHtml = `<b>Equation:</b> ${equation}<br>`;
        outputHtml += `<b>Model:</b> ${currentModel}<br>`;
        outputHtml += `<b>Solution:</b><br>${data.result}`;
        
        window.appendToOutput(outputHtml);
      } else {
        // Fallback if appendToOutput is not available
        alert(`Result: ${data.result}`);
      }
    } else {
      if (window.appendToOutput) {
        window.appendToOutput(`<b>Error solving equation:</b><br>${data.message || 'Unknown error'}`, true);
      } else {
        alert(data.message || 'Error solving equation');
      }
    }
  })
  .catch(error => {
    console.error('Error:', error);
    if (window.appendToOutput) {
      window.appendToOutput(`<b>Error:</b><br>${error.message || 'Communication error with server'}`, true);
    } else {
      alert('Error communicating with the server');
    }
  });
}

// Expose the solveEquation function to the window object
window.solveEquation = solveEquation;

// Update the drawGraph function
async function drawGraph() {
  if (!window.extractedEquationData) {
    if (window.appendToOutput) {
      window.appendToOutput('<b>Error:</b><br>No equation extracted. Please extract an equation first.', true);
    } else {
      alert('No equation extracted. Please extract an equation first.');
    }
    return;
  }

  const { equation, dependentVariable, scope, ranges } = window.extractedEquationData;
  
  // Show graph creation in progress
  if (window.appendToOutput) {
    window.appendToOutput(`<b>Graphing equation:</b> ${dependentVariable} = ${equation}<br><i>Processing...</i>`);
  }

  try {
    const response = await fetch('/graph', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expression: equation, dependentVariable, scope, ranges })
    });
    const data = await response.json();

    if (data.success) {
      renderGraph(data.data, dependentVariable);
      
      // Show graph creation success
      if (window.appendToOutput) {
        let outputHtml = `<b>Graph created for:</b> ${dependentVariable} = ${equation}<br>`;
        outputHtml += `<b>Points:</b> ${data.data.length}<br>`;
        outputHtml += `<b>Range:</b> [${ranges[Object.keys(ranges)[0]][0]}, ${ranges[Object.keys(ranges)[0]][1]}]<br>`;
        outputHtml += '<i>Graph displayed in bottom-right corner</i>';
        window.appendToOutput(outputHtml);
      }
    } else {
      if (window.appendToOutput) {
        window.appendToOutput(`<b>Error generating graph:</b><br>${data.message || 'Unknown error'}`, true);
      } else {
        alert(data.message);
      }
    }
  } catch (error) {
    console.error('Error:', error);
    if (window.appendToOutput) {
      window.appendToOutput(`<b>Error:</b><br>${error.message || 'Failed to generate graph'}`, true);
    } else {
      alert('Error generating graph');
    }
  }
}

// Function to render graph
function renderGraph(dataPoints, dependentVariable) {
  // Get the graph container
  const graphContainer = document.getElementById('graph-container');
  if (!graphContainer) {
    console.error("Graph container not found");
    return;
  }
  
  // Show the graph container
  graphContainer.style.display = 'block';
  
  // Get the canvas for the graph
  const graphCanvas = document.getElementById('graph-canvas');
  if (!graphCanvas) {
    console.error("Graph canvas not found");
    return;
  }
  
  // Destroy previous chart if it exists
  if (graphChart) {
    graphChart.destroy();
  }
  
  try {
    // Create new chart
    graphChart = new Chart(graphCanvas, {
      type: 'line',
      data: {
        datasets: [{
          label: `${dependentVariable} = f(x)`,
          data: dataPoints.map(point => ({ x: point.x, y: point.y })),
          borderColor: 'rgb(75, 192, 192)',
          tension: 0.1,
          fill: false
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
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
    
    console.log("Graph rendered successfully");
  } catch (e) {
    console.error("Error rendering graph:", e);
  }
}

// Update the extractEquation function
async function extractEquation() {
  // Get canvas using our global function
  const canvasToUse = window.getCanvas();
  
  if (!canvasToUse) {
    console.error("No canvas found for extracting equation");
    alert("Canvas not found! Please refresh the page and try again.");
    return;
  }
  
  const boundingBox = getCanvasBoundingBox(canvasToUse);
  const croppedDataURL = await cropCanvasToBoundingBox(canvasToUse);
  
  if (!croppedDataURL || !boundingBox) {
    alert('No objects found on the canvas to extract equation from.');
    return;
  }

  try {
    // Show extraction in progress message
    if (window.appendToOutput) {
      window.appendToOutput(`<b>Extracting equation from canvas</b><br><i>Using model: ${currentModel}</i><br><i>Processing...</i>`);
    }
    
    // Determine which endpoint to use based on the selected model
    const endpoint = currentModel === 'gemini' ? '/extract-equation-gemini' : '/extract-equation';
    
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: croppedDataURL })
    });
    const data = await response.json();

    if (data.success) {
      const { equation, dependentVariable, scope, ranges } = data;
      console.log(`Extracted Equation: ${equation}`);
      
      // Display the result in the output panel
      if (window.appendToOutput) {
        let outputHtml = `<b>Extracted Equation:</b> ${dependentVariable} = ${equation}<br>`;
        outputHtml += `<b>Variables:</b> ${Object.keys(scope).join(', ')}<br>`;
        outputHtml += `<b>Ranges:</b><br>`;
        for (const [variable, range] of Object.entries(ranges)) {
          outputHtml += `${variable}: [${range[0]}, ${range[1]}]<br>`;
        }
        window.appendToOutput(outputHtml);
      }
      
      // Calculate font size and position
      const boxHeight = boundingBox.maxY - boundingBox.minY;
      const fontSize = Math.round(boxHeight * 0.9);
      const textTop = boundingBox.maxY + 10; // 10px padding below the bounding box

      // Add the equation to the canvas in green color
      const eqText = new IText(`${dependentVariable} = ${equation}`, {
        left: boundingBox.minX,
        top: textTop,
        fill: 'green',
        fontSize: fontSize,
        fontFamily: 'Caveat, cursive', // A handwriting-style font
        selectable: false,
        evented: false,
      });
      canvasToUse.add(eqText);

      // Store the equation data for later use
      window.extractedEquationData = { equation, dependentVariable, scope, ranges };

      // Draw the graph immediately after extraction
      await drawGraph();
    } else {
      if (window.appendToOutput) {
        window.appendToOutput(`<b>Error extracting equation:</b><br>${data.message || 'Unknown error'}`, true);
      } else {
        alert(`Error: ${data.message}`);
      }
    }
  } catch (error) {
    console.error('Error:', error);
    if (window.appendToOutput) {
      window.appendToOutput(`<b>Error:</b><br>${error.message || 'Unknown error during extraction'}`, true);
    } else {
      alert('An error occurred while processing the equation.');
    }
  }
}

// Add text object to canvas on double-click
function setupCanvasEventListeners() {
  const canvas = window.getCanvas();
  if (!canvas) {
    console.error("Cannot setup event listeners - canvas not found");
    return;
  }
  
  canvas.on('mouse:dblclick', function(options) {
    const pointer = canvas.getPointer(options.e);
    const text = new IText('Write equation here', {
      left: pointer.x,
      top: pointer.y,
      fill: 'red',
      fontSize: 20,
      backgroundColor: 'transparent', // No background color
      selectable: true,
      editable: true,
      fontFamily: 'Arial'
    });
    canvas.add(text);
    canvas.setActiveObject(text);
    
    // Automatically put the text in edit mode
    text.enterEditing();
    text.selectAll();
  });
  
  console.log("Canvas double-click event listener attached");
}

// Add UI controls for model selection
function initializeModelSelectionUI() {
  const existingModelSelect = document.getElementById('model-select');
  
  if (existingModelSelect) {
    console.log('Using existing model select dropdown from HTML');
    
    // Just make sure we're properly listening to it
    // First remove any duplicate listeners
    const newSelect = existingModelSelect.cloneNode(true);
    existingModelSelect.parentNode.replaceChild(newSelect, existingModelSelect);
    
    // Add our listener
    newSelect.addEventListener('change', (e) => {
      currentModel = e.target.value;
      window.currentModel = e.target.value;
      console.log(`Model changed to: ${e.target.value}`);
    });
    
    // Set the initial value
    if (newSelect.value) {
      currentModel = newSelect.value;
      window.currentModel = newSelect.value;
      console.log(`Initial model set to: ${newSelect.value}`);
    }
    
    return;
  }
  
  console.log('No existing model select found, creating one');
  
  // If we get here, there's no existing select in the HTML, so we'll create one
  const uiElement = document.querySelector('.ui-element');
  if (!uiElement) {
    console.error('UI element not found');
    return;
  }
  
  // Create model selection dropdown
  const modelSelectContainer = document.createElement('div');
  modelSelectContainer.style.marginTop = '10px';
  
  const modelSelectLabel = document.createElement('label');
  modelSelectLabel.textContent = 'AI Model: ';
  modelSelectLabel.setAttribute('for', 'model-select');
  
  const modelSelect = document.createElement('select');
  modelSelect.id = 'model-select';
  
  const options = [
    { value: 'math', text: 'Math.js (Simple)' },
    { value: 'gpt', text: 'GPT (Advanced)' },
    { value: 'gemini', text: 'Gemini (Advanced)' }
  ];
  
  options.forEach(option => {
    const optionElement = document.createElement('option');
    optionElement.value = option.value;
    optionElement.textContent = option.text;
    modelSelect.appendChild(optionElement);
  });
  
  // Add event listener for model changes
  modelSelect.addEventListener('change', (e) => {
    currentModel = e.target.value;
    window.currentModel = e.target.value;
    console.log(`Model changed to: ${e.target.value}`);
  });
  
  modelSelectContainer.appendChild(modelSelectLabel);
  modelSelectContainer.appendChild(modelSelect);
  uiElement.appendChild(modelSelectContainer);
}

// Initialize event listeners
function initializeEventListeners() {
  // Voice recognition button
  const startRecordBtn = document.getElementById('start-record-btn');
  if (startRecordBtn) {
    startRecordBtn.addEventListener('click', () => {
      if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
        if (!recognizing) {
          recognition.start();
        } else {
          recognition.stop();
        }
      } else {
        alert('Web Speech API is not supported in this browser.');
      }
    });
  }
  
  // Extract equation button
  const extractEqBtn = document.getElementById('extract-eq-btn');
  if (extractEqBtn) {
    extractEqBtn.addEventListener('click', extractEquation);
  }
  
  // Add a solve button if it doesn't exist
  const uiElement = document.querySelector('.ui-element');
  if (uiElement) {
    // Check if solve button already exists
    if (!document.getElementById('solve-eq-btn')) {
      const solveBtn = document.createElement('button');
      solveBtn.id = 'solve-eq-btn';
      solveBtn.textContent = 'Solve Equation';
      solveBtn.addEventListener('click', solveEquation);
      
      // Insert after extract button
      uiElement.insertBefore(solveBtn, document.getElementById('status'));
    }
    
    // Check if graph button already exists
    if (!document.getElementById('graph-btn')) {
      const graphBtn = document.createElement('button');
      graphBtn.id = 'graph-btn';
      graphBtn.textContent = 'Draw Graph';
      graphBtn.addEventListener('click', drawGraph);
      
      // Insert after solve button or extract button
      const solveBtn = document.getElementById('solve-eq-btn');
      if (solveBtn) {
        uiElement.insertBefore(graphBtn, solveBtn.nextSibling);
      } else {
        uiElement.insertBefore(graphBtn, document.getElementById('status'));
      }
    }
  }
}

// Initialize speech recognition
function initializeSpeechRecognition() {
  if ('webkitSpeechRecognition' in window || 'SpeechRecognition' in window) {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    recognition = new SpeechRecognition();
    recognition.lang = 'sv-SE'; // Swedish
    recognition.continuous = false;
    recognition.interimResults = false;

    recognition.onstart = function() {
      recognizing = true;
      status.textContent = 'Voice recognition started. Speak now.';
    };

    recognition.onresult = function(event) {
      const transcript = event.results[0][0].transcript.trim().toLowerCase();
      handleCommand(transcript);
    };

    recognition.onerror = function(event) {
      console.error('Speech recognition error', event.error);
      status.textContent = 'Error: ' + event.error;
      recognizing = false;
    };

    recognition.onend = function() {
      recognizing = false;
      status.textContent = 'Voice recognition ended.';
    };
  } else {
    console.warn('Web Speech API is not supported in this browser.');
    status.textContent = 'Speech recognition not supported.';
  }
}

// Initialize the application
document.addEventListener('DOMContentLoaded', () => {
  console.log('DOM fully loaded and parsed');
  
  // Variables for recognition
  window.recognition = null;
  window.recognizing = false;
  window.status = document.getElementById('status');
  
  try {
    console.log("Initializing canvas...");
    
    // Use our global function to get/create the canvas
    const canvas = window.getCanvas();
    
    if (canvas) {
      console.log("Canvas initialized successfully");
      
      // Resize the canvas to fit the container
      resizeCanvas(canvas);
      window.addEventListener('resize', () => resizeCanvas(canvas));
      
      // Add a test object to verify canvas is working
      const testText = new Text("Canvas Ready", {
        left: 50,
        top: 20,
        fill: 'green',
        fontSize: 16,
        selectable: false,
        evented: false,
      });
      canvas.add(testText);
      canvas.renderAll();
      console.log("Test object added to canvas");
      
      // Set up canvas event listeners
      setupCanvasEventListeners();
    } else {
      console.error("Failed to initialize canvas");
    }
  } catch (e) {
    console.error("Canvas initialization error:", e);
  }
  
  // Initialize speech recognition
  initializeSpeechRecognition();
  
  // Add UI controls including model selection
  initializeModelSelectionUI();
  
  // Initialize event listeners for buttons
  initializeEventListeners();
  
  // Make sure solve button is connected properly
  const solveBtn = document.getElementById('solve-eq-btn');
  if (solveBtn) {
    // Remove any existing listeners to avoid duplication
    const newSolveBtn = solveBtn.cloneNode(true);
    solveBtn.parentNode.replaceChild(newSolveBtn, solveBtn);
    
    // Add new event listener
    newSolveBtn.addEventListener('click', () => {
      console.log('Solve button clicked');
      solveEquation();
    });
    console.log("Solve button event listener attached");
  } else {
    console.error("Solve button not found!");
  }
  
  // Extract equation button
  const extractBtn = document.getElementById('extract-eq-btn');
  if (extractBtn) {
    // Remove any existing listeners to avoid duplication
    const newExtractBtn = extractBtn.cloneNode(true);
    extractBtn.parentNode.replaceChild(newExtractBtn, extractBtn);
    
    // Add new event listener
    newExtractBtn.addEventListener('click', () => {
      console.log('Extract button clicked');
      extractEquation();
    });
    console.log("Extract button event listener attached");
  }
  
  // Draw graph button
  const graphBtn = document.getElementById('graph-btn');
  if (graphBtn) {
    // Remove any existing listeners to avoid duplication
    const newGraphBtn = graphBtn.cloneNode(true);
    graphBtn.parentNode.replaceChild(newGraphBtn, graphBtn);
    
    // Add new event listener
    newGraphBtn.addEventListener('click', () => {
      console.log('Graph button clicked');
      drawGraph();
    });
    console.log("Graph button event listener attached");
  }
  
  // Add or ensure "force solve" button exists
  const uiElement = document.querySelector('.ui-element');
  if (uiElement) {
    // Check if the button already exists
    let forceSolveBtn = document.getElementById('force-solve-btn');
    
    if (!forceSolveBtn) {
      // Create new button if it doesn't exist
      forceSolveBtn = document.createElement('button');
      forceSolveBtn.id = 'force-solve-btn';
      forceSolveBtn.textContent = 'Force Solve';
      forceSolveBtn.style.backgroundColor = '#ffdddd';
      
      // Find where to insert the button
      const debugOutput = document.getElementById('debug-output');
      if (debugOutput) {
        uiElement.insertBefore(forceSolveBtn, debugOutput);
      } else {
        uiElement.appendChild(forceSolveBtn);
      }
      console.log("Force Solve button added");
    } else {
      // Button exists, replace it to remove old event listeners
      const newForceSolveBtn = forceSolveBtn.cloneNode(true);
      forceSolveBtn.parentNode.replaceChild(newForceSolveBtn, forceSolveBtn);
      forceSolveBtn = newForceSolveBtn;
      console.log("Force Solve button refreshed");
    }
    
    // Add the event listener
    forceSolveBtn.addEventListener('click', () => {
      const equation = prompt("Enter equation to solve (e.g. x^2 + 3*x - 5 = 0):");
      if (equation) {
        console.log(`Force solving equation: ${equation}`);
        fetch('/solve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ equation, model: currentModel })
        })
        .then(response => response.json())
        .then(data => {
          if (data.success) {
            alert(`Result: ${data.result}`);
          } else {
            alert(`Error: ${data.message}`);
          }
        })
        .catch(error => {
          console.error("Error:", error);
          alert(`Error: ${error.message}`);
        });
      }
    });
  }
  
  console.log('App initialized successfully');
});
