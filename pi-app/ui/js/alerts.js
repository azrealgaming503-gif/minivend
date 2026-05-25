// Donation alert overlay.
//
// Full-screen takeover that appears when a donation arrives. Shows:
//   - An animated emote (the active alert asset uploaded in Settings)
//   - The donor name + formatted amount + (optional) message
//   - A "chamber indicator" — two stacked boxes that light up to show
//     which side of the machine is dispensing this tip.
//   - A status line: "Queued", "Dispensing…", "Dropped", "Jam!", etc.
//
// State machine driven by WebSocket events from the server:
//   donation              -> show overlay (status: queued)
//   donation_dispensing   -> highlight chamber, status: dispensing
//   donation_done         -> status: dropped/jam, hide after delay
//   donation_skipped      -> status: skipped, hide after delay
//
// If multiple donations pile up faster than the cooldown, the server
// queues them FIFO and emits a sequence of donation_dispensing /
// donation_done events. The overlay tracks the *current* dispensing job
// so the streamer sees a coherent picture rather than flickering.

import { onMessage } from './ws-client.js';

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

let alertEmoteUrl = null;
function refreshAlertEmote() {
  return fetch('/api/state')
    .then((r) => r.json())
    .then((j) => { if (j && j.ok) alertEmoteUrl = j.activeAlertUrl || null; })
    .catch(() => {});
}
refreshAlertEmote();
onMessage('alert_asset_changed', refreshAlertEmote);

function ensureOverlay() {
  let el = document.getElementById('alert-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'alert-overlay';
  el.className = 'alert-overlay';
  el.innerHTML = `
    <div class="alert-fill">
      <div class="alert-emote-wrap">
        <img class="alert-emote" data-emote alt="" />
      </div>
      <div class="alert-amount" data-amount></div>
      <div class="alert-name" data-name></div>
      <div class="alert-message" data-message></div>
      <div class="alert-chambers" data-chambers>
        <div class="alert-chamber" data-chamber="1">
          <div class="alert-chamber-label" data-chamber-label="1">Left</div>
          <div class="alert-chamber-light"></div>
        </div>
        <div class="alert-chamber" data-chamber="2">
          <div class="alert-chamber-label" data-chamber-label="2">Right</div>
          <div class="alert-chamber-light"></div>
        </div>
      </div>
      <div class="alert-status" data-status></div>
    </div>
  `;
  document.body.appendChild(el);
  return el;
}

const state = {
  currentId: null,      // history id we're currently showing
  hideTimer: null,
  safetyTimer: null,
};

function setStatus(text, kind) {
  const el = ensureOverlay();
  const s = el.querySelector('[data-status]');
  s.textContent = text;
  s.dataset.kind = kind || '';
}

function setChamberActive(motorId) {
  const el = ensureOverlay();
  el.querySelectorAll('.alert-chamber').forEach((c) => {
    c.classList.toggle('active', String(motorId) === c.dataset.chamber);
  });
}

function setChamberLabels(labels) {
  const el = ensureOverlay();
  if (!labels) return;
  if (labels[1]) el.querySelector('[data-chamber-label="1"]').textContent = labels[1];
  if (labels[2]) el.querySelector('[data-chamber-label="2"]').textContent = labels[2];
}

function show(evt) {
  const el = ensureOverlay();
  el.querySelector('[data-amount]').textContent  = fmtAmount(evt.amount, evt.currency);
  el.querySelector('[data-name]').textContent    = evt.name || 'Anonymous';
  el.querySelector('[data-message]').textContent = evt.message || '';
  const emote = el.querySelector('[data-emote]');
  if (alertEmoteUrl) {
    emote.src = alertEmoteUrl;
    emote.hidden = false;
  } else {
    emote.hidden = true;
  }
  setChamberActive(evt.motor);
  if (evt.motor) {
    setStatus('Queued…', 'queued');
  } else {
    setStatus('Thanks for the tip!', 'no_dispense');
  }
  el.classList.add('visible');
  document.body.classList.add('alert-active');
  state.currentId = evt.id;

  if (state.hideTimer)   clearTimeout(state.hideTimer);
  if (state.safetyTimer) clearTimeout(state.safetyTimer);
  // If we never see a 'done' event (eg. motor offline, very long cooldown
  // queue), still drop the overlay after this cap so the cat reappears.
  state.safetyTimer = setTimeout(hide, HOLD_IF_STUCK_MS);
  // If there's no motor to wait on, schedule normal hide.
  if (!evt.motor) {
    state.hideTimer = setTimeout(hide, HOLD_AFTER_DONE_MS);
  }
}

function hide() {
  const el = document.getElementById('alert-overlay');
  if (!el) return;
  el.classList.remove('visible');
  document.body.classList.remove('alert-active');
  if (state.hideTimer)   { clearTimeout(state.hideTimer);   state.hideTimer = null; }
  if (state.safetyTimer) { clearTimeout(state.safetyTimer); state.safetyTimer = null; }
  state.currentId = null;
}

onMessage('donation', (m) => {
  // If a different donation is already on screen and not yet dispensed,
  // queue this one visually by NOT clobbering the current view. The
  // server's queue will deliver donation_dispensing in order; we'll
  // update then.
  if (state.currentId && state.currentId !== m.id) return;
  show(m);
});

onMessage('donation_dispensing', (m) => {
  // Even if we missed the initial 'donation' event (e.g. UI reloaded
  // mid-queue), show overlay now from whatever info this carries.
  if (state.currentId !== m.id) {
    show({
      id: m.id, name: m.name, amount: m.amount, motor: m.motor,
      currency: 'USD', message: '',
    });
  }
  setChamberActive(m.motor);
  setStatus(`Dispensing from ${m.chamberLabel || ('Chamber ' + m.motor)}…`, 'dispensing');
});

onMessage('donation_done', (m) => {
  if (state.currentId !== m.id) return;
  if (m.kind === 'dropped') {
    setStatus(`Dropped in ${m.ms}ms`, 'dropped');
  } else if (m.kind === 'jam') {
    setStatus('Jam — please check chamber', 'jam');
  } else {
    setStatus('Done', 'done');
  }
  if (state.hideTimer) clearTimeout(state.hideTimer);
  state.hideTimer = setTimeout(hide, HOLD_AFTER_DONE_MS);
});

onMessage('donation_skipped', (m) => {
  if (state.currentId !== m.id) return;
  setStatus(
    m.reason === 'motor_offline' ? 'Motor offline — check device' :
    m.reason === 'no_tier'       ? 'Below minimum tier' :
    'Skipped',
    'skipped',
  );
  if (state.hideTimer) clearTimeout(state.hideTimer);
  state.hideTimer = setTimeout(hide, HOLD_AFTER_DONE_MS);
});

onMessage('settings_changed', (m) => {
  if (m.settings && m.settings.chamberLabels) setChamberLabels(m.settings.chamberLabels);
});

// Pick up chamber labels on first load.
fetch('/api/state').then((r) => r.json()).then((j) => {
  if (j && j.ok && j.settings && j.settings.chamberLabels) {
    setChamberLabels(j.settings.chamberLabels);
  }
}).catch(() => {});
