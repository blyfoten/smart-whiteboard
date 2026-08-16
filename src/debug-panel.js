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

function render() {
  const e = cacheElements();
  if (!e.panel) return;
  if (!state) {
    e.panel.classList.add('hidden');
    return;
  }
  e.panel.classList.remove('hidden');
  e.title.textContent = state.title || 'Debug session';
  e.meta.textContent = `${state.branch} · ${state.model}` +
    (state.changedFiles.length ? ` · ${state.changedFiles.length} file(s)` : '') +
    (state.commits.length ? ` · ${state.commits.length} commit(s)` : '');
  e.status.textContent = state.status === 'working' ? 'working…' : state.status;
  e.status.className = `debug-pill debug-${state.status}`;
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
    return;
  }
  const isNew = !state || state.id !== next.id;
  state = next;
  if (isNew) {
    lastEventAt = 0;
    const { log } = cacheElements();
    if (log) log.innerHTML = '';
    try { localStorage.setItem(STORAGE_KEY, next.id); } catch (e) { /* noop */ }
    appendToOutput(
      `<b>🛠️ Debug session started</b> — "${next.title}"<br>` +
      `Branch <code>${next.branch}</code>, agent ${next.model}. Watch it work in the Debug panel; ` +
      'keep talking to steer it, or type to it directly.'
    );
    openEventStream(next.id);
  }
  render();
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
          render();
          openEventStream(data.session.id);
        } else {
          try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* noop */ }
        }
      })
      .catch(() => { /* debug mode is probably off on this server */ });
  }
}
