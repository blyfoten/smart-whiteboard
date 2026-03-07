// src/canvas.js — canvas init, resize, bounding box, crop

import { Canvas, PencilBrush, StaticCanvas, Text } from 'fabric';

let canvasInstance = null;

export function getCanvas() {
  if (canvasInstance) {
    return canvasInstance;
  }

  try {
    const canvasElement = document.getElementById('whiteboard');
    if (!canvasElement) {
      console.error("Canvas element 'whiteboard' not found in DOM");
      return null;
    }

    if (canvasElement.__canvas) {
      canvasInstance = canvasElement.__canvas;
    } else {
      canvasInstance = new Canvas('whiteboard');
    }

    if (canvasInstance) {
      canvasInstance.isDrawingMode = true;

      if (!canvasInstance.freeDrawingBrush) {
        canvasInstance.freeDrawingBrush = new PencilBrush(canvasInstance);
      }

      if (canvasInstance.freeDrawingBrush) {
        canvasInstance.freeDrawingBrush.color = 'black';
        canvasInstance.freeDrawingBrush.width = 5;
      }

      window.canvas = canvasInstance;
      window.fabricCanvas = canvasInstance;
    }

    return canvasInstance;
  } catch (e) {
    console.error('Error getting/creating canvas:', e);
    return null;
  }
}

export function resizeCanvas(canvas) {
  const container = document.getElementById('container');
  if (!container || !canvas) return;

  const width = container.clientWidth;
  const height = container.clientHeight;
  canvas.setWidth(width);
  canvas.setHeight(height);
  canvas.renderAll();
}

export function getCanvasBoundingBox(canvas) {
  const objects = canvas.getObjects();
  if (objects.length === 0) return null;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  objects.forEach(obj => {
    const r = obj.getBoundingRect(true, false);
    if (r.left < minX) minX = r.left;
    if (r.top < minY) minY = r.top;
    if (r.left + r.width > maxX) maxX = r.left + r.width;
    if (r.top + r.height > maxY) maxY = r.top + r.height;
  });

  return { minX, minY, maxX, maxY };
}

export async function cropCanvasToBoundingBox(canvas) {
  const boundingBox = getCanvasBoundingBox(canvas);
  if (!boundingBox) {
    alert('No objects found on the canvas to crop.');
    return null;
  }

  const width = boundingBox.maxX - boundingBox.minX;
  const height = boundingBox.maxY - boundingBox.minY;

  const tempCanvas = new StaticCanvas(null, {
    backgroundColor: 'white',
    width,
    height,
  });

  const clonedObjects = await Promise.all(
    canvas.getObjects().map(obj => obj.clone())
  );

  clonedObjects.forEach(obj => {
    obj.set({
      left: obj.left - boundingBox.minX,
      top: obj.top - boundingBox.minY,
      selectable: false,
      evented: false,
    });
    tempCanvas.add(obj);
  });

  tempCanvas.renderAll();

  return tempCanvas.toDataURL({ format: 'jpeg', quality: 0.8 });
}

export function addReadyIndicator(canvas) {
  const testText = new Text('Canvas Ready', {
    left: 50,
    top: 20,
    fill: 'green',
    fontSize: 16,
    selectable: false,
    evented: false,
  });
  canvas.add(testText);
  canvas.renderAll();
}
