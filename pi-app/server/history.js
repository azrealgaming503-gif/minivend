// Donation history.
//
// Append-only JSON log of every donation event the device has seen
// (StreamElements, Ko-fi, or test). Each entry captures the donor info,
// the resolved chamber, and the final outcome — useful both for the
// settings UI's "recent donations" view and for streamer post-mortems.
//
// Stored in /var/lib/minivend/donations.json so OTA updates can't wipe
// it. Kept in memory too, with a cap so the file never grows unbounded.

const fs = require('fs');
const path = require('path');

const MAX_ENTRIES = 500;

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

class HistoryStore {
  constructor({ file }) {
    this.file = file;
    ensureDir(path.dirname(file));
    this.entries = [];
    this._load();
  }

  _load() {
    if (!fs.existsSync(this.file)) return;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (Array.isArray(raw)) this.entries = raw.slice(-MAX_ENTRIES);
    } catch (e) {
      console.warn(`[history] could not parse ${this.file}: ${e.message}`);
    }
  }

  _save() {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.entries, null, 2));
    } catch (e) {
      console.warn(`[history] could not write ${this.file}: ${e.message}`);
    }
  }

  // Append a new event. Each entry gets an id (epoch ms) and timestamp.
  // `evt.status` is one of: queued | dispensing | dropped | jam | done |
  // skipped_no_tier | skipped_motor_offline | skipped_offline.
  add(evt) {
    const id = Date.now();
    const entry = {
      id,
      ts: id,
      source:    evt.source    || 'unknown',
      name:      evt.name      || 'Anonymous',
      amount:    Number(evt.amount) || 0,
      currency:  evt.currency  || 'USD',
      message:   evt.message   || '',
      motor:     evt.motor     != null ? Number(evt.motor) : null,
      status:    evt.status    || 'queued',
      detail:    evt.detail    || '',
    };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    }
    this._save();
    return entry;
  }

  // Update status on an existing entry (eg. when the motor confirms a drop).
  update(id, patch) {
    const i = this.entries.findIndex((e) => e.id === id);
    if (i < 0) return null;
    this.entries[i] = { ...this.entries[i], ...patch };
    this._save();
    return this.entries[i];
  }

  list({ limit = 50 } = {}) {
    return this.entries.slice(-limit).reverse();
  }

  clear() {
    this.entries = [];
    this._save();
  }
}

function mount(app, { store, broadcast }) {
  app.get('/api/donations/history', (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, MAX_ENTRIES);
    res.json({ ok: true, entries: store.list({ limit }) });
  });
  app.delete('/api/donations/history', (_req, res) => {
    store.clear();
    if (broadcast) broadcast({ type: 'donations_history_cleared' });
    res.json({ ok: true });
  });
}

module.exports = { HistoryStore, mount, MAX_ENTRIES };
