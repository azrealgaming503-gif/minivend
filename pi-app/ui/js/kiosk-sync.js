// Kiosk content re-sync helper.
//
// While the WebSocket is connected, uploads/setting changes are pushed
// live (idle_changed, overlay_changed, sticker_changed, settings_changed)
// and the pages apply them without a reload. The one gap is when the
// kiosk *misses* a broadcast — the socket was down during the upload, or
// the page was restored from the browser's back/forward cache. In those
// cases the kiosk would show stale content until a manual refresh.
//
// This module fills that gap: pages register a resync callback via
// onResync(), and we invoke them whenever the socket reconnects or the
// page is restored, so the kiosk always catches up to the latest content.

import { onMessage } from '/js/ws-client.js';

const hooks = new Set();

// Register a function to run when the kiosk needs to re-pull content.
// The callback receives a short reason string ('reconnect' | 'restore').
export function onResync(fn) {
  hooks.add(fn);
  return () => hooks.delete(fn);
}

let debounce = null;
function resync(reason) {
  clearTimeout(debounce);
  debounce = setTimeout(() => {
    for (const fn of hooks) {
      try { fn(reason); } catch (e) { console.error('[kiosk-sync] hook failed', e); }
    }
  }, 200);
}

// Re-sync when the socket *re*connects. The very first connect is
// skipped — the page already fetched fresh state on load, so there's
// nothing to catch up on yet.
let connectedOnce = false;
onMessage('_open', () => {
  if (connectedOnce) resync('reconnect');
  connectedOnce = true;
});

// Re-sync when the page is restored from the bfcache (a back/forward
// navigation can hand back a frozen page that missed live updates).
window.addEventListener('pageshow', (e) => {
  if (e.persisted) resync('restore');
});

// Hard catch-up: a full page reload, triggered from the settings UI via
// POST /api/kiosk/reload. This re-fetches HTML/CSS/JS + /api/state, so it
// applies changes that live broadcasts can't (e.g. new CSS like the video
// fit mode, or JS added in an update). Only the physical kiosk reloads —
// it's the client served on localhost. Remote phone/laptop tabs (opened
// on the LAN IP / mDNS name) ignore it so they don't reload out from
// under whoever is editing settings.
export function isKiosk() {
  const h = location.hostname;
  return h === 'localhost' || h === '127.0.0.1' || h === '::1';
}
onMessage('kiosk_reload', () => {
  if (isKiosk()) location.reload();
});
