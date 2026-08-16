// src/debug-panel.js — the visible half of debug / bug-fix mode.
//
// Once the voice assistant hands a problem to the backend coding agent, this
// panel is where the work becomes watchable: which branch, what the agent is
// reading and editing, what it pushed, and whether the page needs reloading. It
// also carries a text box, so the session can be steered by typing when talking
// is inconvenient — and works with voice mode off entirely.
//
// Activity comes from the server over SSE (/debug/session/:id/events), which
// survives the voice WebSocket dropping — and it does drop, because the agent's
// own push restarts the server.

import { appendToOutput } from './output.js';

const STORAGE_KEY = 'sw_debug_session';

let state = null;      // last publicState from the server
let events = null;     // EventSource
let lastEventAt = 0;
let elements = null;
let sessionList = [];  // headers for the picker, newest first
let attachHook = null; // voice.js registers here so the assistant follows a switch

// voice.js calls this so that picking a different session in the panel also
// re-points the live assistant at it (the panel and the voice relay each hold
// their own binding).
export function onDebugAttachRequest(fn) {
  attachHook = fn;
}

function el(id) {
  return document.getElementById(id);
}

function cacheElements() {
  if (elements) return elements;
  elements = {
    panel: el('debug-panel'),
    title: el('debug-title'),
    meta: el('debug-meta'),
    status: el('debug-status'),
    log: el('debug-log'),
    input: el('debug-input'),
    sendBtn: el('debug-send'),
    endBtn: el('debug-end'),
    reloadBtn: el('debug-reload'),
    closeBtn: el('debug-collapse'),
    listBtn: el('debug-list-toggle'),
    list: el('debug-sessions'),
    body: el('debug-body'),
    hideBtn: el('debug-hide'),
  };
  return elements;
}

function line(text, className) {
  const { log } = cacheElements();
  if (!log) return;
  const row = document.createElement('div');
  row.className = `debug-line${className ? ` ${className}` : ''}`;
  row.textContent = text;
  log.appendChild(row);
  while (log.childElementCount > 200) log.removeChild(log.firstChild);
  log.scrollTop = log.scrollHeight;
}

// One readable line per agent event. The panel is a progress view, not a
// transcript: tool calls collapse to "what it did", not their arguments.
function describe(event) {
  switch (event.kind) {
    case 'user':
      return { text: `You: ${event.message}`, cls: 'debug-user' };
    case 'say':
      return { text: `Agent: ${event.message}`, cls: 'debug-say' };
    case 'thinking':
      return { text: event.message, cls: 'debug-thinking' };
    case 'tool': {
      const input = event.input || {};
      const target = input.path || input.pattern || input.task || input.message || '';
      return { text: `→ ${event.name}${target ? ` ${String(target).slice(0, 80)}` : ''}`, cls: 'debug-tool' };
    }
    case 'tool_result':
      return {
        text: `   ${String(event.summary || '').split('\n')[0].slice(0, 120)}`,
        cls: event.ok ? 'debug-result' : 'debug-error',
      };
    case 'done':
      return { text: `✅ ${event.summary}`, cls: 'debug-done' };
    case 'error':
      return { text: `⚠️ ${event.message}`, cls: 'debug-error' };
    case 'status':
      return { text: `— ${event.status} —`, cls: 'debug-meta-line' };
    case 'info':
      return { text: event.message, cls: 'debug-meta-line' };
    default:
      return null;
  }
}

// ---- session picker (same shape as the boards panel: pick one, drop one) ----

function ago(timestamp) {
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours}h ago` : `${Math.round(hours / 24)}d ago`;
}

function renderSessionList() {
  const e = cacheElements();
  if (!e.list) return;
  e.list.innerHTML = '';
  if (!sessionList.length) {
    const empty = document.createElement('div');
    empty.className = 'debug-session-empty';
    empty.textContent = 'No debug sessions yet — ask the assistant to fix something in the app.';
    e.list.appendChild(empty);
    return;
  }
  for (const session of sessionList) {
    const row = document.createElement('div');
    row.className = `debug-session-row${state && state.id === session.id ? ' active' : ''}`;
    row.title = `${session.branch}\n${session.lastSummary || ''}`;

    const label = document.createElement('span');
    label.className = 'debug-session-label';
    label.textContent = session.title || 'Untitled';
    label.addEventListener('click', () => openSession(session.id));

    const when = document.createElement('span');
    when.className = 'debug-session-when';
    when.textContent = `${session.status === 'working' ? '● ' : ''}${ago(session.createdAt)}`;

    const del = document.createElement('button');
    del.className = 'debug-session-del';
    del.textContent = '✕';
    del.title = 'Forget this session (its git branch is kept)';
    del.addEventListener('click', (ev) => {
      ev.stopPropagation();
      deleteSession(session.id);
    });

    row.append(label, when, del);
    e.list.appendChild(row);
  }
}

async function refreshSessionList() {
  try {
    const res = await fetch('/debug/sessions');
    const data = await res.json();
    if (data.success) {
      sessionList = data.sessions || [];
      renderSessionList();
    }
  } catch (err) { /* debug mode is off, or the server is restarting */ }
}

// Switch the panel — and the live assistant — to another session.
async function openSession(id) {
  if (state && state.id === id) return;
  closeEventStream();
  lastEventAt = 0;
  const { log } = cacheElements();
  if (log) log.innerHTML = '';
  await refreshState(id);
  if (state && state.id === id) {
    try { localStorage.setItem(STORAGE_KEY, id); } catch (e) { /* noop */ }
    openEventStream(id);
    if (attachHook) attachHook(id);
    renderSessionList();
  }
}

async function deleteSession(id) {
  try {
    const res = await fetch(`/debug/session/${encodeURIComponent(id)}`, { method: 'DELETE' });
    const data = await res.json();
    if (!data.success) {
      line(`⚠️ ${data.message || 'Could not forget that session.'}`, 'debug-error');
      return;
    }
    if (state && state.id === id) setDebugSession(null);
    await refreshSessionList();
  } catch (err) {
    line(`⚠️ ${err.message}`, 'debug-error');
  }
}

function render() {
  const e = cacheElements();
  if (!e.panel) return;
  const hasSession = !!state;
  e.body.classList.toggle('hidden', !hasSession);
  if (!hasSession) {
    e.title.textContent = 'Debug sessions';
    e.meta.textContent = '';
    e.status.textContent = '';
    e.status.className = 'debug-pill hidden';
    return;
  }
  e.title.textContent = state.title || 'Debug session';
  e.meta.textContent = `${state.branch} · ${state.model}` +
    (state.changedFiles.length ? ` · ${state.changedFiles.length} file(s)` : '') +
    (state.commits.length ? ` · ${state.commits.length} commit(s)` : '');
  e.status.textContent = state.status === 'working' ? 'working…' : state.status;
  e.reloadBtn.classList.toggle('hidden', !state.needsReload);
  e.input.disabled = state.status === 'ended';
  e.sendBtn.disabled = state.status === 'ended';
  e.endBtn.textContent = state.status === 'ended' ? 'Close' : 'End session';
}

async function post(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  return res.json();
}

function openEventStream(sessionId) {
  closeEventStream();
  if (typeof EventSource === 'undefined') return;
  events = new EventSource(`/debug/session/${encodeURIComponent(sessionId)}/events?since=${lastEventAt}`);
  events.onmessage = (message) => {
    let event;
    try { event = JSON.parse(message.data); } catch (err) { return; }
    if (event.at) lastEventAt = Math.max(lastEventAt, event.at);
    const described = describe(event);
    if (described) line(described.text, described.cls);
    if (event.kind === 'status' || event.kind === 'done') refreshState(sessionId);
  };
  // The server restarts whenever the agent pushes; EventSource reconnects on its
  // own, and `since` makes sure nothing is shown twice.
  events.onerror = () => {
    if (events && events.readyState === EventSource.CLOSED) setTimeout(() => openEventStream(sessionId), 3000);
  };
}

function closeEventStream() {
  if (events) {
    try { events.close(); } catch (e) { /* noop */ }
    events = null;
  }
}

async function refreshState(sessionId) {
  try {
    const res = await fetch(`/debug/session/${encodeURIComponent(sessionId)}`);
    const data = await res.json();
    if (data.success && data.session) {
      state = data.session;
      render();
    }
  } catch (e) { /* the server is probably mid-restart; SSE will bring us back */ }
}

// Called by voice.js when the assistant opens (or re-attaches to) a session, and
// on startup when a session from before a reload is still running.
export function setDebugSession(next) {
  if (!next) {
    state = null;
    closeEventStream();
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* noop */ }
    render();
    refreshSessionList();
    return;
  }
  const isNew = !state || state.id !== next.id;
  state = next;
  if (isNew) {
    lastEventAt = 0;
    const { log, panel } = cacheElements();
    if (log) log.innerHTML = '';
    if (panel) panel.classList.remove('hidden'); // a new session opens the panel
    try { localStorage.setItem(STORAGE_KEY, next.id); } catch (e) { /* noop */ }
    appendToOutput(
      `<b>🛠️ Debug session started</b> — "${next.title}"<br>` +
      `Branch <code>${next.branch}</code>, agent ${next.model}. Watch it work in the Debug panel; ` +
      'keep talking to steer it, or type to it directly.'
    );
    openEventStream(next.id);
  }
  render();
  refreshSessionList();
}

// The 🛠️ toolbar button: show/hide the panel (and its session list).
export function toggleDebugPanel() {
  const { panel } = cacheElements();
  if (!panel) return;
  const showing = panel.classList.toggle('hidden');
  if (!showing) refreshSessionList();
}

// Voice mode asks for this the moment it reconnects, which can be before the
// panel has finished restoring — so fall back to what the last session wrote to
// storage. The server ignores an id that no longer exists or has ended.
export function getDebugSessionId() {
  if (state) return state.id;
  try {
    return localStorage.getItem(STORAGE_KEY);
  } catch (e) {
    return null;
  }
}

async function sendMessage() {
  const e = cacheElements();
  const text = (e.input.value || '').trim();
  if (!text || !state) return;
  e.input.value = '';
  try {
    const res = await post(`/debug/session/${encodeURIComponent(state.id)}/message`, { text });
    if (!res.success) line(`⚠️ ${res.message || 'Could not reach the agent.'}`, 'debug-error');
  } catch (err) {
    line(`⚠️ ${err.message}`, 'debug-error');
  }
}

async function endSession() {
  if (!state) return;
  if (state.status === 'ended') {
    setDebugSession(null);
    return;
  }
  line('Closing the session…', 'debug-meta-line');
  try {
    const res = await post(`/debug/session/${encodeURIComponent(state.id)}/end`, { push: true });
    if (res.success) {
      appendToOutput(`<b>🛠️ Debug session closed</b> — work is on <code>${res.branch}</code>.`);
      await refreshState(state.id);
    }
  } catch (err) {
    line(`⚠️ ${err.message}`, 'debug-error');
  }
}

export function initDebugPanel() {
  const e = cacheElements();
  if (!e.panel) return;

  // The 🛠️ button only appears where the coding agent can actually run.
  const button = el('debug-btn');
  fetch('/debug/status')
    .then((res) => res.json())
    .then((data) => {
      if (!data.enabled) return;
      if (button) {
        button.classList.remove('hidden');
        button.addEventListener('click', toggleDebugPanel);
      }
      sessionList = data.sessions || [];
      renderSessionList();
    })
    .catch(() => { /* older server, or debug routes absent */ });

  e.listBtn.addEventListener('click', () => {
    const showing = e.list.classList.toggle('hidden');
    e.listBtn.textContent = showing ? '▸ Sessions' : '▾ Sessions';
    if (!showing) refreshSessionList();
  });

  e.sendBtn.addEventListener('click', sendMessage);
  e.input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      sendMessage();
    }
    ev.stopPropagation(); // typing here must not reach the canvas shortcuts
  });
  e.endBtn.addEventListener('click', endSession);
  e.reloadBtn.addEventListener('click', () => location.reload());
  e.closeBtn.addEventListener('click', () => e.panel.classList.toggle('collapsed'));
  e.hideBtn.addEventListener('click', (ev) => {
    ev.stopPropagation(); // the header itself collapses; this closes the panel
    e.panel.classList.add('hidden');
  });

  // A session that outlived a page reload (the agent's own fix usually causes
  // one) picks itself back up here.
  let stored = null;
  try { stored = localStorage.getItem(STORAGE_KEY); } catch (err) { /* noop */ }
  if (stored) {
    fetch(`/debug/session/${encodeURIComponent(stored)}`)
      .then((res) => res.json())
      .then((data) => {
        if (data.success && data.session && data.session.status !== 'ended') {
          state = data.session;
          e.panel.classList.remove('hidden'); // work still in flight — show it
          render();
          renderSessionList();
          openEventStream(data.session.id);
        } else {
          try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* noop */ }
        }
      })
      .catch(() => { /* debug mode is probably off on this server */ });
  }
}
