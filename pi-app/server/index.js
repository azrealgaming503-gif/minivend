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
const express = require('express');
const { WebSocketServer } = require('ws');

const config = require('./config');
const { MotorBridge } = require('./motor');
const { AssetStore, mount: mountAssets, mountGames } = require('./assets');
const { mount: mountDonations } = require('./donations');
const { mount: mountWifi } = require('./wifi');
const { mount: mountUpdater } = require('./updater');
const { SettingsStore, mount: mountSettings } = require('./settings');
const { HistoryStore, mount: mountHistory } = require('./history');

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
  broadcast({ type: 'motor_status', connected: true, port });
});
motor.on('disconnected', () => {
  console.log('[motor] disconnected');
  broadcast({ type: 'motor_status', connected: false });
});
motor.on('ready', (fw) => {
  console.log(`[motor] firmware: ${fw}`);
  broadcast({ type: 'motor_ready', fw });
});
motor.on('warn', (msg) => console.warn(`[motor] ${msg}`));
motor.on('reply', (line) => {
  // Forward replies (OK / ERR / STATUS / SENSOR / PONG) to UI for debugging.
  broadcast({ type: 'motor_reply', line });
});
motor.on('dispense_result', (info) => {
  console.log(`[motor] dispense_result motor=${info.motor} kind=${info.kind}` +
              (info.ms !== undefined ? ` ms=${info.ms}` : ''));
  broadcast({ type: 'dispense_done', ...info });
});
motor.on('sensor', (info) => {
  broadcast({ type: 'sensor', ...info });
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

// ---------- Static UI ----------
const uiDir = path.resolve(__dirname, '..', 'ui');
app.use('/', express.static(uiDir, { extensions: ['html'] }));
app.use('/games', express.static(config.gamesDir));

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
  });
});

// ---------- Manual dispense (settings page, test buttons) ----------
app.post('/api/dispense', express.json({ limit: '4kb' }), (req, res) => {
  const body = req.body || {};
  const id = parseInt(body.motor, 10) || config.dispense.motor;
  const dir = body.dir === -1 ? -1 : +1;
  const speed = parseInt(body.speed, 10) || config.dispense.speed;
  const maxMs = parseInt(body.max_ms, 10) || config.dispense.maxMs;
  const ok = motor.dispense(id, dir, speed, maxMs);
  if (!ok) return res.status(503).json({ ok: false, err: 'motor_not_connected' });
  broadcast({ type: 'dispense_started', motor: id, dir, speed, max_ms: maxMs });
  res.json({ ok: true });
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
let lastDispenseAt = 0;
let activeJob = null;          // job currently dispensing (or null)
const dispenseQueue = [];      // FIFO of {historyId, motor, evt}
let drainTimer = null;

function cooldownMsRemaining() {
  const cd = (settings.getAll().dispenseCooldownSec || 0) * 1000;
  if (cd <= 0) return 0;
  const elapsed = Date.now() - lastDispenseAt;
  return Math.max(0, cd - elapsed);
}

function snapshotQueue() {
  return dispenseQueue.map((j) => ({
    id: j.historyId, name: j.evt.name, amount: j.evt.amount, motor: j.motor,
  }));
}

function broadcastDispenseState(extra = {}) {
  broadcast({
    type: 'dispense_state',
    cooldownMs: cooldownMsRemaining(),
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

  const wait = cooldownMsRemaining();
  if (wait > 0) {
    drainTimer = setTimeout(drainDispenseQueue, wait + 50);
    return;
  }

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
  const { dir, speed, maxMs } = config.dispense;
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
  activeJob = null;
  lastDispenseAt = Date.now();
  broadcastDispenseState();
  drainDispenseQueue();
});

mountDonations(app, {
  config,
  onDonation: (evt) => {
    const resolvedMotor = settings.resolveMotor(evt.amount);
    console.log(`[donation] ${evt.source} ${evt.name} ${evt.amount} ${evt.currency} → motor ${resolvedMotor}`);
    if (!resolvedMotor) {
      const entry = history.add({ ...evt, motor: null, status: 'skipped_no_tier',
                                  detail: `no tier matched amount ${evt.amount}` });
      broadcast({ type: 'donation', ...evt, id: entry.id, motor: null });
      broadcast({ type: 'donation_skipped', id: entry.id, reason: 'no_tier',
                  name: evt.name, amount: evt.amount });
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
  },
});

// ---------- Asset endpoints ----------
mountAssets(app, { store, broadcast });
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
