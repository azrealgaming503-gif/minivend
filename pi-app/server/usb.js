// USB volume discovery, browse, and import into kiosk asset folders.
//
// Raspberry Pi OS automounts removable drives under /media/<user>/…
// or /run/media/<user>/…. The minivend service user must be in the
// plugdev group (install.sh) and the drive must be mounted before
// browse/import will see it.

const fs = require('fs');
const path = require('path');
const express = require('express');

const VIDEO_EXTS = new Set(['.mp4', '.webm', '.mov', '.m4v']);
const IMAGE_EXTS = new Set(['.gif', '.webp', '.png', '.jpg', '.jpeg']);
const ALL_EXTS = new Set([...VIDEO_EXTS, ...IMAGE_EXTS]);
const STICKER_EXTS = new Set(['.gif', '.webp', '.png', '.jpg', '.jpeg']);

const USB_FS = new Set([
  'vfat', 'fat', 'fat32', 'exfat', 'ntfs', 'ntfs3', 'fuseblk',
  'ext4', 'ext3', 'ext2', 'btrfs', 'hfs', 'hfsplus', 'udf',
]);

function safeName(name) {
  const base = path.basename(name);
  return base.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 100);
}

function encodeVolumeId(absPath) {
  return Buffer.from(absPath, 'utf8').toString('base64url');
}

function decodeVolumeId(id) {
  if (!id || typeof id !== 'string') return null;
  try {
    const p = Buffer.from(id, 'base64url').toString('utf8');
    if (!p.startsWith('/')) return null;
    return p;
  } catch (_) {
    return null;
  }
}

function isReadableDir(p) {
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return false;
    fs.accessSync(p, fs.constants.R_OK | fs.constants.X_OK);
    return true;
  } catch (_) {
    return false;
  }
}

function resolveInsideVolume(volumeRoot, relPath) {
  const rootReal = fs.realpathSync(volumeRoot);
  const joined = relPath
    ? path.join(rootReal, relPath.split('/').filter(Boolean).join(path.sep))
    : rootReal;
  const targetReal = fs.realpathSync(joined);
  if (targetReal !== rootReal && !targetReal.startsWith(rootReal + path.sep)) {
    throw new Error('path_outside_volume');
  }
  return { rootReal, targetReal, relPath: relPath || '' };
}

function readManifest(packDir) {
  const manifestPath = path.join(packDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (m && m.type === 'cat-cycle' && Array.isArray(m.sequence) && m.sequence.length > 0) {
      return m;
    }
    return null;
  } catch (_) {
    return null;
  }
}

function listVolumes() {
  const volumes = [];
  const seen = new Set();

  let mounts = '';
  try {
    mounts = fs.readFileSync('/proc/mounts', 'utf8');
  } catch (_) {
    return volumes;
  }

  for (const line of mounts.split('\n')) {
    const parts = line.split(' ');
    if (parts.length < 3) continue;
    const mountPoint = parts[1].replace(/\\040/g, ' ');
    const fstype = parts[2];

    const underMedia =
      mountPoint.startsWith('/media/') ||
      mountPoint.startsWith('/run/media/');
    if (!underMedia) continue;

    // Skip the automount parent stubs (not the actual volume root).
    if (mountPoint === '/media' || mountPoint === '/run/media') continue;
    if (/^\/media\/[^/]+$/.test(mountPoint)) continue;
    if (/^\/run\/media\/[^/]+$/.test(mountPoint)) continue;

    if (!USB_FS.has(fstype) && fstype !== 'fuseblk') continue;
    if (!isReadableDir(mountPoint)) continue;

    let real;
    try {
      real = fs.realpathSync(mountPoint);
    } catch (_) {
      continue;
    }
    if (seen.has(real)) continue;
    seen.add(real);

    volumes.push({
      id: encodeVolumeId(real),
      label: path.basename(real) || 'USB',
      path: real,
      fstype,
    });
  }

  volumes.sort((a, b) => a.label.localeCompare(b.label));
  return volumes;
}

function browseVolume(volumeRoot, relPath = '') {
  const { targetReal, relPath: safeRel } = resolveInsideVolume(volumeRoot, relPath);
  if (!fs.statSync(targetReal).isDirectory()) {
    throw new Error('not_a_directory');
  }

  const entries = [];
  let dirents;
  try {
    dirents = fs.readdirSync(targetReal, { withFileTypes: true });
  } catch (e) {
    throw new Error(`cannot_read: ${e.message}`);
  }

  for (const e of dirents) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(targetReal, e.name);
    const entryRel = safeRel ? `${safeRel}/${e.name}` : e.name;

    if (e.isDirectory()) {
      const manifest = readManifest(full);
      entries.push({
        name: e.name,
        path: entryRel,
        kind: manifest ? 'pack' : 'dir',
      });
    } else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (!ALL_EXTS.has(ext)) continue;
      const stat = fs.statSync(full);
      entries.push({
        name: e.name,
        path: entryRel,
        kind: 'file',
        size: stat.size,
        ext,
      });
    }
  }

  entries.sort((a, b) => {
    const order = { dir: 0, pack: 1, file: 2 };
    const oa = order[a.kind] ?? 2;
    const ob = order[b.kind] ?? 2;
    if (oa !== ob) return oa - ob;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  return {
    path: safeRel,
    parent: safeRel ? safeRel.split('/').slice(0, -1).join('/') : null,
    entries,
  };
}

function uniqueDestPath(destDir, baseName) {
  let name = safeName(baseName);
  let dest = path.join(destDir, name);
  let n = 1;
  while (fs.existsSync(dest)) {
    const ext = path.extname(name);
    const stem = path.basename(name, ext) || 'file';
    name = `${stem}_${n}${ext}`;
    dest = path.join(destDir, name);
    n += 1;
  }
  return dest;
}

function copyTree(src, dest) {
  const stat = fs.statSync(src);
  if (stat.isDirectory()) {
    fs.mkdirSync(dest, { recursive: true });
    for (const name of fs.readdirSync(src)) {
      if (name.startsWith('.')) continue;
      copyTree(path.join(src, name), path.join(dest, name));
    }
  } else {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
}

function importFromUsb({ volumeRoot, relPath, target, store, uiImgDir }) {
  const { targetReal } = resolveInsideVolume(volumeRoot, relPath);
  const stat = fs.statSync(targetReal);
  const baseName = path.basename(targetReal);

  if (target === 'idle') {
    if (stat.isDirectory()) {
      const manifest = readManifest(targetReal);
      if (!manifest) throw new Error('not_idle_pack');
      const dest = uniqueDestPath(store.idleDir, baseName);
      copyTree(targetReal, dest);
      return { kind: 'pack', name: path.basename(dest), dest };
    }
    const ext = path.extname(baseName).toLowerCase();
    if (!ALL_EXTS.has(ext)) throw new Error('unsupported_type');
    const dest = uniqueDestPath(store.idleDir, baseName);
    fs.copyFileSync(targetReal, dest);
    return { kind: 'file', name: path.basename(dest), dest };
  }

  if (target === 'alerts') {
    if (stat.isDirectory()) throw new Error('alerts_need_single_file');
    const ext = path.extname(baseName).toLowerCase();
    if (!ALL_EXTS.has(ext)) throw new Error('unsupported_type');
    const dest = uniqueDestPath(store.alertsDir, baseName);
    fs.copyFileSync(targetReal, dest);
    return { kind: 'file', name: path.basename(dest), dest };
  }

  if (target === 'sticker') {
    if (stat.isDirectory()) throw new Error('sticker_need_single_file');
    const ext = path.extname(baseName).toLowerCase();
    if (!STICKER_EXTS.has(ext)) throw new Error('unsupported_sticker_type');
    const outName = ext === '.gif' ? 'blu-happy.gif' : 'blu-happy.png';
    const dest = path.join(uiImgDir, outName);
    fs.mkdirSync(uiImgDir, { recursive: true });
    fs.copyFileSync(targetReal, dest);
    return { kind: 'sticker', name: outName, url: `/img/${outName}`, dest };
  }

  throw new Error('bad_target');
}

function mount(app, { store, broadcast, uiImgDir }) {
  app.get('/api/usb/volumes', (_req, res) => {
    try {
      const volumes = listVolumes();
      res.json({ ok: true, volumes });
    } catch (e) {
      res.status(500).json({ ok: false, err: e.message });
    }
  });

  app.get('/api/usb/browse', (req, res) => {
    const volumeId = req.query.volume;
    const rel = (req.query.path || '').toString();
    const volumePath = decodeVolumeId(volumeId);
    if (!volumePath || !isReadableDir(volumePath)) {
      return res.status(400).json({ ok: false, err: 'invalid_volume' });
    }
    try {
      const data = browseVolume(volumePath, rel);
      res.json({ ok: true, volume: volumeId, ...data });
    } catch (e) {
      res.status(400).json({ ok: false, err: e.message });
    }
  });

  app.post('/api/usb/import', express.json({ limit: '8kb' }), async (req, res) => {
    const body = req.body || {};
    const volumePath = decodeVolumeId(body.volume);
    const rel = (body.path || '').toString();
    const target = body.target;
    const activate = body.activate !== false;

    if (!volumePath || !isReadableDir(volumePath)) {
      return res.status(400).json({ ok: false, err: 'invalid_volume' });
    }
    if (!['idle', 'alerts', 'sticker'].includes(target)) {
      return res.status(400).json({ ok: false, err: 'bad_target' });
    }

    try {
      const imported = importFromUsb({
        volumeRoot: volumePath,
        relPath: rel,
        target,
        store,
        uiImgDir,
      });

      let active = null;
      if (target === 'idle' && activate) {
        active = store.setActiveIdle(imported.name);
        broadcast({ type: 'idle_changed', active });
      } else if (target === 'alerts' && activate) {
        active = store.setActiveAlert(imported.name);
        broadcast({ type: 'alert_asset_changed', active });
      } else if (target === 'sticker') {
        broadcast({ type: 'sticker_changed', url: imported.url });
      }

      res.json({ ok: true, imported, active });
    } catch (e) {
      res.status(400).json({ ok: false, err: e.message });
    }
  });
}

module.exports = { mount, listVolumes, browseVolume, ALL_EXTS };
