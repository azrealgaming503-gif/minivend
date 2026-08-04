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
// If a StreamElements overlay URL is configured, that page is kept loaded
// fullscreen (OBS browser-source style) and the built-in alert UI is skipped
// for that event type — SE drives the celebration over its own socket.
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
// Re-pull live content (sticker/overlay/settings) when the socket
// reconnects or the page is restored, so the kiosk never shows stale
// uploads after missing a broadcast. See ui/js/kiosk-sync.js.
import { onResync } from './kiosk-sync.js';
// Side-effect import: applies the saved screen-brightness CSS filter
// to every page that imports alerts.js (which is all of them). Kept
// here so individual pages don't need to remember a second import.
import './brightness.js';
// Side-effect import: tap-reliability helper. Re-fires a click when the
// flaky panel drops it (touch-up drifting off the button), without ever
// blocking real taps. Touch only.
import './press-guard.js';

// Preload Indie Flower on every settings/menu/game page (all import
// alerts.js). Without this, Chromium may paint one frame in the UA
// default before @font-face finishes loading on a cold boot.
(function preloadIndieFlower() {
  const href = '/fonts/indie-flower.woff2';
  if (!document.querySelector(`link[rel="preload"][href="${href}"]`)) {
    const link = document.createElement('link');
    link.rel = 'preload';
    link.href = href;
    link.as = 'font';
    link.type = 'font/woff2';
    link.crossOrigin = 'anonymous';
    document.head.appendChild(link);
  }
  if (document.fonts) {
    document.fonts.load('400 16px "Indie Flower"').catch(() => {});
  }
})();

// Served from /api/state `stickerUrl` (default blu-happy.png). USB
// import on Settings can replace blu-happy.png / blu-happy.gif.
let stickerUrl = '/img/blu-happy.png';
let donationStickerUrl = null;  // custom donation overlay GIF (overrides blu-happy)
let redeemStickerUrl   = null;  // custom redeem overlay GIF (optional)
// StreamElements overlays from the Overlays page.
// Each entry: { id, name, url, active, targets: [...] }
let seOverlays = [];

function seIsActive(o) {
  return !!(o && o.active !== false);
}

function seHasTarget(target) {
  return seOverlays.some((o) =>
    seIsActive(o) && Array.isArray(o.targets) && o.targets.includes(target));
}

function seUrlsForTargets(targets) {
  const want = new Set(targets);
  const urls = [];
  for (const o of seOverlays) {
    if (!seIsActive(o) || !o.url || !Array.isArray(o.targets)) continue;
    if (o.targets.some((t) => want.has(t)) && !urls.includes(o.url)) urls.push(o.url);
  }
  return urls;
}
// Overlay hold durations (ms). Configurable via settings and refreshed
// from /api/state + settings_changed. donationHoldMs covers both the
// after-dispense hold and alert-only tips; redeemHoldMs is the redeem
// overlay's display time.
let donationHoldMs = 5000;           // settings.donationOverlaySec
let redeemHoldMs   = 7000;           // settings.redeemOverlaySec
const HOLD_IF_STUCK_MS = 20000;      // absolute cap (safety)

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

// The donation overlay shows the custom uploaded GIF if one is set,
// otherwise the default blu-happy sticker.
function currentDonationSticker() { return donationStickerUrl || stickerUrl; }

function updateDonationSticker(bust) {
  const img = overlay && overlay.querySelector('[data-sticker]');
  if (!img) return;
  const base = currentDonationSticker();
  img.src = bust ? `${base}${base.includes('?') ? '&' : '?'}t=${Date.now()}` : base;
}

function applyStickerUrl(url) {
  if (!url) return;
  stickerUrl = url;
  updateDonationSticker(false);
}

// =================================================================
// StreamElements overlay layers (always-on, OBS-style)
// =================================================================
function ensureSeLayer(id, url) {
  let layer = document.getElementById(id);
  if (!url) {
    if (layer) layer.remove();
    return;
  }
  if (!layer) {
    layer = document.createElement('div');
    layer.id = id;
    layer.className = 'se-overlay-layer';
    layer.innerHTML = `<iframe title="StreamElements overlay" allow="autoplay; fullscreen"></iframe>`;
    document.body.appendChild(layer);
  }
  const iframe = layer.querySelector('iframe');
  if (iframe && iframe.dataset.src !== url) {
    iframe.dataset.src = url;
    iframe.src = url;
  }
}

function isIdlePage() {
  const p = location.pathname || '/';
  return p === '/' || p === '/index.html';
}

function syncSeLayers() {
  // Donation / redeem / dispense: keep loaded like OBS (all pages).
  // Idle-only: show only on the idle home screen so Menu / settings
  // stay usable. (iframe pointer-events are none so double-tap still works.)
  const urls = seUrlsForTargets(['donation', 'dispense', 'redeem']);
  if (isIdlePage()) {
    for (const url of seUrlsForTargets(['idle'])) {
      if (!urls.includes(url)) urls.push(url);
    }
  }
  const keep = new Set();
  urls.forEach((url, i) => {
    const id = `se-overlay-${i}`;
    keep.add(id);
    ensureSeLayer(id, url);
  });
  // Drop stale layers (old indexes / removed overlays / left idle page).
  for (const el of [...document.querySelectorAll('.se-overlay-layer')]) {
    if (!keep.has(el.id)) el.remove();
  }
}

function refreshEnv() {
  return fetch('/api/state')
    .then((r) => r.json())
    .then((j) => {
      if (!j || !j.ok) return;
      if (j.settings && j.settings.chamberLabels) {
        env.chamberLabels = j.settings.chamberLabels;
      }
      if (j.settings && Number.isFinite(j.settings.donationOverlaySec)) {
        donationHoldMs = j.settings.donationOverlaySec * 1000;
      }
      if (j.settings && Number.isFinite(j.settings.redeemOverlaySec)) {
        redeemHoldMs = j.settings.redeemOverlaySec * 1000;
      }
      if (j.stickerUrl) applyStickerUrl(j.stickerUrl);
      donationStickerUrl = j.donationOverlayUrl || null;
      redeemStickerUrl   = j.redeemOverlayUrl || null;
      seOverlays = Array.isArray(j.seOverlays) ? j.seOverlays : [];
      updateDonationSticker(false);
      updateRedeemSticker();
      syncSeLayers();
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
  el.querySelector('[data-sticker]').src = currentDonationSticker();
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
  // Cache-bust the src on every show so an animated GIF restarts its
  // loop for back-to-back tips (harmless for a static PNG).
  updateDonationSticker(true);
}

function showOverlay() {
  ensureOverlay();
  overlay.classList.add('visible');
  document.body.classList.add('alert-active');
}

function hideOverlay() {
  if (overlay) overlay.classList.remove('visible');
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

function armDonationTimers(evt) {
  if (state.hideTimer)   clearTimeout(state.hideTimer);
  if (state.safetyTimer) clearTimeout(state.safetyTimer);
  state.safetyTimer = setTimeout(hideOverlay, HOLD_IF_STUCK_MS);
  // Alerts with no associated dispense (e.g. alertsAllAmounts=true,
  // sub-tier tip) auto-hide on their own short timer.
  if (!evt.motor) state.hideTimer = setTimeout(hideOverlay, donationHoldMs);
}

function show(evt) {
  state.currentId = evt.id;

  // SE overlay page is already loaded; it plays alerts via SE's own
  // realtime feed. We only pause the idle animation for the tip window.
  if (seHasTarget('donation')) {
    document.body.classList.add('alert-active');
    armDonationTimers(evt);
    return;
  }

  setFields(evt);
  const label = chamberLabelFor(evt.motor, evt.chamberLabel);
  if (label) setDispense(`Dropping ${label}…`, 'queued');
  else       setDispense('Thanks for the tip!', 'no_dispense');
  showOverlay();
  armDonationTimers(evt);
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
  if (seHasTarget('donation')) return;
  const label = chamberLabelFor(m.motor, m.chamberLabel);
  setDispense(`Dropping ${label}…`, 'dispensing');
});

onMessage('donation_done', (m) => {
  if (state.currentId !== m.id) return;
  if (!seHasTarget('donation')) {
    const label = chamberLabelFor(m.motor) || 'Chamber';
    if (m.kind === 'dropped')   setDispense(`${label} dropped!`, 'dropped');
    else if (m.kind === 'jam')  setDispense(`${label} jammed — please check`, 'jam');
    else                        setDispense('Done', 'done');
  }
  if (state.hideTimer) clearTimeout(state.hideTimer);
  state.hideTimer = setTimeout(hideOverlay, donationHoldMs);
});

onMessage('donation_skipped', (m) => {
  if (state.currentId !== m.id) return;
  if (!seHasTarget('donation')) {
    setDispense(
      m.reason === 'motor_offline' ? 'Motor offline — check device' :
      m.reason === 'no_tier'       ? 'Thanks for the tip!' : 'Skipped',
      'skipped',
    );
  }
  if (state.hideTimer) clearTimeout(state.hideTimer);
  state.hideTimer = setTimeout(hideOverlay, donationHoldMs);
});

onMessage('settings_changed', refreshEnv);
onMessage('sticker_changed', (m) => {
  if (m.url) applyStickerUrl(m.url);
});
onMessage('overlay_changed', (m) => {
  donationStickerUrl = m.donation || null;
  redeemStickerUrl   = m.redeem || null;
  if (Array.isArray(m.seOverlays)) seOverlays = m.seOverlays;
  updateDonationSticker(false);
  updateRedeemSticker();
  syncSeLayers();
});

// Pause idle cat while a physical drop is running if an SE overlay is
// assigned to dropper activation (layer itself stays always-on).
onMessage('dispense_started', () => {
  if (seHasTarget('dispense') && !seHasTarget('donation')) {
    document.body.classList.add('alert-active');
  }
});
onMessage('dispense_done', () => {
  if (seHasTarget('dispense') && !state.currentId) {
    document.body.classList.remove('alert-active');
  }
});

// =================================================================
// Channel-point redeem overlay
// =================================================================
// Independent of the donation overlay (its own element + timer). The
// server only sends `redeem` events when the showRedeemAlerts setting
// is on, so by the time we get here we always want to show it. No
// dispense is associated — it's purely a visual shout-out.
let redeemOverlay = null;
let redeemHideTimer = null;

function buildRedeemOverlay() {
  const el = document.createElement('div');
  el.id = 'redeem-overlay';
  el.className = 'redeem-overlay';
  el.innerHTML = `
    <div class="redeem-sakura" data-redeem-sakura></div>
    <div class="redeem-stack">
      <div class="redeem-redeemer" data-redeemer>Someone</div>
      <div class="redeem-label">Redeemed</div>
      <div class="redeem-name" data-redeem-name>a reward</div>
      <img class="redeem-sticker" data-redeem-sticker alt="" hidden />
    </div>
  `;
  document.body.appendChild(el);
  spawnRedeemSakura(el.querySelector('[data-redeem-sakura]'));
  return el;
}

function spawnRedeemSakura(layer) {
  if (!layer || layer.childElementCount) return; // spawn once, reused per show
  const N = 16;
  for (let i = 0; i < N; i++) {
    const p = document.createElement('span');
    p.className = 'redeem-petal';
    const dur  = 6 + Math.random() * 5;
    const size = 10 + Math.random() * 12;
    p.style.left   = (Math.random() * 100) + 'vw';
    p.style.width  = size + 'px';
    p.style.height = size + 'px';
    p.style.setProperty('--drift', (40 + Math.random() * 150) + 'px');
    p.style.setProperty('--petal-opacity', (0.55 + Math.random() * 0.4).toFixed(2));
    p.style.animationDuration = dur.toFixed(2) + 's';
    p.style.animationDelay    = (-Math.random() * dur).toFixed(2) + 's';
    layer.appendChild(p);
  }
}

// Show/hide the redeem overlay image based on whether one is configured.
function updateRedeemSticker() {
  if (!redeemOverlay) return;
  const img = redeemOverlay.querySelector('[data-redeem-sticker]');
  if (img) img.hidden = !redeemStickerUrl;
}

function showRedeem(evt) {
  // SE overlay (always loaded) handles redemptions via SE realtime.
  if (seHasTarget('redeem')) return;

  if (!redeemOverlay) redeemOverlay = buildRedeemOverlay();
  redeemOverlay.querySelector('[data-redeemer]').textContent   = evt.name || 'Someone';
  redeemOverlay.querySelector('[data-redeem-name]').textContent = evt.redemption || 'a reward';
  const rimg = redeemOverlay.querySelector('[data-redeem-sticker]');
  if (rimg) {
    if (redeemStickerUrl) { rimg.src = `${redeemStickerUrl}?t=${Date.now()}`; rimg.hidden = false; }
    else rimg.hidden = true;
  }
  redeemOverlay.classList.add('visible');
  if (redeemHideTimer) clearTimeout(redeemHideTimer);
  redeemHideTimer = setTimeout(() => {
    redeemOverlay.classList.remove('visible');
  }, redeemHoldMs);
}

onMessage('redeem', showRedeem);

refreshEnv();
// Catch up on any sticker/overlay/setting changes we missed while the
// socket was down or the page was frozen in the bfcache.
onResync(refreshEnv);
