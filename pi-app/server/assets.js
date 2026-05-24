// Asset management: idle animation + per-tier donation alerts.
//
// Files live on disk under {assetsDir}/idle and {assetsDir}/alerts.
// The "active" idle animation is selected by name; the UI requests it
// from /api/assets/idle/active and the server 302s to the chosen file.

const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');

const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const IMAGE_EXTS = new Set(['.gif', '.webp', '.png', '.jpg', '.jpeg']);
const ALL_EXTS = new Set([...VIDEO_EXTS, ...IMAGE_EXTS]);

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function safeName(name) {
  // Strip directory components and weird characters.
  const base = path.basename(name);
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

function listFolder(dir) {
  ensureDir(dir);
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && ALL_EXTS.has(path.extname(e.name).toLowerCase()))
    .map((e) => {
      const stat = fs.statSync(path.join(dir, e.name));
      return { name: e.name, size: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
}

class AssetStore {
  constructor({ assetsDir }) {
    this.dir = assetsDir;
    this.idleDir = path.join(assetsDir, 'idle');
    this.alertsDir = path.join(assetsDir, 'alerts');
    this.statePath = path.join(assetsDir, 'state.json');
    ensureDir(this.idleDir);
    ensureDir(this.alertsDir);
    this.state = { activeIdle: null };
    this._load();
    // Auto-select something if no choice has been made yet.
    if (!this.state.activeIdle) {
      const files = listFolder(this.idleDir);
      if (files.length > 0) this.setActiveIdle(files[0].name);
    }
  }

  _load() {
    try {
      this.state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
    } catch (_) { /* first boot */ }
  }
  _save() {
    fs.writeFileSync(this.statePath, JSON.stringify(this.state, null, 2));
  }

  setActiveIdle(name) {
    const safe = safeName(name);
    const target = path.join(this.idleDir, safe);
    if (!fs.existsSync(target)) throw new Error(`no such idle asset: ${safe}`);
    this.state.activeIdle = safe;
    this._save();
    return safe;
  }

  getActiveIdle() {
    if (!this.state.activeIdle) return null;
    const target = path.join(this.idleDir, this.state.activeIdle);
    return fs.existsSync(target) ? this.state.activeIdle : null;
  }
}

function mount(app, { store, broadcast }) {
  const idleUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, store.idleDir),
      filename:    (_req, file, cb) => cb(null, safeName(file.originalname)),
    }),
    limits: { fileSize: 200 * 1024 * 1024 }, // 200 MB
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(ALL_EXTS.has(ext) ? null : new Error('unsupported file type'), ALL_EXTS.has(ext));
    },
  });

  // Static serve the raw files.
  app.use('/assets/idle',   express.static(store.idleDir,   { fallthrough: false }));
  app.use('/assets/alerts', express.static(store.alertsDir, { fallthrough: false }));

  // Active idle: 302 to the current pick, or 404 if none set.
  app.get('/api/assets/idle/active', (_req, res) => {
    const name = store.getActiveIdle();
    if (!name) return res.status(404).json({ ok: false, err: 'no_active_idle' });
    res.redirect(302, `/assets/idle/${encodeURIComponent(name)}`);
  });

  app.get('/api/assets/idle', (_req, res) => {
    res.json({
      ok: true,
      active: store.getActiveIdle(),
      files: listFolder(store.idleDir),
    });
  });

  app.post('/api/assets/idle',
    idleUpload.single('file'),
    (req, res) => {
      if (!req.file) return res.status(400).json({ ok: false, err: 'no_file' });
      const setActive = req.query.activate !== '0';
      let active = store.getActiveIdle();
      if (setActive) active = store.setActiveIdle(req.file.filename);
      broadcast({ type: 'idle_changed', active });
      res.json({ ok: true, file: req.file.filename, active });
    },
  );

  app.post('/api/assets/idle/active', express.json({ limit: '4kb' }), (req, res) => {
    try {
      const name = store.setActiveIdle((req.body && req.body.name) || '');
      broadcast({ type: 'idle_changed', active: name });
      res.json({ ok: true, active: name });
    } catch (e) {
      res.status(400).json({ ok: false, err: e.message });
    }
  });

  app.delete('/api/assets/idle/:name', (req, res) => {
    const safe = safeName(req.params.name);
    const target = path.join(store.idleDir, safe);
    if (!fs.existsSync(target)) return res.status(404).json({ ok: false, err: 'not_found' });
    fs.unlinkSync(target);
    if (store.state.activeIdle === safe) {
      store.state.activeIdle = null;
      const remaining = listFolder(store.idleDir);
      if (remaining.length > 0) store.setActiveIdle(remaining[0].name);
      else store._save();
      broadcast({ type: 'idle_changed', active: store.getActiveIdle() });
    }
    res.json({ ok: true });
  });
}

function mountGames(app, { gamesDir }) {
  app.get('/api/games', (_req, res) => {
    ensureDir(gamesDir);
    const entries = fs.readdirSync(gamesDir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(gamesDir, e.name, 'index.html')))
      .map((e) => ({ name: e.name, path: `/games/${encodeURIComponent(e.name)}/` }));
    res.json({ ok: true, games: entries });
  });
}

module.exports = { AssetStore, mount, mountGames };
