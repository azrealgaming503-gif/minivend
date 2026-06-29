# MiniVend — Pi-side app

Runs on a **Raspberry Pi 5 (4 GB)** with **Raspberry Pi OS Lite (64-bit)**
and a 10.1" 1024×600 HDMI capacitive touchscreen. Owns the UI, donation
pipeline, and asset library. Talks to an **ESP32 motor controller**
(`../esp32-motor/`) over USB-serial.

## Architecture

```
StreamElements OAuth (Astro WS) ─┐
StreamElements / Ko-fi webhooks ─┤
                                 v
                          pi-app (Node)  ─ WebSocket ─►  Chromium kiosk UI
                                 |                       (idle anim, alerts, games)
                                 USB-serial
                                 |
                                 v
                          ESP32 motor controller  ─►  2× stepper drivers ─► motors
                                                  ◄─  2× drop sensors
```

The kiosk can pull live tips from StreamElements two ways:

- **OAuth + Astro WebSocket (recommended)** — outbound-only, no
  public surface. Set up via the QR pairing flow on the Settings
  page; requires deploying the [tiny relay](../oauth-relay/) once.
- **Classic webhooks** — set the SE webhook secret in `.env`,
  point SE/Ko-fi at `/hooks/streamelements` / `/hooks/kofi`. Works
  if you have a Tailscale Funnel or similar already.

The Pi never generates step pulses. It sends high-level commands like
`DISPENSE 1 +1 1200 3000` to the ESP32, which handles the timing-critical
step generation and the drop-sensor edge detection. See
`../esp32-motor/README.md` for the wire protocol.

## Local development (Linux / macOS / Windows)

```bash
cd pi-app
npm install
cp .env.example .env
# Optional: edit .env

npm run dev      # starts on http://localhost:3000
```

Open `http://localhost:3000/` for the kiosk view,
`http://localhost:3000/settings` for the dashboard,
`http://localhost:3000/games` for the games launcher.

You can drive the donation flow without a real webhook via:

```bash
curl -X POST http://localhost:3000/hooks/test \
  -H 'content-type: application/json' \
  -d '{"name":"TestUser","amount":5,"message":"hi"}'
```

The Settings page has buttons for the same thing plus manual dispense.

If no ESP32 is connected, motor commands log a warning and are dropped —
the rest of the UI still works.

## Deployment on the Pi

```bash
# On the Pi (fresh Raspberry Pi OS Lite 64-bit install)
git clone <this repo>
cd <repo>/pi-app
sudo bash scripts/install.sh

sudo systemctl set-default graphical.target
sudo reboot
```

The installer:

- installs Node 20, Chromium, cage, ffmpeg, git, build tools;
- installs **comitup** for captive-portal Wi-Fi provisioning;
- creates a `minivend` system user with USB-serial + video access;
- clones the repo to `/opt/minivend/repo` and symlinks `/opt/minivend/pi-app`
  (a real git checkout — required for OTA);
- moves the assets folder to `/var/lib/minivend/assets` so OTA `git reset`
  cannot wipe uploaded animations;
- installs a sudoers drop-in granting the service user just the privileged
  commands the app needs (OTA, Wi-Fi forget, service restart);
- drops a udev rule that exposes the ESP32 as `/dev/minivend-motor`;
- installs and enables `minivend-server.service`, `minivend-kiosk.service`,
  and the `minivend-updater.timer` (daily update check).

After reboot the Pi boots into a fullscreen kiosk showing the idle animation
or, on first boot with no Wi-Fi configured, the captive-portal setup AP.

## First-boot Wi-Fi (captive portal)

On every boot, if the Pi can't connect to a known network within a few
seconds, **comitup** brings up its own Wi-Fi access point named
`MiniVend-Setup-<digits>` (configurable in `/etc/comitup.conf`).

Customer flow:

1. Plug device in. Screen shows the idle UI talking to `localhost`; the
   bottom of the screen indicates Wi-Fi status.
2. Customer joins the `MiniVend-Setup-...` Wi-Fi from their phone.
3. The phone's "captive portal" notification opens automatically. They
   see a list of nearby Wi-Fi networks; tap their home network, type the
   password, hit Connect.
4. Device drops the AP, joins the real Wi-Fi, comes back online.

To re-provision later (e.g. moving the device to a new venue), tap
**Settings → Wi-Fi → Forget Wi-Fi**. The device drops the current network
and re-launches the captive portal.

## OTA updates (free, git-based, atomic with rollback)

Updates are pulled from the same git repository the device was installed
from. No external server, no fleet management service, no recurring cost
beyond your existing git host.

How a successful update happens:

```
UI [Apply update]
    -> POST /api/update/apply
        -> sudo /opt/minivend/pi-app/scripts/update.sh
            -> snapshot current commit  ->  .last-good-commit
            -> git fetch + git reset --hard origin/<branch>
            -> npm install --omit=dev
            -> systemctl restart minivend-server.service
            -> curl /api/state in a loop (60s)
            -> success: write .update-state.json {status:"ok",...}
```

If the new revision fails its health check, the script automatically
rolls back to the previous commit, re-runs `npm install`, restarts, and
records `{status:"rolled_back"}`.

The Chromium kiosk is unaffected by app-server restarts — Chromium just
reconnects to `localhost` once the server comes back up.

### Scheduled checks

`minivend-updater.timer` runs once a day. By default it only does
`git fetch` so the UI badge will show "update available". To switch to
fully unattended updates, set `AUTO_APPLY_UPDATES=true` in `.env`.

### Pinning to a specific channel

Shipping a "stable" branch and a "beta" branch is just `git checkout`
on the device. The updater follows whatever branch is currently checked
out, so you can move customers between channels by SSH'ing in once and
checking out a different branch.

### Why this is enough

This isn't Mender-grade A/B partition swapping — a corrupted filesystem
or a borked kernel update still needs an SD swap to recover. But for
the app layer (Node code, UI, games, donation handlers) it gives you
atomic-with-rollback for $0 and zero extra infrastructure.

When/if your fleet grows past a hundred devices and you want partition-
level rollback, drop in Mender on top of Pi OS Lite — none of the rest
of the architecture has to change.

## Layout

```
pi-app/
├── server/
│   ├── index.js          HTTP + WS + wiring
│   ├── config.js         .env reader
│   ├── motor.js          USB-serial bridge to ESP32 (auto-reconnect)
│   ├── donations.js      SE + Ko-fi + test webhooks
│   ├── assets.js         Idle / alert asset upload + active selection
│   ├── wifi.js           Wi-Fi status + comitup "forget" hook
│   └── updater.js        Git-based OTA + health check + rollback
├── ui/                   Static files served by Express
│   ├── index.html        Kiosk idle screen + alert overlay
│   ├── settings.html     Dashboard (uploads, dispense, tips, Wi-Fi, OTA)
│   ├── games/            Launcher (index.html) + self-contained games
│   │                     (snake, 2048, tetris, simon)
│   ├── js/{ws-client,alerts,press-guard,swipe-nav}.js
│   └── css/styles.css
├── systemd/
│   ├── minivend-server.service
│   ├── minivend-kiosk.service       cage + Chromium kiosk
│   ├── minivend-updater.service     one-shot OTA check
│   └── minivend-updater.timer       once-a-day schedule
├── scripts/
│   ├── install.sh                   Idempotent installer
│   ├── update.sh                    OTA worker (atomic + rollback)
│   └── sudoers-minivend             /etc/sudoers.d/minivend drop-in
├── .env.example
└── package.json
```

Persistent state lives outside the git checkout so OTA doesn't touch it:

| Path                              | Owner       | Purpose                          |
|-----------------------------------|-------------|----------------------------------|
| `/opt/minivend/repo`              | git checkout, replaced by OTA | the code |
| `/opt/minivend/pi-app`            | symlink     | -> `/opt/minivend/repo/pi-app`   |
| `/var/lib/minivend/assets/`       | persistent  | uploaded idle/alert media        |
| `/opt/minivend/pi-app/.env`       | persistent  | secrets (gitignored)             |
| `/opt/minivend/pi-app/.last-good-commit` | persistent | rollback target           |
| `/opt/minivend/pi-app/.update-state.json` | persistent | last OTA outcome         |

## Endpoints

| Method | Path                              | Purpose                                    |
|--------|-----------------------------------|--------------------------------------------|
| GET    | `/`                               | Kiosk idle screen                          |
| GET    | `/settings`                       | Settings / dashboard                       |
| GET    | `/games`                          | Game launcher                              |
| GET    | `/games/<name>/`                  | Static game (Snake, 2048, ...)             |
| GET    | `/api/state`                      | Bootstrap state for the UI                 |
| POST   | `/api/dispense`                   | `{motor, dir?, speed?, max_ms?}` manual    |
| GET    | `/api/assets/idle`                | List idle animations + current active      |
| POST   | `/api/assets/idle`                | Upload new idle animation (multipart)      |
| POST   | `/api/assets/idle/active`         | `{name}` set active                        |
| DELETE | `/api/assets/idle/:name`          | Remove file                                |
| GET    | `/api/assets/idle/active`         | 302s to the active file                    |
| GET    | `/api/games`                      | List installed games                       |
| GET    | `/api/wifi`                       | Wi-Fi status (ssid, ip, setup mode)        |
| POST   | `/api/wifi/forget`                | Drop current network, re-launch captive AP |
| GET    | `/api/version`                    | Current commit / branch / last OTA result  |
| GET    | `/api/update/check`               | Run a `git fetch`, report if newer commit  |
| POST   | `/api/update/apply`               | Apply update with health-check + rollback  |
| POST   | `/hooks/streamelements`           | SE webhook receiver (HMAC verified)        |
| POST   | `/hooks/kofi`                     | Ko-fi webhook receiver (token verified)    |
| POST   | `/hooks/test`                     | Inject a synthetic donation                |
| WS     | `/ws`                             | Live events to UI clients                  |

## Adding a new donation source

`server/donations.js` is the only place new providers go. Pattern:

```js
app.post('/hooks/myprovider', express.json(), (req, res) => {
  if (!verifyMyProvider(req)) return res.status(401).json({ ok: false });
  const evt = normalizeMyProvider(req.body);
  if (evt.amount > 0) onDonation(evt);
  res.json({ ok: true });
});
```

`onDonation` is the same handler the SE/Ko-fi receivers use — it broadcasts
to the UI and triggers a dispense. No other code needs to change.

## Adding a new game

Drop a folder under `ui/games/<name>/` with an `index.html` and the
launcher will pick it up on next refresh. The games are loaded
in-place inside Chromium, so they have access to the same WebSocket
event stream (`/js/ws-client.js`) if you want them to react to
donations.

## What the ESP32 needs

Flash `../esp32-motor/` once (see its README). The Pi auto-detects the
USB-serial adapter; the udev rule symlinks it to `/dev/minivend-motor`
so the device path is stable across reboots and unplug cycles.
