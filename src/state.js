// src/state.js — lightweight per-user state in cookies.
//
// Cookies (~4 KB) hold preferences and an anonymous user id — NOT the drawing
// (that needs localStorage/server, a later phase). Settings are restored to the
// DOM controls before the modules read them, and re-saved whenever they change.

const PREFIX = 'sw_';
const UID_COOKIE = 'sw_uid';

// The <select> controls whose value is a persisted preference.
const PREF_SELECTS = [
  'model-select',
  'smart-shapes-select',
  'edge-snap-select',
  'graph-grid-select',
];

export function setCookie(name, value, days = 365) {
  const expires = new Date(Date.now() + days * 864e5).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
}

export function getCookie(name) {
  const escaped = name.replace(/[.$?*|{}()[\]\\/+^]/g, '\\$&');
  const m = document.cookie.match(new RegExp(`(?:^|; )${escaped}=([^;]*)`));
  return m ? decodeURIComponent(m[1]) : null;
}

// A stable anonymous id for this browser — groundwork for claiming a user's
// boards when they later sign in. Created on first visit.
export function ensureUserId() {
  let id = getCookie(UID_COOKIE);
  if (!id) {
    id = `u-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
    setCookie(UID_COOKIE, id);
  }
  return id;
}

// Restore saved preferences onto their controls and persist future changes.
// Call BEFORE the modules that read these selects initialize.
export function initStatePersistence() {
  ensureUserId();
  PREF_SELECTS.forEach((id) => {
    const el = document.getElementById(id);
    if (!el) return;
    const saved = getCookie(PREFIX + id);
    if (saved != null && Array.from(el.options).some((o) => o.value === saved)) {
      el.value = saved;
    }
    el.addEventListener('change', () => setCookie(PREFIX + id, el.value));
  });
}
