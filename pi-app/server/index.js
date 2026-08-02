// MiniVend Pi-side server
//
// Wires together:
//   - Express static hosting for the kiosk UI and asset library.
//   - WebSocket fanout to all connected UI tabs.
//   - USB-serial bridge to the ESP32 motor controller.
//   - Donation webhook receivers (StreamElements, Ko-fi, test).
//   - Asset upload / management.
//
// Start with `npm start`. The kiosk UI lives at http://localhost:PORT.

const http = require('http');
const path = require('path');
const fs   = require('fs');
const { spawn } = require('child_process');
const express = require('express');
const { WebSocketServer } = require('ws');

const config = require('./config');
const { MotorBridge } = require('./motor');
const { AssetStore, mount: mountAssets, mountGames } = require('./assets');
const { mount: mountUsb } = require('./usb');
const { mount: mountDonations } = require('./donations');
const { mount: mountWifi } = require('./wifi');
const { mount: mountUpdater } = require('./updater');
const { SettingsStore, mount: mountSettings } = require('./settings');
const { HistoryStore, mount: mountHistory } = require('./history');
const { StreamElementsClient } = require('./streamelements');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---------- WebSocket fanout ----------
const clients = new Set();
wss.on('connection', (ws) => {
  clients.add(ws);
  ws.on('close', () => clients.delete(ws));
  ws.send(JSON.stringify({
    type: 'hello',
    motorConnected: motor.connected,
    activeIdle: store.getActiveIdle(),
  }));
});
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of clients) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

// ---------- Motor bridge ----------
const motor = new MotorBridge(config.motor);
motor.on('connected', (port) => {
  console.log(`[motor] connected on ${port}`);
  console.log(`[motor] firmware log: ${config.motor.logFile}`);
  broadcast({ type: 'motor_status', connected: true, port });
});
motor.on('disconnected', () => {
  console.log('[motor] disconnected');
  broadcast({ type: 'motor_status', connected: false });
});
motor.on('ready', (fw) => {
  console.log(`[motor] firmware: ${fw}`);
  // Ensure drivers start cold: stop any leftover motion and drop ENABLE.
  motor.stop();
  motor.enable(1, false);
  motor.enable(2, false);
  broadcast({ type: 'motor_ready', fw });
});
motor.on('warn', (msg) => console.warn(`[motor] ${msg}`));
motor.on('reply', (line) => {
  // Forward replies (OK / ERR / STATUS / PONG) to UI for debugging.
  broadcast({ type: 'motor_reply', line });
});
motor.on('dispense_result', (info) => {
  console.log(`[motor] dispense_result motor=${info.motor} kind=${info.kind}` +
              (info.ms !== undefined ? ` ms=${info.ms}` : ''));
  broadcast({ type: 'dispense_done', ...info });
});

// ---------- Asset store ----------
const store = new AssetStore({ assetsDir: config.assetsDir });

// ---------- Settings store ----------
const settings = new SettingsStore({
  file: path.join(config.assetsDir, '..', 'settings.json'),
});

// ---------- Donation history ----------
const history = new HistoryStore({
  file: path.join(config.assetsDir, '..', 'donations.json'),
});

// ---------- StreamElements OAuth + Astro realtime client ----------
// The client owns its own token file (chmod 600). On boot, if tokens
// are present, it autoconnects to wss://astro.streamelements.com,
// subscribes to channel.activities, and emits 'tip' for every donation.
// We forward those tips into the same onDonation() pipeline the
// webhooks use, so the rest of the system doesn't care where a tip
// came from.
const se = new StreamElementsClient({
  tokensFile:  config.streamelements.tokensFile,
  relayUrl:    config.streamelements.relayUrl,
  redirectUri: config.streamelements.redirectUri,
  clientId:    config.streamelements.clientId,
});

// ---------- Static UI ----------
const uiDir = path.resolve(__dirname, '..', 'ui');
const uiImgDir = path.join(uiDir, 'img');

function resolveStickerUrl() {
  for (const name of ['blu-happy.gif', 'blu-happy.png', 'blu-happy.webp', 'blu-happy.jpg']) {
    if (fs.existsSync(path.join(uiImgDir, name))) return `/img/${name}`;
  }
  return '/img/blu-happy.png';
}

// Boot splash: the first time anyone requests the idle page since the
// server (re)started, we leave the in-page boot-splash element alone
// so it covers the chromium → cat-video gap. Every subsequent request
// gets an injected `splash-suppressed` class on <html> so the splash
// is hidden from the very first paint. That's how menu → idle nav,
// settings → idle nav, etc. avoid replaying the splash without
// relying on client-side sessionStorage (which has been flaky in
// Chromium's --app kiosk mode).
//
// The flag is in-memory so it naturally resets on a real reboot,
// which is exactly when we WANT the splash to play again.
let bootSplashDelivered = false;
const indexHtmlPath = path.join(uiDir, 'index.html');
function serveIdleIndex(_req, res, next) {
  fs.readFile(indexHtmlPath, 'utf8', (err, html) => {
    if (err) return next(err);
    if (bootSplashDelivered) {
      // Inject the suppression class onto <html>. We do a literal
      // string replace because the markup is under our control.
      html = html.replace('<html lang="en">', '<html lang="en" class="splash-suppressed">');
    }
    bootSplashDelivered = true;
    res.set('Cache-Control', 'no-store');
    res.type('html').send(html);
  });
}
app.get('/',           serveIdleIndex);
app.get('/index.html', serveIdleIndex);

// Force the browser to revalidate HTML/CSS/JS on every load so the kiosk
// always picks up UI changes after an OTA update (Chromium's disk cache
// would otherwise keep serving a stale styles.css / *.js until the cache
// was manually cleared). `no-cache` still allows a cheap 304 when the
// file is unchanged. Large media (idle videos, stickers) stay cacheable.
const noCacheCodeAssets = (res, filePath) => {
  if (/\.(html|css|js|mjs)$/i.test(filePath)) {
    res.setHeader('Cache-Control', 'no-cache');
  }
};
app.use('/', express.static(uiDir, { extensions: ['html'], setHeaders: noCacheCodeAssets }));
app.use('/games', express.static(config.gamesDir, { setHeaders: noCacheCodeAssets }));

// ---------- Read-only state for UI bootstrap ----------
app.get('/api/state', (_req, res) => {
  const activeAlert = store.getActiveAlert();
  res.json({
    ok: true,
    motorConnected: motor.connected,
    motorFw: motor.lastFw,
    activeIdle: store.getActiveIdle(),
    activeAlert,
    activeAlertUrl: activeAlert ? `/assets/alerts/${encodeURIComponent(activeAlert)}` : null,
    dispense: config.dispense,
    settings: settings.getAll(),
    stickerUrl: resolveStickerUrl(),
    donationOverlayUrl: store.overlayUrl('donation'),
    redeemOverlayUrl:   store.overlayUrl('redeem'),
  });
});

// ---------- Manual dispense (settings page, test buttons) ----------
app.post('/api/dispense', express.json({ limit: '4kb' }), (req, res) => {
  const body = req.body || {};
  const id = parseInt(body.motor, 10) || config.dispense.motor;
  // Per-chamber configured motion (direction + revolutions → run-time).
  // Explicit body params still win so the manual jog can override with
  // its own dir/speed/max_ms.
  const cfg = settings.dispenseParamsFor(id);
  const dir = body.dir === -1 ? -1 : (body.dir === 1 ? 1 : cfg.dir);
  // Explicit jog/test speed is the UI "base" rate — apply chamberStepScale
  // so chamber 2 can run 2× pulses for the same shaft RPM.
  const scale = settings.stepScaleFor(id);
  let speed = parseInt(body.speed, 10);
  if (!Number.isFinite(speed) || speed <= 0) {
    speed = cfg.speed;
  } else {
    speed = Math.max(1, Math.round(speed * scale));
  }
  const maxMs = parseInt(body.max_ms, 10) || cfg.maxMs;
  const ok = motor.dispense(id, dir, speed, maxMs);
  if (!ok) return res.status(503).json({ ok: false, err: 'motor_not_connected' });
  broadcast({ type: 'dispense_started', motor: id, dir, speed, max_ms: maxMs });
  res.json({ ok: true });
});

// ---------- Alert sticker proxy ----------
// The donation alert overlay uses a single animated sticker for all
// tips. We host it locally so the kiosk works offline and so we
// don't depend on a 3rd-party CDN at the worst possible moment
// (right when a real donation comes in). On first request we fetch
// from the upstream URL and write it to disk; every request after
// that is served straight off disk.
//
// To swap the sticker: either replace the cached file at
// <assetsDir>/alert-sticker.<ext> on the Pi, or edit the URL below
// and delete the cached file so the next request re-downloads.
const ALERT_STICKER_URL = 'https://media.discordapp.net/stickers/1307104612414783578.gif?size=160';
const alertStickerPath  = path.join(config.assetsDir, 'alert-sticker.gif');
app.get('/alert-sticker.gif', async (_req, res) => {
  try {
    if (!fs.existsSync(alertStickerPath)) {
      console.log('[alert-sticker] fetching upstream:', ALERT_STICKER_URL);
      const r = await fetch(ALERT_STICKER_URL, {
        // Discord's CDN sometimes 403s requests without a UA.
        headers: { 'user-agent': 'MiniVend-Kiosk/1.0' },
      });
      if (!r.ok) throw new Error(`upstream ${r.status}`);
      const buf = Buffer.from(await r.arrayBuffer());
      fs.mkdirSync(path.dirname(alertStickerPath), { recursive: true });
      fs.writeFileSync(alertStickerPath, buf);
      console.log(`[alert-sticker] cached ${buf.length} bytes to ${alertStickerPath}`);
    }
    res.type('image/gif');
    res.set('cache-control', 'public, max-age=3600');
    res.sendFile(alertStickerPath);
  } catch (e) {
    console.warn('[alert-sticker] proxy failed, redirecting to upstream:', e.message);
    res.redirect(302, ALERT_STICKER_URL);
  }
});

// ---------- Boot splash handoff ----------
// The kiosk page hits this endpoint as soon as its first frame is
// composited. We tear down plymouth at that moment so the splash
// and the kiosk overlap by exactly one frame — no black gap.
//
// `plymouth quit --retain-splash` keeps the splash image in the
// framebuffer until something else writes to it (i.e. Chromium's
// first paint), so even if our shellout is a millisecond early the
// user doesn't see a flash.
//
// The sudoers drop-in (MINIVEND_SPLASH) lets the minivend user run
// exactly this command without a password. If plymouth isn't
// installed (dev machine, splash skipped, etc) we just no-op.
let kioskReadyFired = false;
app.post('/api/kiosk-ready', (_req, res) => {
  res.json({ ok: true, alreadyFired: kioskReadyFired });
  if (kioskReadyFired) return;
  kioskReadyFired = true;
  try {
    const p = spawn('sudo', ['-n', '/usr/bin/plymouth', 'quit', '--retain-splash'], {
      stdio: 'ignore',
      detached: true,
    });
    p.on('error', (e) => console.warn('[kiosk-ready] plymouth quit failed:', e.message));
    p.unref();
  } catch (e) {
    console.warn('[kiosk-ready] could not spawn plymouth:', e.message);
  }
});

// ---------- Kiosk display control ----------
// Some changes (settings, uploaded CSS/JS, the video fit mode) apply to
// the on-screen kiosk live over WebSocket, but a few only take effect on
// a fresh page load. These two endpoints let the settings UI push the
// kiosk to catch up on demand:
//
//   /api/kiosk/reload   soft — broadcast a reload; the physical kiosk
//                       (served on localhost) re-fetches HTML/CSS/JS +
//                       /api/state. Fast, no black screen. Remote phone
//                       tabs ignore it (they gate on being the kiosk).
//   /api/kiosk/restart  hard — bounce the Chromium kiosk service. Use
//                       when a soft reload isn't enough (GPU/decoder
//                       state, a wedged page). Screen goes blank a few
//                       seconds while Chromium relaunches.
app.post('/api/kiosk/reload', (_req, res) => {
  broadcast({ type: 'kiosk_reload' });
  res.json({ ok: true });
});

app.post('/api/kiosk/restart', (_req, res) => {
  try {
    const p = spawn('sudo', ['-n', '/bin/systemctl', 'restart', 'minivend-kiosk.service'], {
      stdio: 'ignore',
      detached: true,
    });
    p.on('error', (e) => console.warn('[kiosk-restart] failed:', e.message));
    p.unref();
    res.json({ ok: true });
  } catch (e) {
    console.warn('[kiosk-restart] could not spawn systemctl:', e.message);
    res.status(500).json({ ok: false, err: e.message });
  }
});

// ---------- Emergency stop ----------
app.post('/api/stop', express.json({ limit: '4kb' }), (req, res) => {
  const id = req.body && req.body.motor ? parseInt(req.body.motor, 10) : 0;
  const ok = motor.stop(id > 0 ? id : 0);
  if (!ok) return res.status(503).json({ ok: false, err: 'motor_not_connected' });
  broadcast({ type: 'stop', motor: id > 0 ? id : 'all' });
  res.json({ ok: true });
});

// ---------- Donation pipeline ----------
//
// Flow:
//   webhook -> normalize -> onDonation()
//     -> resolve motor from configured tiers (settings.dispenseTiers)
//     -> log history entry (status="queued")
//     -> broadcast {type:"donation", ...} so the UI shows the overlay
//     -> push onto dispenseQueue
//     -> drainDispenseQueue() if not in cooldown
//
// drainDispenseQueue:
//   - if cooldown active, schedule a retry at cooldownEndAt
//   - else pop one job, motor.dispense(...), broadcast "donation_dispensing"
//
// On motor 'dispense_result':
//   - update history entry status (dropped/jam/done)
//   - broadcast "donation_done"
//   - start cooldown (lastDispenseAt = Date.now())
//   - drainDispenseQueue() (will respect cooldown automatically)
const lastDispenseAt = { 1: 0, 2: 0 };  // per-chamber completion timestamps
let activeJob = null;          // job currently dispensing (or null)
const dispenseQueue = [];      // FIFO of {historyId, motor, evt}
let drainTimer = null;

// Remaining cooldown (ms) for a chamber, from its own chamberCooldownSec.
function cooldownMsRemaining(motor) {
  const cc = settings.getAll().chamberCooldownSec || {};
  const cd = (parseInt(cc[motor] != null ? cc[motor] : cc[String(motor)], 10) || 0) * 1000;
  if (cd <= 0) return 0;
  const elapsed = Date.now() - (lastDispenseAt[motor] || 0);
  return Math.max(0, cd - elapsed);
}

// A chamber is unavailable for a new tip if it's cooling down, currently
// dispensing, or already has a job waiting in the queue. Used to skip
// tips entirely during cooldown (no dispense, no overlay).
function chamberBlockedMs(motor) {
  let ms = cooldownMsRemaining(motor);
  if (activeJob && activeJob.motor === motor) ms = Math.max(ms, 1);
  if (dispenseQueue.some((j) => j.motor === motor)) ms = Math.max(ms, 1);
  return ms;
}

function snapshotQueue() {
  return dispenseQueue.map((j) => ({
    id: j.historyId, name: j.evt.name, amount: j.evt.amount, motor: j.motor,
  }));
}

function broadcastDispenseState(extra = {}) {
  broadcast({
    type: 'dispense_state',
    cooldownMs: { 1: cooldownMsRemaining(1), 2: cooldownMsRemaining(2) },
    queue: snapshotQueue(),
    active: activeJob ? {
      id: activeJob.historyId,
      name: activeJob.evt.name,
      amount: activeJob.evt.amount,
      motor: activeJob.motor,
    } : null,
    ...extra,
  });
}

function drainDispenseQueue() {
  if (drainTimer) { clearTimeout(drainTimer); drainTimer = null; }
  if (activeJob) return;                          // wait for current to finish
  if (dispenseQueue.length === 0) return;

  // No cooldown wait here: per-chamber cooldown is enforced up front in
  // dispatchDonation (tips during cooldown are skipped entirely), so the
  // queue only ever holds tips that are cleared to dispense.
  const job = dispenseQueue.shift();
  if (!motor.connected) {
    history.update(job.historyId, {
      status: 'skipped_motor_offline',
      detail: 'motor controller not connected',
    });
    broadcast({
      type: 'donation_skipped',
      id: job.historyId, reason: 'motor_offline',
      name: job.evt.name, amount: job.evt.amount, motor: job.motor,
    });
    broadcastDispenseState();
    return drainDispenseQueue();
  }

  activeJob = job;
  const { dir, speed, maxMs } = settings.dispenseParamsFor(job.motor);
  const labels = settings.getAll().chamberLabels;
  motor.dispense(job.motor, dir, speed, maxMs);
  history.update(job.historyId, { status: 'dispensing' });
  broadcast({
    type: 'donation_dispensing',
    id: job.historyId,
    motor: job.motor,
    chamberLabel: labels[job.motor] || `Chamber ${job.motor}`,
    name: job.evt.name,
    amount: job.evt.amount,
  });
  broadcast({ type: 'dispense_started', motor: job.motor, dir, speed, max_ms: maxMs });
  broadcastDispenseState();
}

// Hook motor results into the dispense state machine. The existing
// motor.on('dispense_result') registered above also broadcasts a generic
// dispense_done event; this one is donation-specific and updates history.
motor.on('dispense_result', (info) => {
  if (!activeJob) return;
  // Match by motor id since the firmware doesn't echo a job id; in
  // practice activeJob's motor === info.motor for the only outstanding job.
  if (activeJob.motor !== info.motor) return;
  history.update(activeJob.historyId, {
    status: info.kind,
    detail: info.ms != null ? `${info.ms}ms` : '',
  });
  broadcast({
    type: 'donation_done',
    id: activeJob.historyId,
    motor: activeJob.motor,
    kind: info.kind,
    ms:   info.ms,
  });
  lastDispenseAt[activeJob.motor] = Date.now();  // start this chamber's cooldown
  activeJob = null;
  broadcastDispenseState();
  drainDispenseQueue();
});

function dispatchDonation(evt) {
  const resolvedMotor = settings.resolveMotor(evt.amount);
  const allAmounts    = !!settings.getAll().alertsAllAmounts;
  console.log(`[donation] ${evt.source} ${evt.name} ${evt.amount} ${evt.currency} → motor ${resolvedMotor}${allAmounts ? ' (all-amounts mode)' : ''}`);
  if (!resolvedMotor) {
    // No tier matched. By default we drop the event entirely — no
    // overlay, no history entry, no sound. The user can flip
    // `alertsAllAmounts` in settings to celebrate every tip
    // regardless of whether it triggers a dispense.
    if (!allAmounts) {
      console.log(`[donation]   ↳ dropped (no tier, alertsAllAmounts=false)`);
      return;
    }
    const entry = history.add({ ...evt, motor: null, status: 'no_tier_alert_only',
                                detail: `no tier matched amount ${evt.amount}` });
    broadcast({
      type: 'donation', id: entry.id, motor: null,
      source: evt.source, name: evt.name, amount: evt.amount,
      currency: evt.currency, message: evt.message,
    });
    return;
  }
  // Live-only gate: if enabled and the stream is *known* offline, log
  // the tip but don't fire a drop. Unknown live status (no feed / token
  // lacks the scope) is allowed through so the feature can't silently
  // block every dispense.
  if (settings.getAll().dispenseOnlyWhenLive && se.status().live === false) {
    console.log(`[donation]   ↳ suppressed (stream offline, dispenseOnlyWhenLive=true)`);
    const entry = history.add({ ...evt, motor: resolvedMotor, status: 'skipped_offline',
                                detail: 'stream offline — dispense suppressed' });
    broadcast({
      type: 'donation', id: entry.id, motor: null,
      source: evt.source, name: evt.name, amount: evt.amount,
      currency: evt.currency, message: evt.message, suppressed: 'offline',
    });
    return;
  }

  // Per-chamber cooldown: skip the tip entirely (no dispense, no overlay)
  // if this chamber is still cooling down, currently dispensing, or already
  // has a tip queued. Still logged so the operator sees it in history.
  if (chamberBlockedMs(resolvedMotor) > 0) {
    console.log(`[donation]   ↳ skipped (chamber ${resolvedMotor} cooldown active)`);
    history.add({ ...evt, motor: resolvedMotor, status: 'skipped_cooldown',
                  detail: 'chamber cooldown active' });
    return;
  }

  const labels = settings.getAll().chamberLabels;
  const entry = history.add({ ...evt, motor: resolvedMotor, status: 'queued' });
  broadcast({
    type: 'donation',
    id: entry.id,
    motor: resolvedMotor,
    chamberLabel: labels[resolvedMotor] || `Chamber ${resolvedMotor}`,
    source: evt.source, name: evt.name, amount: evt.amount,
    currency: evt.currency, message: evt.message,
  });
  dispenseQueue.push({ historyId: entry.id, motor: resolvedMotor, evt });
  broadcastDispenseState();
  drainDispenseQueue();
}

mountDonations(app, { config, onDonation: dispatchDonation });

// ---------- StreamElements live feed ----------
// Forward Astro 'tip' events into the donation pipeline. We also
// mirror the client's connection state into the settings store so the
// UI shows "Connected as <user>" after a reload without any extra
// round-trips.
function syncSeState() {
  const s = se.status();
  settings.patch({
    streamelements: {
      connected:   s.connected,
      mode:        s.mode,
      account:     s.account,
      connectedAt: s.connected ? (settings.getAll().streamelements.connectedAt || Date.now()) : null,
      lastError:   s.lastError,
      lastEventAt: s.lastEventAt,
      live:          s.live,
      liveSupported: s.liveSupported,
    },
  });
  broadcast({ type: 'streamelements_state', state: s });
}
se.on('tip', (tip) => {
  dispatchDonation(tip);
  syncSeState();
});
// Channel-point / store redemptions: purely a visual shout-out, gated by
// the showRedeemAlerts toggle. No dispense, no history entry.
se.on('redeem', (redeem) => {
  if (settings.getAll().showRedeemAlerts) {
    console.log(`[redeem] ${redeem.name} redeemed "${redeem.redemption}"`);
    broadcast({
      type: 'redeem',
      name: redeem.name,
      redemption: redeem.redemption,
      amount: redeem.amount,
      message: redeem.message,
    });
  }
  syncSeState();
});
se.on('state', syncSeState);
se.start();
syncSeState();

// HTTP control surface for the SE integration (called by settings.html).
app.get('/api/integrations/streamelements/status', (_req, res) => {
  res.json({ ok: true, status: se.status() });
});

// Preview the redeem overlay without waiting for a real redemption.
// Always broadcasts (bypasses the showRedeemAlerts gate) so the settings
// "Test" button can show what it looks like.
app.post('/api/integrations/streamelements/test-redeem',
  express.json({ limit: '4kb' }),
  (req, res) => {
    const b = req.body || {};
    broadcast({
      type: 'redeem',
      name: (b.name || 'TestViewer').toString().slice(0, 80),
      redemption: (b.redemption || 'Hydrate!').toString().slice(0, 120),
      amount: Number(b.amount) || 0,
      message: (b.message || '').toString().slice(0, 200),
    });
    res.json({ ok: true });
  });

app.post('/api/integrations/streamelements/pair/new', async (_req, res) => {
  try {
    const pairing = await se.createPairing();
    res.json({ ok: true, ...pairing });
  } catch (e) {
    res.status(400).json({ ok: false, err: e.message });
  }
});

app.get('/api/integrations/streamelements/pair/:id/poll', async (req, res) => {
  try {
    const r = await se.pollPairing(req.params.id);
    res.json({ ok: true, ...r });
  } catch (e) {
    res.status(400).json({ ok: false, err: e.message });
  }
});

app.post('/api/integrations/streamelements/jwt',
  express.json({ limit: '8kb' }),
  async (req, res) => {
    try {
      await se.setJwt(req.body && req.body.jwt);
      res.json({ ok: true, status: se.status() });
    } catch (e) {
      res.status(400).json({ ok: false, err: e.message });
    }
  });

app.post('/api/integrations/streamelements/disconnect', async (_req, res) => {
  await se.disconnect();
  res.json({ ok: true, status: se.status() });
});

// Generic QR renderer: turns any URL/text into an SVG QR code. Used by the
// "Access from your phone" panel (and any other UI that needs a scan code).
async function renderQr(req, res) {
  const url = req.query.url ? String(req.query.url) : '';
  if (!url) return res.status(400).json({ ok: false, err: 'missing url' });
  try {
    const QRCode = require('qrcode');
    const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 320 });
    res.set('content-type', 'image/svg+xml').send(svg);
  } catch (e) {
    res.status(500).json({ ok: false, err: e.message });
  }
}
app.get('/api/qr', renderQr);
// Back-compat alias for the StreamElements pairing flow.
app.get('/api/integrations/streamelements/qr', renderQr);

// ---------- Asset endpoints ----------
mountAssets(app, { store, broadcast });
mountUsb(app, { store, broadcast, uiImgDir });
mountGames(app, { gamesDir: config.gamesDir });

// ---------- Wi-Fi + Updater + Settings + History endpoints ----------
mountWifi(app);
mountUpdater(app, { broadcast });
mountSettings(app, { store: settings, broadcast });
mountHistory(app, { store: history, broadcast });

// ---------- Boot ----------
server.listen(config.port, () => {
  console.log(`[server] listening on http://0.0.0.0:${config.port}`);
  console.log(`[server] assets:  ${config.assetsDir}`);
  console.log(`[server] games:   ${config.gamesDir}`);
});
