// Tiny .env reader (no dependency on dotenv). Parses KEY=VALUE lines,
// ignores comments and blank lines, does not handle quoted values with
// embedded `=`. That's plenty for our config surface.

const fs = require('fs');
const path = require('path');

function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  const txt = fs.readFileSync(file, 'utf8');
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    const val = line.slice(eq + 1).trim();
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv(path.resolve(__dirname, '..', '.env'));

function asInt(key, def) {
  const v = process.env[key];
  if (v === undefined || v === '') return def;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

function asStr(key, def) {
  const v = process.env[key];
  return v === undefined || v === '' ? def : v;
}

const config = {
  port: asInt('PORT', 3000),
  motor: {
    port: asStr('MOTOR_PORT', 'AUTO'),
    baud: asInt('MOTOR_BAUD', 115200),
    // Serial TX/RX + connect events for Pi Connect / SSH: `tail -f` this file.
    logFile: path.resolve(__dirname, '..', asStr('MOTOR_LOG_FILE', './logs/motor-fw.log')),
  },
  assetsDir: path.resolve(__dirname, '..', asStr('ASSETS_DIR', './assets')),
  gamesDir: path.resolve(__dirname, '..', asStr('GAMES_DIR', './ui/games')),
  donations: {
    seSecret: asStr('SE_WEBHOOK_SECRET', ''),
    kofiToken: asStr('KOFI_VERIFICATION_TOKEN', ''),
  },
  dispense: {
    motor: asInt('DEFAULT_DISPENSE_MOTOR', 1),
    dir: asInt('DEFAULT_DISPENSE_DIR', 1),
    speed: asInt('DEFAULT_DISPENSE_SPEED', 1200),
    maxMs: asInt('DEFAULT_DISPENSE_MAX_MS', 3000),
  },
  // StreamElements OAuth integration. The kiosk *never* sees the
  // client_secret — the pairing relay (a tiny Cloudflare Worker, source
  // in /oauth-relay) holds it. SE_RELAY_URL points to that deployment;
  // SE_CLIENT_ID is the public OAuth client id and is shown in the
  // pairing QR code for transparency. If SE_RELAY_URL is blank, the
  // kiosk falls back to "paste JWT" mode in the settings UI.
  streamelements: {
    relayUrl:    asStr('SE_RELAY_URL', ''),
    clientId:    asStr('SE_CLIENT_ID', ''),
    redirectUri: asStr('SE_REDIRECT_URI', ''),
    tokensFile:  path.resolve(__dirname, '..', asStr('SE_TOKENS_FILE', '../se-tokens.json')),
  },
};

module.exports = config;
