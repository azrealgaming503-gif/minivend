// Asset management: idle animation + per-tier donation alerts.
//
// The idle library supports two shapes:
//   1. A single media file (mp4/webm/gif/webp/png/jpg) dropped directly
//      under {assetsDir}/idle/.  Loops forever, no state.
//   2. A *pack* — a subdirectory under {assetsDir}/idle/ that contains a
//      `manifest.json` and the video clips it references.  The UI runs
//      a state machine described by the manifest (eg. cat-cycle: nap
//      loops with transitions between them).
//
// The "active" idle pick is stored in state.json by name (file basename
// or directory name).  The UI gets the full description from
// /api/assets/idle/active.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
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

function readManifest(packDir) {
  const manifestPath = path.join(packDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const raw = fs.readFileSync(manifestPath, 'utf8');
    const m = JSON.parse(raw);
    // Light validation. Accept the cat-cycle shape; reject everything else
    // so the UI doesn't have to second-guess.
    if (m && m.type === 'cat-cycle' && Array.isArray(m.sequence) && m.sequence.length > 0) {
      return m;
    }
    return null;
  } catch (_) {
    return null;
  }
}

// Returns a sorted list of entries in the idle dir, with metadata.
// Each entry is either { kind:'file', name, size, mtime } for flat files
// or { kind:'pack', name, mtime, manifest } for directories.
function listIdle(dir) {
  ensureDir(dir);
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isFile() && ALL_EXTS.has(path.extname(e.name).toLowerCase())) {
      const stat = fs.statSync(full);
      out.push({ kind: 'file', name: e.name, size: stat.size, mtime: stat.mtimeMs });
    } else if (e.isDirectory()) {
      const m = readManifest(full);
      if (m) {
        const stat = fs.statSync(full);
        out.push({ kind: 'pack', name: e.name, mtime: stat.mtimeMs, manifest: m });
      }
    }
  }
  return out.sort((a, b) => b.mtime - a.mtime);
}

// Internal: classify a name to either { kind:'file', ... }, { kind:'pack', ... } or null.
function describeIdle(idleDir, name) {
  if (!name) return null;
  const safe = safeName(name);
  const full = path.join(idleDir, safe);
  if (!fs.existsSync(full)) return null;
  const stat = fs.statSync(full);
  if (stat.isFile()) return { kind: 'file', name: safe };
  if (stat.isDirectory()) {
    const m = readManifest(full);
    if (m) return { kind: 'pack', name: safe, manifest: m };
  }
  return null;
}

// Extracts the first frame of `videoPath` to `jpgPath` using ffmpeg.
// Returns a promise that resolves on success and rejects on failure.
// Idempotent: if jpgPath already exists, resolves immediately.
function extractFirstFrame(videoPath, jpgPath) {
  if (fs.existsSync(jpgPath)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-loglevel', 'error',
      '-i', videoPath,
      '-frames:v', '1',
      '-q:v', '4',
      jpgPath,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => reject(e));
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(jpgPath)) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.trim().slice(0, 200)}`));
    });
  });
}

// Probe a video's primary stream with ffprobe. Resolves to
// { codec, pixFmt, width, height } or null if ffprobe fails (missing
// binary, corrupt/non-video file, etc).
function probeVideo(videoPath) {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name,pix_fmt,width,height',
      '-of', 'json',
      videoPath,
    ];
    let out = '';
    let proc;
    try {
      proc = spawn('ffprobe', args, { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (_) { return resolve(null); }
    proc.stdout.on('data', (d) => { out += d.toString(); });
    proc.on('error', () => resolve(null));
    proc.on('close', () => {
      try {
        const j = JSON.parse(out);
        const s = j && j.streams && j.streams[0];
        if (!s) return resolve(null);
        resolve({
          codec: s.codec_name || null,
          pixFmt: s.pix_fmt || null,
          width: Number(s.width) || null,
          height: Number(s.height) || null,
        });
      } catch (_) { resolve(null); }
    });
  });
}

// Longest edge we re-scale down to, to keep the Pi's software H.264 decode
// smooth (4K software-decodes poorly and can render black).
const MAX_EDGE = 1920;

// Transcode any video to a kiosk-safe H.264 mp4: 8-bit yuv420p, longest
// edge capped at MAX_EDGE (keeps Pi software decode smooth), faststart for
// instant start, audio dropped (the kiosk is muted anyway). Resolves on
// success, rejects on failure.
function transcodeToKioskMp4(src, dst) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-loglevel', 'error',
      '-i', src,
      '-map', '0:v:0',
      '-c:v', 'libx264',
      '-profile:v', 'high',
      '-pix_fmt', 'yuv420p',
      '-preset', 'veryfast',
      '-crf', '20',
      '-vf', `scale=w=${MAX_EDGE}:h=${MAX_EDGE}:force_original_aspect_ratio=decrease:force_divisible_by=2`,
      '-an',
      '-movflags', '+faststart',
      dst,
    ];
    let proc;
    let stderr = '';
    try {
      proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (e) { return reject(e); }
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    proc.on('error', (e) => reject(e));
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(dst)) resolve();
      else reject(new Error(`ffmpeg exit ${code}: ${stderr.trim().slice(0, 200)}`));
    });
  });
}

// Normalize a freshly-uploaded idle file. Images pass through untouched.
// EVERY video is re-encoded to a clean, standard, faststart H.264 baseline
// rather than trusting the uploaded stream: files that merely *probe* as
// "h264" can still refuse to render in Chromium (odd profiles/levels, edit
// lists, VFR, missing faststart, non-yuv420p that probes as yuv420p, etc.)
// and show as a black screen. ffmpeg decodes far more than the browser
// does, so a full re-encode reliably produces something the kiosk (and a
// remote browser) can actually play. Returns the final on-disk name (may
// change extension to .mp4) plus whether a conversion happened.
async function normalizeIdleUpload(idleDir, name) {
  const ext = path.extname(name).toLowerCase();
  if (!VIDEO_EXTS.has(ext)) return { name, converted: false };

  const src = path.join(idleDir, name);
  const info = await probeVideo(src);

  const base = path.basename(name, ext);
  const finalName = safeName(`${base}.mp4`);
  const finalPath = path.join(idleDir, finalName);
  const tmpPath = path.join(idleDir, `.transcode-${Date.now()}.mp4`);

  try {
    await transcodeToKioskMp4(src, tmpPath);
  } catch (e) {
    // Leave the original in place so the user at least has their file;
    // the caller surfaces the reason so the UI can warn.
    try { fs.unlinkSync(tmpPath); } catch (_) {}
    console.warn(`[assets] idle transcode failed for ${name}: ${e.message}`);
    return { name, converted: false, error: e.message };
  }

  // Drop the original upload if we changed container/extension, then move
  // the transcode into place (overwriting a same-named prior .mp4).
  if (src !== finalPath) { try { fs.unlinkSync(src); } catch (_) {} }
  try { fs.unlinkSync(finalPath); } catch (_) {}
  fs.renameSync(tmpPath, finalPath);
  return { name: finalName, converted: true, from: (info && info.codec) || 'unknown' };
}

// For a cat-cycle pack, extract first-frame thumbnails of every clip
// into the pack's `_frames/` dir so the UI can use them as cover images
// during clip swaps. Returns a promise that resolves once every frame
// is on disk. Idempotent and cheap on second call (existing JPGs are
// skipped instantly).
function ensurePackFrames(packDir, manifest) {
  const framesDir = path.join(packDir, '_frames');
  ensureDir(framesDir);
  const clips = new Set();
  for (const step of (manifest.sequence || [])) {
    if (step.loop) clips.add(step.loop);
    if (step.transition) clips.add(step.transition);
  }
  const jobs = [];
  for (const clip of clips) {
    const src = path.join(packDir, clip);
    const dst = path.join(framesDir, clip + '.jpg');
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue;
    jobs.push(
      extractFirstFrame(src, dst).catch((e) => {
        console.warn(`[assets] first-frame extract failed for ${clip}: ${e.message}`);
      })
    );
  }
  return Promise.all(jobs);
}

function listFolderFlat(dir) {
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
    this.overlaysDir = path.join(assetsDir, 'overlays');
    this.statePath = path.join(assetsDir, 'state.json');
    ensureDir(this.idleDir);
    ensureDir(this.alertsDir);
    ensureDir(this.overlaysDir);
    this.state = { activeIdle: null, activeAlert: null, donationOverlay: null, redeemOverlay: null };
    this._load();
    // Auto-pick something if nothing's chosen yet — prefer packs over flat
    // files since they're usually the curated artist asset.
    if (!this.state.activeIdle) {
      const entries = listIdle(this.idleDir);
      const pack = entries.find((e) => e.kind === 'pack');
      const file = entries.find((e) => e.kind === 'file');
      const pick = pack || file;
      if (pick) this.setActiveIdle(pick.name);
    }
    if (!this.state.activeAlert) {
      const alerts = listFolderFlat(this.alertsDir);
      if (alerts[0]) this.setActiveAlert(alerts[0].name);
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
    const desc = describeIdle(this.idleDir, name);
    if (!desc) throw new Error(`no such idle asset: ${name}`);
    this.state.activeIdle = desc.name;
    this._save();
    if (desc.kind === 'pack') {
      ensurePackFrames(path.join(this.idleDir, desc.name), desc.manifest);
    }
    return desc.name;
  }

  // Returns null or a description of the active idle:
  //   { kind:'file', name }                      → single clip / image
  //   { kind:'pack', name, manifest }            → state-machine animation
  getActiveIdleDescription() {
    if (!this.state.activeIdle) return null;
    return describeIdle(this.idleDir, this.state.activeIdle);
  }

  // Legacy shim: name only.
  getActiveIdle() {
    const d = this.getActiveIdleDescription();
    return d ? d.name : null;
  }

  // ----- Alert emote (donation-overlay animation) -----
  setActiveAlert(name) {
    if (!name) { this.state.activeAlert = null; this._save(); return null; }
    const safe = safeName(name);
    const full = path.join(this.alertsDir, safe);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      throw new Error(`no such alert asset: ${name}`);
    }
    this.state.activeAlert = safe;
    this._save();
    return safe;
  }

  getActiveAlert() {
    const name = this.state.activeAlert;
    if (!name) return null;
    const full = path.join(this.alertsDir, name);
    if (!fs.existsSync(full)) return null;
    return name;
  }

  // ----- Overlay GIFs (donation + redeem, one each) -----
  // Each overlay has its own optional image. `kind` is 'donation' or
  // 'redeem'; stored in state as donationOverlay / redeemOverlay.
  _overlayKey(kind) {
    if (kind === 'donation') return 'donationOverlay';
    if (kind === 'redeem')   return 'redeemOverlay';
    throw new Error(`bad overlay kind: ${kind}`);
  }

  setOverlay(kind, name) {
    const key = this._overlayKey(kind);
    // Remove any previous file for this kind so old uploads don't pile up.
    const prev = this.state[key];
    if (prev && prev !== name) {
      try { fs.unlinkSync(path.join(this.overlaysDir, prev)); } catch (_) {}
    }
    this.state[key] = name || null;
    this._save();
    return this.state[key];
  }

  clearOverlay(kind) {
    const key = this._overlayKey(kind);
    const prev = this.state[key];
    if (prev) {
      try { fs.unlinkSync(path.join(this.overlaysDir, prev)); } catch (_) {}
    }
    this.state[key] = null;
    this._save();
  }

  getOverlay(kind) {
    const name = this.state[this._overlayKey(kind)];
    if (!name) return null;
    if (!fs.existsSync(path.join(this.overlaysDir, name))) return null;
    return name;
  }

  overlayUrl(kind) {
    const name = this.getOverlay(kind);
    return name ? `/assets/overlays/${encodeURIComponent(name)}` : null;
  }
}

function mount(app, { store, broadcast }) {
  const idleUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, store.idleDir),
      filename:    (_req, file, cb) => cb(null, safeName(file.originalname)),
    }),
    limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB — videos add up
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(ALL_EXTS.has(ext) ? null : new Error('unsupported file type'), ALL_EXTS.has(ext));
    },
  });

  // Static serve the raw files (works for both flat files and pack subdirs).
  app.use('/assets/idle',     express.static(store.idleDir,     { fallthrough: false }));
  app.use('/assets/alerts',   express.static(store.alertsDir,   { fallthrough: false }));
  app.use('/assets/overlays', express.static(store.overlaysDir, { fallthrough: false }));

  // ----- Overlay GIFs (donation + redeem) -----
  // One optional image per overlay. Uploaded via the drag-and-drop zones
  // on the Donations / Settings pages. Images only (gif/png/webp/jpg).
  const overlayUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, store.overlaysDir),
      filename: (req, file, cb) => {
        const kind = req.params.kind === 'redeem' ? 'redeem' : 'donation';
        // Prefix with kind + timestamp so a new upload never collides with
        // the old file that setOverlay() is about to delete.
        cb(null, `${kind}-${Date.now()}-${safeName(file.originalname)}`);
      },
    }),
    limits: { fileSize: 25 * 1024 * 1024 },
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      const ok = IMAGE_EXTS.has(ext);
      cb(ok ? null : new Error('overlay images must be gif/png/webp/jpg'), ok);
    },
  });

  app.get('/api/assets/overlay', (_req, res) => {
    res.json({
      ok: true,
      donation: store.overlayUrl('donation'),
      redeem:   store.overlayUrl('redeem'),
    });
  });

  app.post('/api/assets/overlay/:kind', (req, res) => {
    const kind = req.params.kind;
    if (kind !== 'donation' && kind !== 'redeem') {
      return res.status(400).json({ ok: false, err: 'bad_kind' });
    }
    overlayUpload.single('file')(req, res, (err) => {
      if (err) return res.status(400).json({ ok: false, err: err.message });
      if (!req.file) return res.status(400).json({ ok: false, err: 'no_file' });
      store.setOverlay(kind, req.file.filename);
      const urls = { donation: store.overlayUrl('donation'), redeem: store.overlayUrl('redeem') };
      broadcast({ type: 'overlay_changed', ...urls });
      res.json({ ok: true, url: urls[kind], ...urls });
    });
  });

  app.delete('/api/assets/overlay/:kind', (req, res) => {
    const kind = req.params.kind;
    if (kind !== 'donation' && kind !== 'redeem') {
      return res.status(400).json({ ok: false, err: 'bad_kind' });
    }
    store.clearOverlay(kind);
    const urls = { donation: store.overlayUrl('donation'), redeem: store.overlayUrl('redeem') };
    broadcast({ type: 'overlay_changed', ...urls });
    res.json({ ok: true, ...urls });
  });

  // Full description of the active idle pick. Replaces the old 302 endpoint.
  app.get('/api/assets/idle/active', async (_req, res) => {
    const d = store.getActiveIdleDescription();
    if (!d) return res.status(404).json({ ok: false, err: 'no_active_idle' });
    if (d.kind === 'file') {
      return res.json({
        ok: true,
        kind: 'file',
        name: d.name,
        url:  `/assets/idle/${encodeURIComponent(d.name)}`,
      });
    }
    // pack
    // Make sure all first-frame thumbnails exist on disk BEFORE we tell
    // the UI to start playing. This avoids the race where the UI fetches
    // /assets/.../_frames/foo.jpg before ffmpeg has finished writing it,
    // ends up with a broken <img> cached for the rest of the session,
    // and shows blank flashes on every swap. Cheap on subsequent calls.
    await ensurePackFrames(path.join(store.idleDir, d.name), d.manifest);
    return res.json({
      ok: true,
      kind: 'pack',
      name: d.name,
      baseUrl:   `/assets/idle/${encodeURIComponent(d.name)}/`,
      framesUrl: `/assets/idle/${encodeURIComponent(d.name)}/_frames/`,
      manifest:  d.manifest,
    });
  });

  app.get('/api/assets/idle', (_req, res) => {
    res.json({
      ok: true,
      active: store.getActiveIdle(),
      entries: listIdle(store.idleDir),
      // Back-compat for older clients that expect a flat file list.
      files: listFolderFlat(store.idleDir),
    });
  });

  app.post('/api/assets/idle',
    idleUpload.single('file'),
    async (req, res) => {
      if (!req.file) return res.status(400).json({ ok: false, err: 'no_file' });
      // Auto-convert videos the Pi's Chromium can't decode (HEVC/10-bit/4K)
      // to a kiosk-safe H.264 mp4 so uploads never render as a black screen.
      let filename = req.file.filename;
      let normalized = { converted: false };
      try {
        normalized = await normalizeIdleUpload(store.idleDir, filename);
        filename = normalized.name;
      } catch (e) {
        console.warn(`[assets] normalize error for ${filename}: ${e.message}`);
      }
      const setActive = req.query.activate !== '0';
      let active = store.getActiveIdle();
      if (setActive) active = store.setActiveIdle(filename);
      broadcast({ type: 'idle_changed', active });
      res.json({
        ok: true,
        file: filename,
        active,
        converted: !!normalized.converted,
        convertedFrom: normalized.from || null,
        convertError: normalized.error || null,
      });
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

  // ----- Alert emote endpoints -----
  const alertUpload = multer({
    storage: multer.diskStorage({
      destination: (_req, _file, cb) => cb(null, store.alertsDir),
      filename:    (_req, file, cb) => cb(null, safeName(file.originalname)),
    }),
    limits: { fileSize: 50 * 1024 * 1024 }, // emotes are small
    fileFilter: (_req, file, cb) => {
      const ext = path.extname(file.originalname).toLowerCase();
      cb(ALL_EXTS.has(ext) ? null : new Error('unsupported file type'), ALL_EXTS.has(ext));
    },
  });

  app.get('/api/assets/alerts', (_req, res) => {
    const active = store.getActiveAlert();
    res.json({
      ok: true,
      active,
      activeUrl: active ? `/assets/alerts/${encodeURIComponent(active)}` : null,
      files: listFolderFlat(store.alertsDir),
    });
  });

  app.post('/api/assets/alerts',
    alertUpload.single('file'),
    (req, res) => {
      if (!req.file) return res.status(400).json({ ok: false, err: 'no_file' });
      const setActive = req.query.activate !== '0';
      let active = store.getActiveAlert();
      if (setActive) active = store.setActiveAlert(req.file.filename);
      broadcast({ type: 'alert_asset_changed', active });
      res.json({ ok: true, file: req.file.filename, active });
    },
  );

  app.post('/api/assets/alerts/active', express.json({ limit: '4kb' }), (req, res) => {
    try {
      const name = store.setActiveAlert((req.body && req.body.name) || '');
      broadcast({ type: 'alert_asset_changed', active: name });
      res.json({ ok: true, active: name });
    } catch (e) {
      res.status(400).json({ ok: false, err: e.message });
    }
  });

  app.delete('/api/assets/alerts/:name', (req, res) => {
    const safe = safeName(req.params.name);
    const target = path.join(store.alertsDir, safe);
    if (!fs.existsSync(target)) return res.status(404).json({ ok: false, err: 'not_found' });
    fs.unlinkSync(target);
    if (store.state.activeAlert === safe) {
      const remaining = listFolderFlat(store.alertsDir);
      try {
        store.setActiveAlert(remaining[0] ? remaining[0].name : null);
      } catch (_) { store.state.activeAlert = null; store._save(); }
      broadcast({ type: 'alert_asset_changed', active: store.getActiveAlert() });
    }
    res.json({ ok: true });
  });

  app.delete('/api/assets/idle/:name', (req, res) => {
    const safe = safeName(req.params.name);
    const target = path.join(store.idleDir, safe);
    if (!fs.existsSync(target)) return res.status(404).json({ ok: false, err: 'not_found' });
    const stat = fs.statSync(target);
    if (stat.isDirectory()) fs.rmSync(target, { recursive: true, force: true });
    else fs.unlinkSync(target);
    if (store.state.activeIdle === safe) {
      store.state.activeIdle = null;
      const remaining = listIdle(store.idleDir);
      const pick = remaining[0];
      if (pick) store.setActiveIdle(pick.name);
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
