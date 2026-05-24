// Free, self-hosted OTA updater. The update path is "pull a newer git
// commit from the configured branch, run npm install, restart the
// server, and roll back if the new revision fails its health check".
//
// Storage / hosting cost: zero. The "update server" is whatever git
// host the repo lives on (GitHub, Gitea, your own server). No fleet
// management infrastructure required.
//
// Atomicity: not partition-level like Mender, but functionally good
// enough — we snapshot the current commit before the pull, run a
// health check after restart, and roll back automatically on failure.
// The kiosk service is unaffected by app-server restarts (Chromium
// reconnects to localhost on its own).

const { execFile, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO_DIR = path.resolve(__dirname, '..');                  // pi-app/
const SCRIPT   = path.join(REPO_DIR, 'scripts', 'update.sh');
const STATE    = path.join(REPO_DIR, '.update-state.json');

function execp(file, args, opts = {}) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 15000, cwd: REPO_DIR, ...opts }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        stdout: (stdout || '').toString().trim(),
        stderr: (stderr || '').toString().trim(),
      });
    });
  });
}

async function isGitRepo() {
  const r = await execp('git', ['rev-parse', '--is-inside-work-tree']);
  return r.ok && r.stdout === 'true';
}

async function getVersion() {
  if (!(await isGitRepo())) {
    return { ok: false, err: 'not_a_git_checkout' };
  }
  const [commit, shortCommit, branch, tag, remoteUrl] = await Promise.all([
    execp('git', ['rev-parse', 'HEAD']),
    execp('git', ['rev-parse', '--short', 'HEAD']),
    execp('git', ['rev-parse', '--abbrev-ref', 'HEAD']),
    execp('git', ['describe', '--tags', '--exact-match', 'HEAD']),
    execp('git', ['remote', 'get-url', 'origin']),
  ]);
  return {
    ok: true,
    commit: commit.stdout || null,
    shortCommit: shortCommit.stdout || null,
    branch: branch.stdout || null,
    tag: tag.ok ? tag.stdout : null,
    remote: remoteUrl.stdout || null,
  };
}

async function checkForUpdates() {
  if (!(await isGitRepo())) return { ok: false, err: 'not_a_git_checkout' };

  const branchRes = await execp('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  const branch = branchRes.ok ? branchRes.stdout : 'main';

  const fetchRes = await execp('git', ['fetch', '--quiet', 'origin', branch], { timeout: 30000 });
  if (!fetchRes.ok) return { ok: false, err: `fetch_failed: ${fetchRes.stderr}` };

  const localRes  = await execp('git', ['rev-parse', 'HEAD']);
  const remoteRes = await execp('git', ['rev-parse', `origin/${branch}`]);
  if (!localRes.ok || !remoteRes.ok) return { ok: false, err: 'rev_parse_failed' };

  const local  = localRes.stdout;
  const remote = remoteRes.stdout;
  const upToDate = local === remote;

  // Look at the new commit's metadata so the UI can show something useful.
  let latestMessage = null, latestDate = null;
  if (!upToDate) {
    const meta = await execp('git', ['show', '-s', '--format=%s%n%cI', remote]);
    if (meta.ok) {
      const [subject, isoDate] = meta.stdout.split('\n');
      latestMessage = subject || null;
      latestDate = isoDate || null;
    }
  }

  return {
    ok: true,
    branch,
    current: local,
    latest: remote,
    hasUpdate: !upToDate,
    latestMessage,
    latestDate,
  };
}

let applyChild = null;

function applyUpdate(onProgress) {
  return new Promise((resolve) => {
    if (applyChild) {
      return resolve({ ok: false, err: 'already_running' });
    }
    if (!fs.existsSync(SCRIPT)) {
      return resolve({ ok: false, err: `missing_script: ${SCRIPT}` });
    }
    // Spawn the update script via sudo (NOPASSWD rule covers it — see
    // scripts/sudoers-minivend). We don't await it; the script restarts
    // the server, which kills this Node process. The UI watches for
    // disconnect + reconnect and then refreshes /api/version.
    applyChild = spawn('sudo', ['-n', SCRIPT], {
      cwd: REPO_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });

    let buf = '';
    function emit(chunk) {
      buf += chunk.toString();
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.length > 0) onProgress && onProgress(line);
      }
    }
    applyChild.stdout.on('data', emit);
    applyChild.stderr.on('data', emit);
    applyChild.on('exit', (code) => {
      applyChild = null;
      onProgress && onProgress(`[exit ${code}]`);
    });

    // The script flushes "OK STARTED" to stdout when it has snapshotted
    // and begun. Return as soon as we see that — actual restart happens
    // afterwards.
    const started = setTimeout(() => resolve({ ok: true, started: true }), 1500);
    applyChild.stdout.once('data', (chunk) => {
      if (chunk.toString().includes('STARTED')) {
        clearTimeout(started);
        resolve({ ok: true, started: true });
      }
    });
  });
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch (_) { return null; }
}

function mount(app, { broadcast }) {
  const express = require('express');

  app.get('/api/version', async (_req, res) => {
    const v = await getVersion();
    const state = readState();
    res.json({ ok: v.ok, ...v, lastUpdate: state });
  });

  app.get('/api/update/check', async (_req, res) => {
    const r = await checkForUpdates();
    res.json(r);
  });

  app.post('/api/update/apply', express.json({ limit: '1kb' }), async (_req, res) => {
    broadcast({ type: 'update', phase: 'starting' });
    const r = await applyUpdate((line) => {
      broadcast({ type: 'update', phase: 'log', line });
    });
    res.json(r);
  });
}

module.exports = { mount, getVersion, checkForUpdates, applyUpdate, readState };
