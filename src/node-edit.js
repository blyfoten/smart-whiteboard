// src/node-edit.js — make a Fabric Polyline's vertices draggable in Select mode.
//
// Each vertex becomes a custom Fabric control: selecting the polyline shows a
// round handle at every node that can be dragged to reshape it, while the body
// still drags to move. This is the canonical Fabric v6 polygon-edit technique
// (positionHandler maps a point to the screen; actionHandler maps the pointer
// back into the polyline's point space; the anchor keeps the rest of the shape
// fixed while one node moves).

import { Control, Point, util } from 'fabric';

const { invertTransform, multiplyTransformMatrices } = util;

// Where to draw the handle for point `control.pointIndex`, in screen space.
function pointPositionHandler(dim, finalMatrix, obj, control) {
  const p = new Point(
    obj.points[control.pointIndex].x - obj.pathOffset.x,
    obj.points[control.pointIndex].y - obj.pathOffset.y
  );
  return p.transform(
    multiplyTransformMatrices(obj.canvas.viewportTransform, obj.calcTransformMatrix())
  );
}

// Drag handler for a specific point index (captured by closure, so we don't
// depend on Fabric's internal "current corner" bookkeeping).
function makeActionHandler(pointIndex) {
  return function actionHandler(eventData, transform, x, y) {
    const obj = transform.target;
    const local = new Point(x, y).transform(invertTransform(obj.calcTransformMatrix()));
    const base = obj._getNonTransformedDimensions();
    const size = obj._getTransformedDimensions();
    obj.points[pointIndex] = new Point(
      size.x ? (local.x * base.x) / size.x + obj.pathOffset.x : obj.pathOffset.x,
      size.y ? (local.y * base.y) / size.y + obj.pathOffset.y : obj.pathOffset.y
    );
    return true;
  };
}

// Keep `anchorIndex`'s point fixed in place while another point is dragged
// (recomputing the bounding box would otherwise shift the whole shape).
function anchorWrapper(anchorIndex, fn) {
  return function (eventData, transform, x, y) {
    const obj = transform.target;
    const before = new Point(
      obj.points[anchorIndex].x - obj.pathOffset.x,
      obj.points[anchorIndex].y - obj.pathOffset.y
    ).transform(obj.calcTransformMatrix());
    const performed = fn(eventData, transform, x, y);
    obj.setBoundingBox(true);
    const base = obj._getNonTransformedDimensions();
    const newX = (obj.points[anchorIndex].x - obj.pathOffset.x) / (base.x || 1);
    const newY = (obj.points[anchorIndex].y - obj.pathOffset.y) / (base.y || 1);
    obj.setPositionByOrigin(before, newX + 0.5, newY + 0.5);
    return performed;
  };
}

// The scene-space position of vertex `index`.
export function getVertexScenePosition(poly, index) {
  const p = new Point(poly.points[index].x - poly.pathOffset.x, poly.points[index].y - poly.pathOffset.y);
  return p.transform(poly.calcTransformMatrix());
}

// Move vertex `index` of a polyline/polygon to a scene-space point, keeping the
// other vertices fixed — same math as dragging its control. Used by sticky edge
// anchors to follow a shape as it moves.
export function applyVertexSceneMove(poly, index, scenePoint) {
  if (!poly || !Array.isArray(poly.points)) return;
  const n = poly.points.length;
  if (index < 0 || index >= n) return;
  const anchor = index > 0 ? index - 1 : n - 1;
  anchorWrapper(anchor, makeActionHandler(index))(null, { target: poly }, scenePoint.x, scenePoint.y);
  poly.setCoords();
}

function renderHandle(ctx, left, top) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(left, top, 6, 0, 2 * Math.PI);
  ctx.fillStyle = '#fff';
  ctx.strokeStyle = '#4a90d9';
  ctx.lineWidth = 2;
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// Replace an editable polyline's transform controls with one handle per vertex.
// Body-drag still moves it; the corner/rotate handles (scaling) are dropped in
// favour of node editing.
export function enablePointEditing(obj) {
  if (!obj || !Array.isArray(obj.points) || obj.points.length < 2) return;
  const n = obj.points.length;
  const controls = {};
  obj.points.forEach((_, i) => {
    const anchor = i > 0 ? i - 1 : n - 1; // a different point stays put while i moves
    controls['p' + i] = new Control({
      pointIndex: i,
      actionName: 'editNode',
      cursorStyle: 'crosshair',
      positionHandler: pointPositionHandler,
      actionHandler: anchorWrapper(anchor, makeActionHandler(i)),
      render: renderHandle,
    });
  });
  obj.controls = controls;
  obj.objectCaching = false;
  obj.hasBorders = false;
  obj._nodeEditable = true;
}
