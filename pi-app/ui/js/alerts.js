// Donation alert overlay (full-screen takeover).
//
// Shows when a donation arrives:
//   - The active alert emote (uploaded in Settings) bouncing in the center
//   - Donor name + formatted amount + (optional) message
//   - Two chamber boxes — the dispensing one lights up + pulses
//   - A status line that walks through Queued → Dispensing → Dropped / Jam
//
// State machine driven by WebSocket events from the server:
//   donation              -> show overlay (status: queued)
//   donation_dispensing   -> highlight chamber, status: dispensing
//   donation_done         -> status: dropped/jam, hide after delay
//   donation_skipped      -> status: skipped, hide after delay

import { onMessage } from './ws-client.js';
// Side-effect import: applies the saved screen-brightness CSS filter
// to every page that imports alerts.js (which is all of them). Kept
// here so individual pages don't need to remember a second import.
import './brightness.js';

const HOLD_AFTER_DONE_MS = 4000;     // how long to keep overlay up after motor done
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
const env = {
  alertEmoteUrl: null,
  chamberLabels: { 1: 'Left', 2: 'Right' },
};

function refreshEnv() {
  return fetch('/api/state')
    .then((r) => r.json())
    .then((j) => {
      if (!j || !j.ok) return;
      env.alertEmoteUrl = j.activeAlertUrl || null;
      if (j.settings && j.settings.chamberLabels) {
        env.chamberLabels = j.settings.chamberLabels;
      }
      syncChamberLabels();
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
    <div class="alert-fill">
      <div class="alert-emote-wrap">
        <img class="alert-emote" data-emote alt="" />
      </div>
      <div class="alert-amount"  data-amount></div>
      <div class="alert-name"    data-name></div>
      <div class="alert-message" data-message></div>
      <div class="alert-chambers" data-chambers>
        <div class="alert-chamber" data-chamber="1">
          <div class="alert-chamber-label" data-chamber-label="1">${env.chamberLabels[1]}</div>
          <div class="alert-chamber-light"></div>
        </div>
        <div class="alert-chamber" data-chamber="2">
          <div class="alert-chamber-label" data-chamber-label="2">${env.chamberLabels[2]}</div>
          <div class="alert-chamber-light"></div>
        </div>
      </div>
      <div class="alert-status" data-status></div>
    </div>
  `;
  document.body.appendChild(el);
  return el;
}

function ensureOverlay() {
  if (!overlay) overlay = buildOverlay();
  return overlay;
}

function syncChamberLabels() {
  if (!overlay) return;
  const a = overlay.querySelector('[data-chamber-label="1"]');
  const b = overlay.querySelector('[data-chamber-label="2"]');
  if (a) a.textContent = env.chamberLabels[1] || 'Left';
  if (b) b.textContent = env.chamberLabels[2] || 'Right';
}

function setStatus(text, kind) {
  if (!overlay) return;
  const s = overlay.querySelector('[data-status]');
  if (!s) return;
  s.textContent = text;
  s.dataset.kind = kind || '';
}

function setChamberActive(motorId) {
  if (!overlay) return;
  overlay.querySelectorAll('.alert-chamber').forEach((c) => {
    c.classList.toggle('active', String(motorId) === c.dataset.chamber);
  });
}

function setFields(evt) {
  ensureOverlay();
  overlay.querySelector('[data-amount]').textContent  = fmtAmount(evt.amount, evt.currency);
  overlay.querySelector('[data-name]').textContent    = evt.name || 'Anonymous';
  overlay.querySelector('[data-message]').textContent = evt.message || '';
  const emote = overlay.querySelector('[data-emote]');
  if (env.alertEmoteUrl) { emote.src = env.alertEmoteUrl; emote.hidden = false; }
  else                   { emote.hidden = true; }
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

function show(evt) {
  setFields(evt);
  setChamberActive(evt.motor);
  setStatus(evt.motor ? 'Queued…' : 'Thanks for the tip!', evt.motor ? 'queued' : 'no_dispense');
  showOverlay();
  state.currentId = evt.id;

  if (state.hideTimer)   clearTimeout(state.hideTimer);
  if (state.safetyTimer) clearTimeout(state.safetyTimer);
  state.safetyTimer = setTimeout(hideOverlay, HOLD_IF_STUCK_MS);
  if (!evt.motor) state.hideTimer = setTimeout(hideOverlay, HOLD_AFTER_DONE_MS);
}

onMessage('donation', (m) => {
  if (state.currentId && state.currentId !== m.id) return;
  show(m);
});

onMessage('donation_dispensing', (m) => {
  if (state.currentId !== m.id) {
    show({ id: m.id, name: m.name, amount: m.amount, motor: m.motor,
           currency: 'USD', message: '' });
  }
  setChamberActive(m.motor);
  setStatus(`Dispensing from ${m.chamberLabel || ('Chamber ' + m.motor)}…`, 'dispensing');
});

onMessage('donation_done', (m) => {
  if (state.currentId !== m.id) return;
  if (m.kind === 'dropped')   setStatus(`Dropped in ${m.ms}ms`, 'dropped');
  else if (m.kind === 'jam')  setStatus('Jam — please check chamber', 'jam');
  else                        setStatus('Done', 'done');
  if (state.hideTimer) clearTimeout(state.hideTimer);
  state.hideTimer = setTimeout(hideOverlay, HOLD_AFTER_DONE_MS);
});

onMessage('donation_skipped', (m) => {
  if (state.currentId !== m.id) return;
  setStatus(
    m.reason === 'motor_offline' ? 'Motor offline — check device' :
    m.reason === 'no_tier'       ? 'Below minimum tier' : 'Skipped',
    'skipped',
  );
  if (state.hideTimer) clearTimeout(state.hideTimer);
  state.hideTimer = setTimeout(hideOverlay, HOLD_AFTER_DONE_MS);
});

onMessage('settings_changed',    refreshEnv);
onMessage('alert_asset_changed', refreshEnv);

refreshEnv();
