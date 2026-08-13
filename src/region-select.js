// src/region-select.js — one-shot rectangular region (lasso) selection.
//
// startRegionSelect(cb) puts the canvas into a marquee gesture: the user drags a
// dashed rectangle, and cb(region) fires with the selected rectangle in scene
// coordinates (or null if cancelled / too small). Used by "Analyze region" to
// scope handwriting analysis on a cluttered board.

import { getCanvas } from './canvas.js';
import { Rect } from 'fabric';

let _active = false;

export function isRegionSelecting() {
  return _active;
}

export function startRegionSelect(onComplete) {
  const canvas = getCanvas();
  if (!canvas || _active) return;
  _active = true;

  const prevDrawing = canvas.isDrawingMode;
  const prevSelection = canvas.selection;
  canvas.isDrawingMode = false;
  canvas.selection = false;
  canvas.defaultCursor = 'crosshair';
  canvas.setCursor('crosshair');

  let start = null;
  let rect = null;

  const finish = (region) => {
    canvas.off('mouse:down', onDown);
    canvas.off('mouse:move', onMove);
    canvas.off('mouse:up', onUp);
    if (rect) canvas.remove(rect);
    canvas.defaultCursor = 'default';
    canvas.isDrawingMode = prevDrawing;
    canvas.selection = prevSelection;
    canvas.requestRenderAll();
    _active = false;
    onComplete(region);
  };

  function onDown(opt) {
    const p = canvas.getPointer(opt.e);
    start = { x: p.x, y: p.y };
    rect = new Rect({
      left: p.x, top: p.y, width: 0, height: 0,
      fill: 'rgba(74,144,217,0.10)', stroke: '#4a90d9', strokeDashArray: [6, 4],
      strokeWidth: 1, selectable: false, evented: false, _noHistory: true,
    });
    canvas.add(rect);
  }

  function onMove(opt) {
    if (!start || !rect) return;
    const p = canvas.getPointer(opt.e);
    rect.set({
      left: Math.min(start.x, p.x), top: Math.min(start.y, p.y),
      width: Math.abs(p.x - start.x), height: Math.abs(p.y - start.y),
    });
    canvas.requestRenderAll();
  }

  function onUp() {
    if (!rect) return finish(null);
    const region = {
      minX: rect.left, minY: rect.top,
      maxX: rect.left + rect.width, maxY: rect.top + rect.height,
    };
    const big = region.maxX - region.minX > 6 && region.maxY - region.minY > 6;
    finish(big ? region : null);
  }

  canvas.on('mouse:down', onDown);
  canvas.on('mouse:move', onMove);
  canvas.on('mouse:up', onUp);
}

// Plain ink (handwriting) objects whose center lies within a region.
export function inkInRegion(canvas, region) {
  return canvas.getObjects().filter((o) => {
    if (o.type !== 'path' || o._isShape || o._isGhost || o._isGraph || o._isExtracted) return false;
    const r = o.getBoundingRect(true, false);
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    return cx >= region.minX && cx <= region.maxX && cy >= region.minY && cy <= region.maxY;
  });
}
