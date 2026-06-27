// src/canvas.js — canvas init, resize, bounding box, crop, pinch-zoom, undo

import { Canvas, PencilBrush, StaticCanvas, Point } from 'fabric';
import { undo as historyUndo, suspend as historySuspend, pushComposite } from './history.js';

let canvasInstance = null;
let _isPinching = false;
let _lastPinchDist = 0;
let _lastPinchCenter = null;

function _getTouchDistance(t1, t2) {
  const dx = t1.clientX - t2.clientX;
  const dy = t1.clientY - t2.clientY;
  return Math.sqrt(dx * dx + dy * dy);
}

function _getTouchCenter(t1, t2) {
  return {
    x: (t1.clientX + t2.clientX) / 2,
    y: (t1.clientY + t2.clientY) / 2,
  };
}

function _setupPinchZoom(canvas) {
  const upperEl = canvas.upperCanvasEl;

  // Discard any free-draw stroke that's mid-flight (e.g. the first finger of a
  // pinch already pressed down) so it isn't committed as a stray dot.
  const abortFreeDraw = () => {
    const brush = canvas.freeDrawingBrush;
    if (brush && typeof brush._reset === 'function') brush._reset();
    canvas._isCurrentlyDrawing = false;
    if (canvas.contextTop) canvas.clearContext(canvas.contextTop);
  };

  // Safety net: if a path still gets created during/just after a pinch, drop it.
  canvas.on('path:created', (e) => {
    if (_isPinching && e.path) canvas.remove(e.path);
  });

  upperEl.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      _isPinching = true;
      canvas.isDrawingMode = false;
      canvas.selection = false;
      abortFreeDraw();
      _lastPinchDist = _getTouchDistance(e.touches[0], e.touches[1]);
      _lastPinchCenter = _getTouchCenter(e.touches[0], e.touches[1]);
      e.preventDefault();
    }
  }, { passive: false });

  upperEl.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && _isPinching) {
      e.preventDefault();

      const dist = _getTouchDistance(e.touches[0], e.touches[1]);
      const center = _getTouchCenter(e.touches[0], e.touches[1]);

      // Zoom
      const scaleFactor = dist / _lastPinchDist;
      const zoom = canvas.getZoom() * scaleFactor;
      const clampedZoom = Math.min(Math.max(zoom, 0.2), 10);

      // Get canvas-relative point
      const rect = upperEl.getBoundingClientRect();
      const point = new Point(center.x - rect.left, center.y - rect.top);
      canvas.zoomToPoint(point, clampedZoom);

      // Pan
      const dx = center.x - _lastPinchCenter.x;
      const dy = center.y - _lastPinchCenter.y;
      const vpt = canvas.viewportTransform;
      vpt[4] += dx;
      vpt[5] += dy;
      canvas.setViewportTransform(vpt);

      _lastPinchDist = dist;
      _lastPinchCenter = center;
      canvas.requestRenderAll();
    }
  }, { passive: false });

  upperEl.addEventListener('touchend', (e) => {
    if (e.touches.length < 2 && _isPinching) {
      _isPinching = false;
      abortFreeDraw();
      canvas.isDrawingMode = true;
      canvas.selection = false;
    }
  });
}

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

      // Enable pinch-to-zoom on touch devices
      _setupPinchZoom(canvasInstance);

      window.canvas = canvasInstance;
      window.fabricCanvas = canvasInstance;
    }

    return canvasInstance;
  } catch (e) {
    console.error('Error getting/creating canvas:', e);
    return null;
  }
}

export function undoLast(canvas) {
  historyUndo(canvas);
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

// Crop only the given objects to a white-backed JPEG data URL (so unrelated
// clutter elsewhere on the board is excluded). Used by region/ink-scoped analyze.
export async function cropObjects(canvas, objects) {
  if (!objects || objects.length === 0) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  objects.forEach((o) => {
    const r = o.getBoundingRect(true, false);
    minX = Math.min(minX, r.left);
    minY = Math.min(minY, r.top);
    maxX = Math.max(maxX, r.left + r.width);
    maxY = Math.max(maxY, r.top + r.height);
  });
  const pad = 12;
  minX -= pad; minY -= pad; maxX += pad; maxY += pad;
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);

  const tempCanvas = new StaticCanvas(null, { backgroundColor: 'white', width, height });
  const clones = await Promise.all(objects.map((o) => o.clone()));
  clones.forEach((o) => {
    o.set({ left: o.left - minX, top: o.top - minY, selectable: false, evented: false });
    tempCanvas.add(o);
  });
  tempCanvas.renderAll();
  return tempCanvas.toDataURL({ format: 'jpeg', quality: 0.8 });
}

export function saveScreenshot(canvas) {
  if (!canvas) return;
  // Temporarily deselect so selection borders don't appear in screenshot
  canvas.discardActiveObject();
  canvas.requestRenderAll();

  const zoom = canvas.getZoom();
  const vpt = canvas.viewportTransform;
  const objects = canvas.getObjects();

  if (objects.length === 0) {
    alert('Nothing on canvas to save.');
    return;
  }

  // Calculate bounding box of all content in canvas coords
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  objects.forEach(obj => {
    const r = obj.getBoundingRect(true, true);
    if (r.left < minX) minX = r.left;
    if (r.top < minY) minY = r.top;
    if (r.left + r.width > maxX) maxX = r.left + r.width;
    if (r.top + r.height > maxY) maxY = r.top + r.height;
  });

  const padding = 20;
  const dataURL = canvas.toDataURL({
    format: 'png',
    left: minX - padding,
    top: minY - padding,
    width: (maxX - minX) + padding * 2,
    height: (maxY - minY) + padding * 2,
  });

  const link = document.createElement('a');
  link.download = `whiteboard-${Date.now()}.png`;
  link.href = dataURL;
  link.click();
}

export function clearCanvas(canvas) {
  if (!canvas) return;
  // Record the clear as one undoable step that restores everything.
  const removed = canvas.getObjects().slice();
  const prevEq = window.extractedEquationData;
  historySuspend(() => {
    canvas.clear();
    canvas.backgroundColor = 'white';
  });
  canvas.requestRenderAll();
  window.extractedEquationData = null;
  if (removed.length) {
    pushComposite((c) => {
      removed.forEach((o) => c.add(o));
      window.extractedEquationData = prevEq;
    });
  }
}

