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

const DEFAULTS = Object.freeze({
  // Seconds of touch inactivity before menu/settings/games auto-return
  // to the idle animation.
  kioskIdleTimeoutSec: 30,

  // Mapping of donation amounts → chamber (ESP32 motor id). Each tier
  // says "donations of at least minAmount go to motor N". The handler
  // picks the highest-minAmount tier whose threshold the donation meets.
  // Default mirrors a typical 2-chamber setup: $1+ → motor 1, $5+ → motor 2.
  dispenseTiers: [
    { minAmount: 1, motor: 1 },
    { minAmount: 5, motor: 2 },
  ],

  // Friendly labels for each chamber, used in the donation overlay.
  // Keys are the motor id as a string.
  chamberLabels: {
    1: 'Left',
    2: 'Right',
  },

  // Minimum seconds between two physical dispenses. While a cooldown is
  // active, incoming donations are still acknowledged on-screen and
  // logged, but their dispense is queued FIFO. Set 0 to disable.
  dispenseCooldownSec: 0,
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

    let cd = parseInt(out.dispenseCooldownSec, 10);
    if (!Number.isFinite(cd) || cd < 0) cd = 0;
    if (cd > 3600) cd = 3600;
    out.dispenseCooldownSec = cd;

    if (!Array.isArray(out.dispenseTiers)) {
      out.dispenseTiers = [...DEFAULTS.dispenseTiers];
    }
    out.dispenseTiers = out.dispenseTiers
      .map((row) => ({
        minAmount: Math.max(0, Number(row && row.minAmount) || 0),
        motor:     (parseInt(row && row.motor, 10) === 2) ? 2 : 1,
      }))
      .sort((a, b) => a.minAmount - b.minAmount);
    if (out.dispenseTiers.length === 0) {
      out.dispenseTiers = [...DEFAULTS.dispenseTiers];
    }

    const labels = (out.chamberLabels && typeof out.chamberLabels === 'object')
      ? out.chamberLabels : {};
    out.chamberLabels = {
      1: String(labels[1] || labels['1'] || DEFAULTS.chamberLabels[1]).slice(0, 32),
      2: String(labels[2] || labels['2'] || DEFAULTS.chamberLabels[2]).slice(0, 32),
    };

    return out;
  }

  // Resolve a donation amount → motor id using the configured tiers.
  // Returns the motor for the HIGHEST minAmount the donation meets,
  // or null if no tier matches (donation too small).
  resolveMotor(amount) {
    const amt = Number(amount) || 0;
    let pick = null;
    for (const tier of this._values.dispenseTiers) {
      if (amt >= tier.minAmount) pick = tier.motor;
    }
    return pick;
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
      if (broadcast) broadcast({ type: 'settings_changed', settings: next });
      res.json({ ok: true, settings: next });
    } catch (e) {
      res.status(400).json({ ok: false, err: e.message });
    }
  });
}

module.exports = { SettingsStore, mount, DEFAULTS };
