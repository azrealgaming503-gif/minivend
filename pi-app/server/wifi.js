// Wi-Fi status + provisioning hooks.
//
// On the Pi we delegate provisioning to `comitup`, which when no Wi-Fi
// is configured automatically brings up an access point named
// "comitup-XXXX" that hosts a captive portal for the customer's phone
// to pick a network. This module only needs to:
//
//   - Report whether we're currently associated with a network and what
//     its SSID + IP are (so the UI can show it).
//   - Provide a "forget Wi-Fi" action which kicks comitup back into
//     captive-portal mode for re-provisioning.
//
// We shell out to small standard utilities (`iwgetid`, `hostname`,
// `comitup-cli`) rather than linking to NetworkManager directly — this
// keeps the module portable across slightly-different Pi OS images.

const { exec } = require('child_process');

function run(cmd, timeoutMs = 4000) {
  return new Promise((resolve) => {
    exec(cmd, { timeout: timeoutMs }, (err, stdout) => {
      resolve({ ok: !err, out: (stdout || '').toString().trim() });
    });
  });
}

async function getStatus() {
  // SSID — `iwgetid -r` prints the current SSID or nothing if not associated.
  const ssidResult = await run('iwgetid -r');
  const ssid = ssidResult.ok && ssidResult.out ? ssidResult.out : null;

  // IP address on wlan0 (fallback to eth0 if wlan0 is absent).
  const ipResult = await run("ip -4 -o addr show scope global | awk '{print $2,$4}'");
  let ip = null;
  let iface = null;
  if (ipResult.ok && ipResult.out) {
    for (const line of ipResult.out.split('\n')) {
      const [dev, cidr] = line.split(/\s+/);
      if (!dev || !cidr) continue;
      const addr = cidr.split('/')[0];
      if (dev === 'wlan0') { ip = addr; iface = 'wlan0'; break; }
      if (!ip && dev !== 'lo') { ip = addr; iface = dev; }
    }
  }

  // Detect comitup captive-portal mode by looking for the "comitup-" SSID
  // prefix on a hosted AP. If we see it, we're not associated.
  const inSetupMode = ssid && /^comitup-\d+/i.test(ssid);

  // Hostname — useful for "find me on the network as ..."
  const hostResult = await run('hostname');
  const hostname = hostResult.ok ? hostResult.out : null;

  return {
    connected: !!ssid && !inSetupMode,
    setupMode: !!inSetupMode,
    ssid,
    ip,
    iface,
    hostname,
  };
}

async function forget() {
  // Try the most-precise tool first, fall back through alternatives.
  // The sudoers drop-in installed by scripts/install.sh allows the
  // service user to run these without a password.
  const candidates = [
    'sudo -n /usr/bin/comitup-cli d',
    "sudo -n /usr/bin/nmcli connection delete id \"$(iwgetid -r)\"",
  ];
  for (const c of candidates) {
    const r = await run(c, 6000);
    if (r.ok) return { ok: true, via: c };
  }
  return { ok: false, err: 'no_method_succeeded' };
}

function mount(app) {
  const express = require('express');
  app.get('/api/wifi', async (_req, res) => {
    try {
      const s = await getStatus();
      res.json({ ok: true, ...s });
    } catch (e) {
      res.status(500).json({ ok: false, err: e.message });
    }
  });

  app.post('/api/wifi/forget', express.json({ limit: '1kb' }), async (_req, res) => {
    const r = await forget();
    res.json(r);
  });
}

module.exports = { mount, getStatus };
