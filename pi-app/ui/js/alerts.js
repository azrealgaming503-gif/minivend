// Donation alert overlay.
//
// Two visual modes, picked automatically from settings.seOverlayUrl:
//
//   "builtin"        — animated emote + name + amount + chamber boxes,
//                      branded for the kiosk. No internet needed.
//
//   "streamelements" — full-screen iframe of the streamer's SE overlay
//                      URL (the same one OBS uses), with a chamber
//                      indicator strip overlaid across the bottom.
//                      Keeps stream and kiosk visually consistent.
//
// Both modes consume the same WS event stream from the server:
//   donation              -> show overlay (status: queued)
//   donation_dispensing   -> highlight chamber, status: dispensing
//   donation_done         -> status: dropped/jam, hide after delay
//   donation_skipped      -> status: skipped, hide after delay

import { onMessage } from './ws-client.js';

const HOLD_AFTER_DONE_MS = 4000;
const HOLD_IF_STUCK_MS   = 20000;

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
  alertEmoteUrl:  null,
  seOverlayUrl:   '',
  chamberLabels:  { 1: 'Left', 2: 'Right' },
};

function refreshEnv() {
  return fetch('/api/state')
    .then((r) => r.json())
    .then((j) => {
      if (!j || !j.ok) return;
      env.alertEmoteUrl = j.activeAlertUrl || null;
      if (j.settings) {
        env.seOverlayUrl  = j.settings.seOverlayUrl  || '';
        env.chamberLabels = j.settings.chamberLabels || env.chamberLabels;
      }
      rebuildOverlay();
    })
    .catch(() => {});
}

// =================================================================
// Overlay element builder. Tears down + rebuilds when mode changes.
// =================================================================
let overlay   = null;     // root .alert-overlay element
let mode      = null;     // 'builtin' | 'streamelements'
let builtSeUrl = '';      // the seOverlayUrl baked into the current iframe

function buildBuiltin() {
  const el = document.createElement('div');
  el.id = 'alert-overlay';
  el.className = 'alert-overlay alert-overlay-builtin';
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
  return el;
}

function buildStreamElements() {
  const el = document.createElement('div');
  el.id = 'alert-overlay';
  el.className = 'alert-overlay alert-overlay-se';
  el.innerHTML = `
    <iframe class="alert-se-frame"
            src="${env.seOverlayUrl}"
            allow="autoplay; encrypted-media"
            referrerpolicy="no-referrer-when-downgrade"></iframe>
    <div class="alert-strip">
      <div class="alert-strip-chambers">
        <div class="alert-chamber" data-chamber="1">
          <div class="alert-chamber-label" data-chamber-label="1">${env.chamberLabels[1]}</div>
          <div class="alert-chamber-light"></div>
        </div>
        <div class="alert-chamber" data-chamber="2">
          <div class="alert-chamber-label" data-chamber-label="2">${env.chamberLabels[2]}</div>
          <div class="alert-chamber-light"></div>
        </div>
      </div>
      <div class="alert-strip-info">
        <div class="alert-strip-line1">
          <span class="alert-amount-small" data-amount></span>
          <span class="alert-name-small"   data-name></span>
        </div>
        <div class="alert-status alert-status-small" data-status></div>
      </div>
    </div>
  `;
  return el;
}

function rebuildOverlay() {
  const want = env.seOverlayUrl ? 'streamelements' : 'builtin';
  const sameMode = (overlay && mode === want);
  const sameUrl  = (want !== 'streamelements' || builtSeUrl === env.seOverlayUrl);
  if (sameMode && sameUrl) {
    syncChamberLabels();
    return;
  }
  if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay);
  mode = want;
  builtSeUrl = (want === 'streamelements') ? env.seOverlayUrl : '';
  overlay = (want === 'streamelements') ? buildStreamElements() : buildBuiltin();
  document.body.appendChild(overlay);
}

// ====== Public-ish view operations (work in either mode) ======
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
function setBuiltinFields(evt) {
  if (!overlay) return;
  const amt = overlay.querySelector('[data-amount]');
  const nm  = overlay.querySelector('[data-name]');
  const msg = overlay.querySelector('[data-message]');
  if (amt) amt.textContent = fmtAmount(evt.amount, evt.currency);
  if (nm)  nm.textContent  = evt.name || 'Anonymous';
  if (msg) msg.textContent = evt.message || '';
  const emote = overlay.querySelector('[data-emote]');
  if (emote) {
    if (env.alertEmoteUrl) { emote.src = env.alertEmoteUrl; emote.hidden = false; }
    else                   { emote.hidden = true; }
  }
}
function showOverlay() {
  if (!overlay) return;
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
  if (!overlay) rebuildOverlay();
  setBuiltinFields(evt);
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

// React to live settings + asset changes.
onMessage('settings_changed', refreshEnv);
onMessage('alert_asset_changed', refreshEnv);

refreshEnv();
