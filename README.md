# Mini Vending Machine

A two-compartment desktop vending machine driven by a touchscreen UI, two
stepper motors, and a donation pipeline — designed to live on a streamer's
desk, dispense an item when a viewer tips, and require **no host PC**.

## Architecture

```
StreamElements / Ko-fi webhooks
            |
            v
   Raspberry Pi 5 (Pi OS Lite + Chromium kiosk)
            |  USB-serial
            v
   ESP32 motor controller  ─►  2× TMC2208 ─► 2× steppers
                           ◄─  2× drop sensors
```

Two pieces, one wire protocol:

1. **`pi-app/`** — Node.js server + static HTML/CSS/JS UI. Receives
   donation webhooks, hosts the idle animation, runs the dashboard,
   serves the games (Snake, 2048, ...), and sends high-level motor
   commands to the ESP32 over USB-serial.
2. **`esp32-motor/`** — Tiny Arduino firmware whose only job is
   real-time step pulse generation, drop-sensor edge detection, and an
   ASCII line protocol over USB-serial. See its README for the protocol.

## Quick start

### 1. Flash the ESP32 motor controller (one-time)

```bash
# Requires PlatformIO (VS Code extension or `pip install platformio`)
cd esp32-motor
pio run -t upload
```

### 2. Provision the Pi

Flash Raspberry Pi OS Lite 64-bit with Raspberry Pi Imager (set Wi-Fi,
SSH, and your username up front). Then on the Pi:

```bash
git clone <this repo>
cd <repo>/pi-app
sudo bash scripts/install.sh
sudo systemctl set-default graphical.target
sudo reboot
```

The kiosk comes up on the HDMI display, automatically running the donation
pipeline and serving its own settings page at `http://<pi>:3000/settings`.

### 3. (Optional) Wire StreamElements webhooks

In your SE dashboard, add a webhook pointing at
`https://your-server/hooks/streamelements` (or `http://<pi-ip>:3000/...`
for LAN-only). Paste the secret SE gives you into `/opt/minivend/pi-app/.env`
as `SE_WEBHOOK_SECRET=...`. Tips will show on the screen and trigger a
dispense.

For a Ko-fi alternative: point the Ko-fi webhook at `/hooks/kofi` and set
`KOFI_VERIFICATION_TOKEN` in `.env`.

You can drive the whole flow with no provider configured by hitting
`POST /hooks/test` from the dashboard.

## Documentation

| File                       | What it covers                                    |
|----------------------------|---------------------------------------------------|
| `pi-app/README.md`         | Pi server, UI, endpoints, deployment, OTA, Wi-Fi  |
| `esp32-motor/README.md`    | ESP32 motor/sensor firmware + USB-serial protocol |

## License

MIT.
