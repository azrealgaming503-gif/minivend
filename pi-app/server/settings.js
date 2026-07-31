// MiniVend app settings store.
//
// Settings here are things the END USER can tweak from the kiosk
// settings page at runtime — they persist in a JSON file alongside the
// asset library so they survive OTA updates (the assets dir is *not*
// blown away by the updater).
//
// Currently:
//   - kioskIdleTimeoutSec — seconds of touch inactivity on /menu,
//     /settings, /games before we auto-navigate back to the idle
//     animation. Default 30.
//
// Add new fields by extending DEFAULTS and (optionally) clamping in
// `_sanitize` so a typo'd PUT can't break the kiosk.

const fs   = require('fs');
const path = require('path');

// ---------- Hardware backlight (optional) ----------
// On panels that expose /sys/class/backlight/X/brightness we can
// dim the actual LED backlight, which saves power and is more
// effective at night than a CSS filter. On HDMI panels there's
// usually no such node and we fall back to CSS-only dimming.
//
// Cached at module load — backlight devices don't appear/disappear
// at runtime in any setup we care about.
let _backlight = null;
function detectBacklight() {
  if (_backlight !== null) return _backlight;
  try {
    const dir = '/sys/class/backlight';
    if (!fs.existsSync(dir)) return (_backlight = { ok: false });
    const entries = fs.readdirSync(dir);
    for (const name of entries) {
      const base = path.join(dir, name);
      const brightnessFile = path.join(base, 'brightness');
      const maxFile        = path.join(base, 'max_brightness');
      if (!fs.existsSync(brightnessFile) || !fs.existsSync(maxFile)) continue;
      try {
        const max = parseInt(fs.readFileSync(maxFile, 'utf8').trim(), 10);
        if (!Number.isFinite(max) || max <= 0) continue;
        // Try a probe write so we know we actually have permission.
        const cur = parseInt(fs.readFileSync(brightnessFile, 'utf8').trim(), 10) || max;
        fs.writeFileSync(brightnessFile, String(cur)); // idempotent
        return (_backlight = { ok: true, name, max, file: brightnessFile });
      } catch (_) { /* try next */ }
    }
  } catch (_) { /* fall through */ }
  return (_backlight = { ok: false });
}

function applyHardwareBrightness(pct) {
  const bl = detectBacklight();
  if (!bl.ok) return false;
  // Map 10–100% → 10%–100% of max_brightness. Many panels go fully
  // black at 0, so we never write less than ~5% of max even at the
  // floor of our slider.
  const clamped = Math.max(10, Math.min(100, parseInt(pct, 10) || 100));
  const raw = Math.max(Math.round(bl.max * 0.05),
                       Math.round(bl.max * (clamped / 100)));
  try {
    fs.writeFileSync(bl.file, String(raw));
    return true;
  } catch (e) {
    console.warn(`[settings] backlight write failed: ${e.message}`);
    return false;
  }
}

const DEFAULTS = Object.freeze({
  // Seconds of touch inactivity before menu/settings/games auto-return
  // to the idle animation.
  kioskIdleTimeoutSec: 30,

  // Mapping of donation amounts → chamber (ESP32 motor id). Each tier
  // is one of:
  //   { minAmount, motor, match: 'gte' }   — at-least, classic threshold
  //   { minAmount, motor, match: 'eq'  }   — exact dollar amount only
  //
  // Resolution order: any matching 'eq' tier wins (last declared if
  // several). Otherwise we fall back to the highest 'gte' tier whose
  // threshold the donation meets. Default mirrors a typical 2-chamber
  // setup: $1+ → motor 1, $5+ → motor 2.
  dispenseTiers: [
    { minAmount: 1, motor: 1, match: 'gte' },
    { minAmount: 5, motor: 2, match: 'gte' },
  ],

  // Friendly labels for each chamber, used in the donation overlay.
  // Keys are the motor id as a string.
  chamberLabels: {
    1: 'Left',
    2: 'Right',
  },

  // ----- Physical dispense motion -----
  // The ESP32 dispense is time-based: it spins the stepper at `dispenseSpeed`
  // (steps/sec) until the drop sensor fires OR a maximum run-time elapses.
  // We express that maximum as a number of *revolutions* per chamber, so it
  // maps directly to how far a coil/auger turns to push one item out.
  // Partial turns are allowed (e.g. 0.5). Each chamber also has its own
  // direction so mirrored hardware can both eject "outward".
  //
  // Revolutions are converted to milliseconds by the server:
  //   maxMs = rotations * stepsPerRev / dispenseSpeed * 1000
  // `stepsPerRev` is microsteps per full turn (motor steps × driver
  // microstepping). Calibrate it once with the Test dispense button until
  // "1.0 rotation" equals one physical revolution of the coil.
  // At 16 microsteps (firmware TMC_MICROSTEPS), 19200 steps/s ≈ the old
  // full-step feel of 1200 steps/s with stepsPerRev=200.
  dispenseSpeed: 19200,  // steps/sec sent to the stepper during a dispense
  stepsPerRev: 3200,     // 200 full steps × 16 microsteps (match TMC firmware)
  chamberDispense: {
    1: { dir: 1, rotations: 1 },
    2: { dir: 1, rotations: 1 },
  },
  // Multiplies step rate and step count for a chamber (shaft RPM + travel).
  // Chamber 2 defaults to 2× to compensate when that driver is stuck at
  // 32 microsteps while chamber 1 runs at 16 (half angle per pulse).
  chamberStepScale: { 1: 1, 2: 2 },

  // Per-chamber minimum seconds between dispenses. A tip that arrives for
  // a chamber still within its cooldown window is skipped entirely — no
  // dispense and no overlay (a hard rate-limit). Set 0 to disable a
  // chamber's cooldown. Stored in seconds; the UI edits minutes.
  chamberCooldownSec: { 1: 0, 2: 0 },

  // Alert filtering. Default behavior matches what most streamers
  // want: only celebrate tips that actually trigger a dispense.
  //   false (default): if a donation amount doesn't match any
  //                    dispenseTier, drop it silently — no overlay,
  //                    no history entry, no sound. Keeps the kiosk
  //                    from popping a full-screen alert for $0.10
  //                    test tips, sub-bombs, etc.
  //   true:            show the overlay (and log to history) for
  //                    EVERY donation, even ones that don't trigger
  //                    a dispense. Useful for charity streams or
  //                    when you want every supporter on-screen.
  alertsAllAmounts: false,

  // When true, donations only trigger a physical dispense while the
  // connected StreamElements channel is live. Tips received while the
  // stream is offline are still logged to history (status
  // 'skipped_offline') but no drop fires. Live status comes from the
  // StreamElements channel.stream.status feed; if that feed isn't
  // available (token lacks the stream-live:read scope, or status hasn't
  // been reported yet) the dispense is allowed through so the feature
  // never silently blocks every drop. Default off.
  dispenseOnlyWhenLive: false,

  // When true, channel-point / store redemptions coming from the
  // StreamElements activities feed pop a full-screen celebration overlay
  // (redeemer name on top, "Redeemed", then the reward name in the
  // middle, over falling sakura petals). These never trigger a dispense —
  // they're purely a visual shout-out. Default off.
  showRedeemAlerts: false,

  // How long overlays stay on screen, in seconds (1–60).
  //   donationOverlaySec — hold after the dispense finishes (or, for
  //     alert-only tips with no dispense, the total display time).
  //   redeemOverlaySec   — total display time for a redeem shout-out.
  donationOverlaySec: 5,
  redeemOverlaySec: 7,

  // Screen brightness, 10–100. Implemented two ways at once:
  //   1. CSS filter on the UI (always works, even on dumb HDMI panels).
  //   2. Hardware backlight via /sys/class/backlight/*/brightness
  //      when available (DSI/SPI panels, some HDMI bridges).
  // The hardware path is best-effort: if the kernel doesn't expose
  // a backlight node or we can't write to it, the CSS filter still
  // dims the visible output. 100 = full brightness.
  brightness: 100,

  // Public connection state for the StreamElements integration. Secrets
  // (tokens, client_secret) live elsewhere — this is just what the UI
  // needs to render the "Connected as X" badge after a reboot. The SE
  // module updates this via `patch({ streamelements: {...} })` itself;
  // the UI only reads it.
  streamelements: {
    connected: false,
    mode: null,            // 'oauth' | 'jwt' | null
    account: null,         // { id, username, displayName, provider, avatar }
    connectedAt: null,
    lastError: null,
    lastEventAt: null,
    live: null,          // true/false when known, null = unknown
    liveSupported: null, // true if the live-status feed is available
  },
});

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

class SettingsStore {
  constructor({ file }) {
    this.file = file;
    ensureDir(path.dirname(file));
    this._values = { ...DEFAULTS };
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (raw && typeof raw === 'object') {
        this._values = this._sanitize({ ...DEFAULTS, ...raw });
      }
    } catch (e) {
      console.warn(`[settings] could not parse ${this.file}: ${e.message}`);
    }
  }

  _save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this._values, null, 2));
    } catch (e) {
      console.warn(`[settings] could not write ${this.file}: ${e.message}`);
    }
  }

  // Coerce + clamp every field so bad client input can't brick the UI.
  _sanitize(v) {
    const out = { ...v };

    let t = parseInt(out.kioskIdleTimeoutSec, 10);
    if (!Number.isFinite(t)) t = DEFAULTS.kioskIdleTimeoutSec;
    if (t < 5)    t = 5;
    if (t > 3600) t = 3600;
    out.kioskIdleTimeoutSec = t;

    // Per-chamber cooldown, with a one-time migration from the old global
    // `dispenseCooldownSec` field if it's still present in a settings file.
    const legacyCd = parseInt(out.dispenseCooldownSec, 10);
    const ccIn = (out.chamberCooldownSec && typeof out.chamberCooldownSec === 'object')
      ? out.chamberCooldownSec : {};
    const sanitizeCooldown = (id) => {
      const raw = (ccIn[id] != null) ? ccIn[id] : ccIn[String(id)];
      let v = parseInt(raw, 10);
      if (!Number.isFinite(v)) v = Number.isFinite(legacyCd) ? legacyCd : 0;
      if (v < 0)    v = 0;
      if (v > 3600) v = 3600;
      return v;
    };
    out.chamberCooldownSec = { 1: sanitizeCooldown(1), 2: sanitizeCooldown(2) };
    delete out.dispenseCooldownSec;

    let br = parseInt(out.brightness, 10);
    if (!Number.isFinite(br)) br = DEFAULTS.brightness;
    if (br < 10)  br = 10;     // never let the user blank the screen entirely
    if (br > 100) br = 100;
    out.brightness = br;

    out.alertsAllAmounts = !!out.alertsAllAmounts;
    out.dispenseOnlyWhenLive = !!out.dispenseOnlyWhenLive;
    out.showRedeemAlerts = !!out.showRedeemAlerts;

    const clampSec = (v, def) => {
      let n = parseInt(v, 10);
      if (!Number.isFinite(n)) n = def;
      if (n < 1)  n = 1;
      if (n > 60) n = 60;
      return n;
    };
    out.donationOverlaySec = clampSec(out.donationOverlaySec, DEFAULTS.donationOverlaySec);
    out.redeemOverlaySec   = clampSec(out.redeemOverlaySec, DEFAULTS.redeemOverlaySec);

    // ----- Dispense motion -----
    let ds = parseInt(out.dispenseSpeed, 10);
    if (!Number.isFinite(ds)) ds = DEFAULTS.dispenseSpeed;
    if (ds < 100)    ds = 100;
    if (ds > 25000)  ds = 25000;
    out.dispenseSpeed = ds;

    let spr = parseInt(out.stepsPerRev, 10);
    if (!Number.isFinite(spr)) spr = DEFAULTS.stepsPerRev;
    if (spr < 1)      spr = 1;
    if (spr > 100000) spr = 100000;
    out.stepsPerRev = spr;

    const cdIn = (out.chamberDispense && typeof out.chamberDispense === 'object')
      ? out.chamberDispense : {};
    const sanitizeChamber = (id) => {
      const row = cdIn[id] || cdIn[String(id)] || {};
      let rot = Number(row.rotations);
      if (!Number.isFinite(rot)) rot = DEFAULTS.chamberDispense[id].rotations;
      if (rot < 0.05) rot = 0.05;
      if (rot > 100)  rot = 100;
      rot = Math.round(rot * 20) / 20;   // snap to 0.05 to avoid float noise
      const dir = (parseInt(row.dir, 10) === -1) ? -1 : 1;
      return { dir, rotations: rot };
    };
    out.chamberDispense = { 1: sanitizeChamber(1), 2: sanitizeChamber(2) };

    const scaleIn = (out.chamberStepScale && typeof out.chamberStepScale === 'object')
      ? out.chamberStepScale : {};
    const sanitizeScale = (id) => {
      let s = Number(scaleIn[id] != null ? scaleIn[id] : scaleIn[String(id)]);
      if (!Number.isFinite(s)) s = DEFAULTS.chamberStepScale[id];
      if (s < 0.25) s = 0.25;
      if (s > 8) s = 8;
      // Keep a few decimals so 1.5 / 2.5 are usable; snap lightly.
      return Math.round(s * 100) / 100;
    };
    out.chamberStepScale = { 1: sanitizeScale(1), 2: sanitizeScale(2) };

    if (!Array.isArray(out.dispenseTiers)) {
      out.dispenseTiers = DEFAULTS.dispenseTiers.map((t) => ({ ...t }));
    }
    out.dispenseTiers = out.dispenseTiers
      .map((row) => ({
        minAmount: Math.max(0, Number(row && row.minAmount) || 0),
        motor:     (parseInt(row && row.motor, 10) === 2) ? 2 : 1,
        match:     (row && row.match === 'eq') ? 'eq' : 'gte',
      }))
      // Stable order: 'eq' tiers first (they take precedence), then
      // 'gte' tiers ascending by minAmount.
      .sort((a, b) => {
        if (a.match !== b.match) return a.match === 'eq' ? -1 : 1;
        return a.minAmount - b.minAmount;
      });
    if (out.dispenseTiers.length === 0) {
      out.dispenseTiers = DEFAULTS.dispenseTiers.map((t) => ({ ...t }));
    }

    const labels = (out.chamberLabels && typeof out.chamberLabels === 'object')
      ? out.chamberLabels : {};
    out.chamberLabels = {
      1: String(labels[1] || labels['1'] || DEFAULTS.chamberLabels[1]).slice(0, 32),
      2: String(labels[2] || labels['2'] || DEFAULTS.chamberLabels[2]).slice(0, 32),
    };

    const se = (out.streamelements && typeof out.streamelements === 'object')
      ? out.streamelements : {};
    out.streamelements = {
      connected: !!se.connected,
      mode: se.mode === 'oauth' || se.mode === 'jwt' ? se.mode : null,
      account: (se.account && typeof se.account === 'object') ? {
        id:          se.account.id          || null,
        username:    se.account.username    || null,
        displayName: se.account.displayName || se.account.username || null,
        provider:    se.account.provider    || null,
        avatar:      se.account.avatar      || null,
      } : null,
      connectedAt: Number.isFinite(se.connectedAt) ? se.connectedAt : null,
      lastError:   se.lastError ? String(se.lastError).slice(0, 240) : null,
      lastEventAt: Number.isFinite(se.lastEventAt) ? se.lastEventAt : null,
      live:          (se.live === true || se.live === false) ? se.live : null,
      liveSupported: (se.liveSupported === true || se.liveSupported === false) ? se.liveSupported : null,
    };

    return out;
  }

  // Resolve a donation amount → motor id using the configured tiers.
  // 'eq' tiers (exact dollar amount) win over 'gte' tiers; among
  // 'gte' tiers the one with the highest threshold the donation meets
  // is picked. Returns null if no tier matches.
  resolveMotor(amount) {
    const amt = Number(amount) || 0;
    let exact = null;
    let pick = null;
    for (const tier of this._values.dispenseTiers) {
      if (tier.match === 'eq') {
        // Tolerate floating-point noise (e.g. 4.99 vs 5.00 from
        // currency conversion) by comparing rounded cents.
        if (Math.round(amt * 100) === Math.round(tier.minAmount * 100)) {
          exact = tier.motor;
        }
      } else if (amt >= tier.minAmount) {
        pick = tier.motor;
      }
    }
    return exact != null ? exact : pick;
  }

  // Multiplier for step rate + travel distance for a chamber (see chamberStepScale).
  stepScaleFor(motorId) {
    const id = (parseInt(motorId, 10) === 2) ? 2 : 1;
    const scales = this._values.chamberStepScale || DEFAULTS.chamberStepScale;
    let s = Number(scales[id] != null ? scales[id] : scales[String(id)]);
    if (!Number.isFinite(s) || s <= 0) s = 1;
    return s;
  }

  // Concrete DISPENSE parameters for a chamber, derived from the
  // configured direction + revolutions. `maxMs` is the run-time
  // equivalent of `rotations` full turns at `dispenseSpeed`.
  // chamberStepScale multiplies both pulse rate and pulse count so shaft
  // RPM and travel stay matched when a driver uses finer microsteps.
  dispenseParamsFor(motorId) {
    const id = (parseInt(motorId, 10) === 2) ? 2 : 1;
    const cd = this._values.chamberDispense[id] || { dir: 1, rotations: 1 };
    const scale = this.stepScaleFor(id);
    const speed = Math.max(1, Math.round(this._values.dispenseSpeed * scale));
    const steps = cd.rotations * this._values.stepsPerRev * scale;
    const maxMs = Math.max(50, Math.round((steps / speed) * 1000));
    return { dir: cd.dir, speed, maxMs, rotations: cd.rotations, scale };
  }

  getAll() { return { ...this._values }; }

  // Partial update. Only known keys are accepted; unknown ones are dropped.
  patch(patch) {
    const next = { ...this._values };
    for (const key of Object.keys(DEFAULTS)) {
      if (patch && Object.prototype.hasOwnProperty.call(patch, key)) {
        next[key] = patch[key];
      }
    }
    this._values = this._sanitize(next);
    this._save();
    return this.getAll();
  }
}

function mount(app, { store, broadcast }) {
  app.get('/api/settings', (_req, res) => {
    res.json({ ok: true, settings: store.getAll() });
  });

  const express = require('express');
  app.put('/api/settings', express.json({ limit: '4kb' }), (req, res) => {
    try {
      const next = store.patch(req.body || {});
      // If brightness changed in this patch, push it to the hardware
      // backlight too. The CSS-filter side is handled client-side via
      // the settings_changed broadcast.
      if (req.body && Object.prototype.hasOwnProperty.call(req.body, 'brightness')) {
        applyHardwareBrightness(next.brightness);
      }
      if (broadcast) broadcast({ type: 'settings_changed', settings: next });
      res.json({ ok: true, settings: next });
    } catch (e) {
      res.status(400).json({ ok: false, err: e.message });
    }
  });

  // Tells the UI whether real backlight control is available so it
  // can show "Hardware backlight: yes/no" next to the slider.
  app.get('/api/brightness/info', (_req, res) => {
    const bl = detectBacklight();
    res.json({
      ok: true,
      brightness: store.getAll().brightness,
      hardware: !!bl.ok,
      device: bl.ok ? bl.name : null,
    });
  });

  // Reapply hardware brightness on startup so a reboot doesn't reset
  // the panel to its kernel default.
  try { applyHardwareBrightness(store.getAll().brightness); } catch (_) {}
}

module.exports = { SettingsStore, mount, DEFAULTS };
