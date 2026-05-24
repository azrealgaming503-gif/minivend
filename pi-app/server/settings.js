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
  kioskIdleTimeoutSec: 30,
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
    // 5 sec floor (so we can't lock ourselves out of /settings instantly)
    // 1 hour ceiling (anything longer is effectively "off"; users can use
    // the explicit "Back to idle" buttons).
    if (t < 5)    t = 5;
    if (t > 3600) t = 3600;
    out.kioskIdleTimeoutSec = t;
    return out;
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
