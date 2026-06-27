// src/boards.js — multiple whiteboards persisted to localStorage, with autosave.
//
// localStorage layout:
//   sw_boards         -> [{ id, name, updatedAt }]
//   sw_current_board  -> active board id
//   sw_board_<id>     -> serialized canvas JSON
//
// The drawing is serialized with our custom object props; edge anchors (which
// hold live object references) are saved by target id and re-resolved on load,
// and node-editing controls (functions, not serializable) are re-attached.

import { getCanvas } from './canvas.js';
import { enablePointEditing } from './node-edit.js';
import { suspend as historySuspend, clearHistory } from './history.js';

const LIST_KEY = 'sw_boards';
const CURRENT_KEY = 'sw_current_board';
const DATA_PREFIX = 'sw_board_';

// Custom object properties to persist beyond Fabric's defaults.
const EXTRA_PROPS = ['id', '_isShape', '_isGraph', '_isExtracted', '_isSteps', '_aiId', '_anchors'];

let _timer = null;
let _suspend = false;
const _listeners = [];

function uid(p) {
  return `${p}${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function readList() {
  try {
    return JSON.parse(localStorage.getItem(LIST_KEY)) || [];
  } catch (e) {
    return [];
  }
}
function writeList(list) {
  localStorage.setItem(LIST_KEY, JSON.stringify(list));
}

export function getCurrentBoardId() {
  return localStorage.getItem(CURRENT_KEY);
}
function setCurrentBoardId(id) {
  localStorage.setItem(CURRENT_KEY, id);
}

export function listBoards() {
  // Stable creation order — switching (which bumps updatedAt) must not reorder.
  return readList().slice();
}

export function onBoardsChanged(cb) {
  _listeners.push(cb);
}
function emitChanged() {
  _listeners.forEach((cb) => {
    try { cb(); } catch (e) { /* ignore */ }
  });
}

// --- serialization ---

function ensureIds(canvas) {
  canvas.getObjects().forEach((o) => {
    if (!o.id) o.id = uid('o-');
  });
}

function serializeAnchors(canvas) {
  canvas.getObjects().forEach((o) => {
    if (o._edgeAnchors) {
      const ser = {};
      Object.keys(o._edgeAnchors).forEach((k) => {
        const a = o._edgeAnchors[k];
        if (a && a.target && a.target.id) ser[k] = { targetId: a.target.id, local: a.local };
      });
      o._anchors = ser;
    } else {
      o._anchors = undefined;
    }
  });
}

function snapshot(canvas) {
  ensureIds(canvas);
  serializeAnchors(canvas);
  const data = canvas.toObject(EXTRA_PROPS);
  // Defensive: make sure custom props are present even if toObject dropped them.
  const live = canvas.getObjects();
  (data.objects || []).forEach((so, i) => {
    const o = live[i];
    if (!o) return;
    EXTRA_PROPS.forEach((p) => {
      if (o[p] !== undefined && so[p] === undefined) so[p] = o[p];
    });
  });
  return JSON.stringify(data);
}

// --- save ---

export function saveCurrent() {
  const canvas = getCanvas();
  if (!canvas) return;
  let id = getCurrentBoardId();
  if (!id) id = createBoard('Untitled');
  localStorage.setItem(DATA_PREFIX + id, snapshot(canvas));
  const list = readList();
  const entry = list.find((b) => b.id === id);
  if (entry) {
    entry.updatedAt = Date.now();
    writeList(list);
  }
}

export function scheduleAutosave() {
  if (_suspend) return;
  clearTimeout(_timer);
  _timer = setTimeout(saveCurrent, 800);
}

// --- board management ---

export function createBoard(name) {
  const id = uid('b-');
  const list = readList();
  list.push({ id, name: name || `Board ${list.length + 1}`, updatedAt: Date.now() });
  writeList(list);
  emitChanged();
  return id;
}

export function renameBoard(id, name) {
  const list = readList();
  const entry = list.find((b) => b.id === id);
  if (entry) {
    entry.name = name;
    writeList(list);
    emitChanged();
  }
}

export function deleteBoard(id) {
  let list = readList();
  list = list.filter((b) => b.id !== id);
  writeList(list);
  localStorage.removeItem(DATA_PREFIX + id);
  emitChanged();
}

function restoreAfterLoad(canvas, parsedObjects) {
  const objs = canvas.getObjects();
  // Defensive: reassign custom props by index in case Fabric dropped them.
  (parsedObjects || []).forEach((so, i) => {
    const o = objs[i];
    if (!o) return;
    EXTRA_PROPS.forEach((p) => {
      if (so[p] !== undefined) o[p] = so[p];
    });
  });

  const byId = {};
  objs.forEach((o) => { if (o.id) byId[o.id] = o; });

  objs.forEach((o) => {
    if ((o.type === 'polyline' || o.type === 'polygon') && Array.isArray(o.points)) {
      enablePointEditing(o); // re-attach draggable node controls
    }
    if (o._anchors) {
      const anchors = {};
      Object.keys(o._anchors).forEach((k) => {
        const a = o._anchors[k];
        const target = a && byId[a.targetId];
        if (target) anchors[k] = { target, local: a.local };
      });
      o._edgeAnchors = anchors;
    }
  });
}

export async function loadBoard(id) {
  const canvas = getCanvas();
  if (!canvas) return;
  setCurrentBoardId(id);
  const json = localStorage.getItem(DATA_PREFIX + id);
  _suspend = true;
  try {
    if (json) {
      const parsed = JSON.parse(json);
      await canvas.loadFromJSON(parsed);
      restoreAfterLoad(canvas, parsed.objects);
    } else {
      canvas.clear();
    }
    canvas.backgroundColor = 'white';
    canvas.discardActiveObject();
    canvas.requestRenderAll();
  } finally {
    _suspend = false;
  }
  clearHistory(); // a freshly loaded board starts with an empty undo stack
  window.extractedEquationData = null;
  emitChanged();
}

// Save the current board, then switch to another.
export async function switchToBoard(id) {
  saveCurrent();
  await loadBoard(id);
}

// Create a new blank board and switch to it.
export async function newBoard() {
  saveCurrent();
  const id = createBoard();
  _suspend = true;
  try {
    const canvas = getCanvas();
    canvas.clear();
    canvas.backgroundColor = 'white';
    canvas.requestRenderAll();
  } finally {
    _suspend = false;
  }
  setCurrentBoardId(id);
  clearHistory();
  window.extractedEquationData = null;
  saveCurrent();
  emitChanged();
  return id;
}

// Initialize: load the active board (or create the first one), then autosave.
export async function initBoards() {
  const canvas = getCanvas();
  if (!canvas) return;

  const id = getCurrentBoardId();
  const list = readList();
  if (id && list.find((b) => b.id === id) && localStorage.getItem(DATA_PREFIX + id)) {
    await loadBoard(id);
  } else {
    historySuspend(() => {
      canvas.clear();
      canvas.backgroundColor = 'white';
      canvas.requestRenderAll();
    });
    const newId = createBoard('Board 1');
    setCurrentBoardId(newId);
    clearHistory();
    saveCurrent();
  }

  ['object:added', 'object:removed', 'object:modified', 'path:created'].forEach((ev) =>
    canvas.on(ev, scheduleAutosave)
  );
  window.addEventListener('beforeunload', saveCurrent);
}
