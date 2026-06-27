// src/boards-panel.js — collapsible left panel to switch / manage saved boards.

import {
  listBoards, getCurrentBoardId, switchToBoard, newBoard,
  renameBoard, deleteBoard, onBoardsChanged,
} from './boards.js';

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

function renderList() {
  const list = document.getElementById('boards-list');
  if (!list) return;
  list.innerHTML = '';
  const currentId = getCurrentBoardId();

  listBoards().forEach((b) => {
    const row = el('div', 'board-row' + (b.id === currentId ? ' active' : ''));

    const name = el('span', 'board-name', b.name);
    name.title = 'Switch to this board';
    name.addEventListener('click', () => switchToBoard(b.id));

    const rename = el('button', 'board-act', '✎');
    rename.title = 'Rename';
    rename.addEventListener('click', (e) => {
      e.stopPropagation();
      const n = prompt('Rename board:', b.name);
      if (n && n.trim()) renameBoard(b.id, n.trim());
    });

    const del = el('button', 'board-act', '🗑');
    del.title = 'Delete';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      const boards = listBoards();
      if (boards.length <= 1) {
        alert('Can’t delete the last board.');
        return;
      }
      if (!confirm(`Delete “${b.name}”? This can’t be undone.`)) return;
      const wasCurrent = b.id === currentId;
      deleteBoard(b.id);
      if (wasCurrent) {
        const next = listBoards()[0];
        if (next) switchToBoard(next.id);
      }
    });

    row.appendChild(name);
    row.appendChild(rename);
    row.appendChild(del);
    list.appendChild(row);
  });
}

export function initBoardsPanel() {
  const panel = document.getElementById('boards-panel');
  if (!panel) return;

  const collapseBtn = document.getElementById('boards-collapse');
  const newBtn = document.getElementById('boards-new');

  if (collapseBtn) {
    collapseBtn.addEventListener('click', () => {
      const collapsed = panel.classList.toggle('collapsed');
      collapseBtn.textContent = collapsed ? '›' : '‹';
      collapseBtn.title = collapsed ? 'Show boards' : 'Hide boards';
    });
  }
  if (newBtn) {
    newBtn.addEventListener('click', () => newBoard());
  }

  onBoardsChanged(renderList);
  renderList();
}
