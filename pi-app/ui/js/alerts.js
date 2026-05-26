// Donation alert overlay (full-screen takeover).
//
// Layout (top-to-bottom on the portrait kiosk):
//   1. Donor name           — big, top of screen
//   2. Animated sticker     — center, served from /alert-sticker.gif
//                             (the server proxies + caches the upstream
//                             Discord URL so we work offline too)
//   3. Amount               — big, currency-formatted, below the sticker
//   4. Dispensing line      — "Dropping <chamber label>…" at the bottom,
//                             updates to "Dropped!" / "Jam" / etc.
//
// State machine driven by WebSocket events from the server:
//   donation              -> show overlay (status: queued or thanks)
//   donation_dispensing   -> status: dispensing
//   donation_done         -> status: dropped/jam, hide after delay
//   donation_skipped      -> status: skipped, hide after delay
//
// The server only sends `donation` events for amounts that we
// actually want to celebrate — tiers + the alertsAllAmounts toggle
// determine that. By the time we get here, the decision to show
// has already been made.

import { onMessage } from './ws-client.js';
// Side-effect import: applies the saved screen-brightness CSS filter
// to every page that imports alerts.js (which is all of them). Kept
// here so individual pages don't need to remember a second import.
import './brightness.js';

// Path is relative to the UI static root (/), so this just works on
// both the Pi and a desktop dev server. Swap by dropping a different
// image at pi-app/ui/img/blu-happy.png (or update this URL).
const STICKER_URL        = '/img/blu-happy.png';
const HOLD_AFTER_DONE_MS = 4500;     // how long to keep overlay up after motor done
const HOLD_IF_NO_MOTOR   = 5000;     // alerts with no dispense (all-amounts mode)
const HOLD_IF_STUCK_MS   = 20000;    // absolute cap (cooldown queue safety)

function fmtAmount(amount, currency) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return '';
  try {
    return new Intl.NumberFormat(undefined, {
      style: 'currency', currency: currency || 'USD', maximumFractionDigits: 2,
    }).format(n);
  } catch (_) { return `$${n.toFixed(2)}`; }
}

// --------- runtime state from /api/state ----------
// Chamber labels are read once at boot then refreshed via the
// settings_changed broadcast. We don't show a per-tip emote any
// more — every alert uses the same sticker.
const env = { chamberLabels: { 1: 'Left', 2: 'Right' } };

function refreshEnv() {
  return fetch('/api/state')
    .then((r) => r.json())
    .then((j) => {
      if (!j || !j.ok) return;
      if (j.settings && j.settings.chamberLabels) {
        env.chamberLabels = j.settings.chamberLabels;
      }
    })
    .catch(() => {});
}

// =================================================================
// Overlay element builder
// =================================================================
let overlay = null;

function buildOverlay() {
  const el = document.createElement('div');
  el.id = 'alert-overlay';
  el.className = 'alert-overlay';
  el.innerHTML = `
    <div class="alert-stack">
      <div class="alert-name"     data-name>Anonymous</div>
      <div class="alert-sticker-wrap">
        <img class="alert-sticker" data-sticker alt="" />
      </div>
      <div class="alert-amount"   data-amount>$0</div>
      <div class="alert-dispense" data-dispense>—</div>
    </div>
  `;
  // Preload the sticker so the first real alert doesn't show a
  // broken image while the GIF is still being fetched/cached.
  el.querySelector('[data-sticker]').src = STICKER_URL;
  document.body.appendChild(el);
  return el;
}

function ensureOverlay() {
  if (!overlay) overlay = buildOverlay();
  return overlay;
}

function setDispense(text, kind) {
  if (!overlay) return;
  const s = overlay.querySelector('[data-dispense]');
  if (!s) return;
  s.textContent = text;
  s.dataset.kind = kind || '';
}

function setFields(evt) {
  ensureOverlay();
  overlay.querySelector('[data-amount]').textContent = fmtAmount(evt.amount, evt.currency);
  overlay.querySelector('[data-name]').textContent   = evt.name || 'Anonymous';
  // The CSS bounce animation provides the motion — the sticker
  // itself is a static PNG so we don't bother re-setting `src` on
  // every show. If you swap STICKER_URL to an animated GIF, append
  // `?t=` + Date.now() here so back-to-back tips restart the loop.
  const sticker = overlay.querySelector('[data-sticker]');
  if (!sticker.src.endsWith(STICKER_URL)) sticker.src = STICKER_URL;
}

function showOverlay() {
  ensureOverlay();
  overlay.classList.add('visible');
  document.body.classList.add('alert-active');
}

function hideOverlay() {
  if (!overlay) return;
  overlay.classList.remove('visible');
  document.body.classList.remove('alert-active');
  if (state.hideTimer)   { clearTimeout(state.hideTimer);   state.hideTimer = null; }
  if (state.safetyTimer) { clearTimeout(state.safetyTimer); state.safetyTimer = null; }
  state.currentId = null;
}

// =================================================================
// Per-donation state machine
// =================================================================
const state = {
  currentId: null,
  hideTimer: null,
  safetyTimer: null,
};

function chamberLabelFor(motor, fallback) {
  if (!motor) return null;
  return (env.chamberLabels && env.chamberLabels[motor]) ||
         fallback || `Chamber ${motor}`;
}

function show(evt) {
  setFields(evt);
  const label = chamberLabelFor(evt.motor, evt.chamberLabel);
  if (label) setDispense(`Dropping ${label}…`, 'queued');
  else       setDispense('Thanks for the tip!', 'no_dispense');
  showOverlay();
  state.currentId = evt.id;

  if (state.hideTimer)   clearTimeout(state.hideTimer);
  if (state.safetyTimer) clearTimeout(state.safetyTimer);
  state.safetyTimer = setTimeout(hideOverlay, HOLD_IF_STUCK_MS);
  // Alerts with no associated dispense (e.g. alertsAllAmounts=true,
  // sub-tier tip) auto-hide on their own short timer.
  if (!evt.motor) state.hideTimer = setTimeout(hideOverlay, HOLD_IF_NO_MOTOR);
}

onMessage('donation', (m) => {
  if (state.currentId && state.currentId !== m.id) return;
  show(m);
});

onMessage('donation_dispensing', (m) => {
  if (state.currentId !== m.id) {
    show({ id: m.id, name: m.name, amount: m.amount, motor: m.motor,
           chamberLabel: m.chamberLabel, currency: 'USD' });
  }
  const label = chamberLabelFor(m.motor, m.chamberLabel);
  setDispense(`Dropping ${label}…`, 'dispensing');
});

onMessage('donation_done', (m) => {
  if (state.currentId !== m.id) return;
  const label = chamberLabelFor(m.motor) || 'Chamber';
  if (m.kind === 'dropped')   setDispense(`${label} dropped!`, 'dropped');
  else if (m.kind === 'jam')  setDispense(`${label} jammed — please check`, 'jam');
  else                        setDispense('Done', 'done');
  if (state.hideTimer) clearTimeout(state.hideTimer);
  state.hideTimer = setTimeout(hideOverlay, HOLD_AFTER_DONE_MS);
});

onMessage('donation_skipped', (m) => {
  if (state.currentId !== m.id) return;
  setDispense(
    m.reason === 'motor_offline' ? 'Motor offline — check device' :
    m.reason === 'no_tier'       ? 'Thanks for the tip!' : 'Skipped',
    'skipped',
  );
  if (state.hideTimer) clearTimeout(state.hideTimer);
  state.hideTimer = setTimeout(hideOverlay, HOLD_AFTER_DONE_MS);
});

onMessage('settings_changed', refreshEnv);

refreshEnv();
