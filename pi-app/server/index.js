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

// ---------- Static UI ----------
const uiDir = path.resolve(__dirname, '..', 'ui');
app.use('/', express.static(uiDir, { extensions: ['html'] }));
app.use('/games', express.static(config.gamesDir));

// ---------- Read-only state for UI bootstrap ----------
app.get('/api/state', (_req, res) => {
  res.json({
    ok: true,
    motorConnected: motor.connected,
    motorFw: motor.lastFw,
    activeIdle: store.getActiveIdle(),
    dispense: config.dispense,
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
mountDonations(app, {
  config,
  onDonation: (evt) => {
    console.log(`[donation] ${evt.source} ${evt.name} ${evt.amount} ${evt.currency}`);
    // 1. Tell the UI to show the alert.
    broadcast({ type: 'donation', ...evt });
    // 2. Dispense. The default policy is "dispense one item per tip".
    //    Real-world deployments will want tier mapping in the dashboard.
    const { motor: id, dir, speed, maxMs } = config.dispense;
    motor.dispense(id, dir, speed, maxMs);
    broadcast({ type: 'dispense_started', motor: id, dir, speed, max_ms: maxMs });
  },
});

// ---------- Asset endpoints ----------
mountAssets(app, { store, broadcast });
mountGames(app, { gamesDir: config.gamesDir });

// ---------- Wi-Fi + Updater endpoints ----------
mountWifi(app);
mountUpdater(app, { broadcast });

// ---------- Boot ----------
server.listen(config.port, () => {
  console.log(`[server] listening on http://0.0.0.0:${config.port}`);
  console.log(`[server] assets:  ${config.assetsDir}`);
  console.log(`[server] games:   ${config.gamesDir}`);
});
