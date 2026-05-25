// Software brightness control for every kiosk page.
//
// Reads the current brightness from /api/state on load, applies it
// to <html> via a CSS filter, and listens for `settings_changed`
// WebSocket messages so changes from the settings page are
// reflected live on the idle screen, menu, games, etc.
//
// Pairs with the hardware-backlight write done server-side
// (settings.js -> applyHardwareBrightness). On panels with no
// backlight node this filter is the only thing dimming the screen;
// on panels with one, both apply and combine multiplicatively.
//
// Import this once near the top of any page's <script type="module">
// block — it side-effects on import.
//
// Range: 10–100 (matches the slider). Below 10 the screen would
// look broken / unrecoverable for a touchscreen user.

import { onMessage } from '/js/ws-client.js';

function applyFilter(pct) {
  const clamped = Math.max(10, Math.min(100, parseInt(pct, 10) || 100));
  // brightness(1.0) is no-op, brightness(0.1) is nearly black.
  // We hit 0.30 at the slider's floor of 10% to keep the UI legible
  // (and we already constrain server-side to >= 10).
  const v = 0.30 + (clamped - 10) * (0.70 / 90);
  document.documentElement.style.filter = `brightness(${v.toFixed(3)})`;
}

// Apply optimistically from a previous setting cached in localStorage
// so we don't briefly flash at 100% before the API call returns.
try {
  const cached = parseInt(localStorage.getItem('minivend.brightness'), 10);
  if (Number.isFinite(cached)) applyFilter(cached);
} catch (_) { /* localStorage might be blocked */ }

function setFromSettings(s) {
  if (!s || !Number.isFinite(s.brightness)) return;
  applyFilter(s.brightness);
  try { localStorage.setItem('minivend.brightness', String(s.brightness)); }
  catch (_) {}
}

fetch('/api/state')
  .then((r) => r.json())
  .then((j) => { if (j && j.ok) setFromSettings(j.settings); })
  .catch(() => {});

onMessage('settings_changed', (m) => setFromSettings(m.settings));

export { applyFilter };
