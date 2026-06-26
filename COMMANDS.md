# MiniVend — Command Cheat Sheet

Quick reference for the commands you'll use on this project, grouped by **where** you run them.

- **PC (Cursor terminal *or* PowerShell)** — same machine, same shell. Used for git + flashing the ESP32.
- **Pi (via Pi Connect)** — the Raspberry Pi that runs the kiosk. Used for deploying and operating the machine.

> PowerShell notes: it does **not** support bash `&&` chaining or `<<EOF` heredocs. Put each command on its own line, or chain with `;`.

---

## 0. The full "ship a change" workflow

1. **PC:** `git add <files>` → `git commit -m "..."` → `git push origin main`
2. **Pi:** `sudo bash /opt/minivend/pi-app/scripts/update.sh`
3. **Pi:** `sudo systemctl restart minivend-kiosk`  *(reloads the on-screen page so new UI/JS takes effect)*
4. **Pi:** `curl -s localhost:3000/api/version`  *(confirm the new commit is live)*

> Firmware (`esp32-motor/`) changes do **not** ship via `update.sh` — they must be flashed to the ESP32 (Section 2).

---

## 1. PC — Git (Cursor terminal or PowerShell)

Run these from the **repo root**: `C:\Users\Azreal503\Desktop\Coding projects\Mini vending machine`

| Command | What it does |
|---|---|
| `cd "C:\Users\Azreal503\Desktop\Coding projects\Mini vending machine"` | Move to the repo root (where git lives). |
| `git status` | Show what files changed / are staged. |
| `git diff` | View unstaged changes. |
| `git add pi-app/ui/js/alerts.js` | Stage one specific file. |
| `git add -A` | Stage *all* changes. |
| `git commit -m "message"` | Commit staged changes with a message. |
| `git push origin main` | Push commits to GitHub. |
| `git log --oneline -10` | Show the last 10 commits. |
| `git restore <path>` | Discard local edits to a file (undo). |
| `git pull` | Pull latest from GitHub into your PC copy. |

> Paths are relative to the repo root, e.g. `pi-app/...` and `esp32-motor/...`. If you're inside `pi-app`, drop the `pi-app/` prefix.

---

## 2. PC — Flash the ESP32 firmware (PowerShell + PlatformIO)

Run from the firmware folder, with the ESP32 plugged into the PC by USB.

| Command | What it does |
|---|---|
| `cd "C:\Users\Azreal503\Desktop\Coding projects\Mini vending machine\esp32-motor"` | Move to the firmware project. |
| `pio run -e esp32dev` | Compile the firmware (verify it builds). |
| `pio run -e esp32dev --target upload` | Compile **and flash** to the connected ESP32. |
| `pio device monitor` | Open the serial monitor to watch firmware output. |
| `pio run --target clean` | Delete build artifacts (force a clean rebuild). |

> Close anything else using the COM port first. If the ESP32 is wired to the **Pi** instead of the PC, see Section 3's "Flashing from the Pi" note.

---

## 3. Pi — via Pi Connect (deploy & operate)

### Deploy / version
| Command | What it does |
|---|---|
| `sudo bash /opt/minivend/pi-app/scripts/update.sh` | Pull latest from GitHub, install deps, restart server, health-check + auto-rollback. |
| `curl -s localhost:3000/api/version` | Show the commit the kiosk is currently running. |

### Services
| Command | What it does |
|---|---|
| `sudo systemctl restart minivend-server` | Restart the app server (reloads **server** code). |
| `sudo systemctl restart minivend-kiosk` | Restart the Chromium kiosk (reloads the **on-screen page/JS**). |
| `sudo systemctl status minivend-server --no-pager` | Check whether the server is healthy. |
| `sudo systemctl stop minivend-server` | Stop the server (e.g. to free the ESP32 serial port). |
| `sudo systemctl start minivend-server` | Start the server again. |
| `sudo reboot` | Full reboot (also replays the boot splash). |

### Logs / testing
| Command | What it does |
|---|---|
| `journalctl -u minivend-server -f` | Live-tail the server log (watch donations + motor events). |
| `journalctl -u minivend-server -n 100 --no-pager` | Show the last 100 log lines. |
| `curl -X POST localhost:3000/hooks/test -H 'content-type: application/json' -d '{"name":"Test","amount":5}'` | Fire a fake $5 donation to test the alert overlay + dispense. |

### Maintenance / fixes
| Command | What it does |
|---|---|
| `sudo chown -R minivend:minivend /opt/minivend/repo` | Fix file ownership so OTA `npm install` doesn't hit permission errors. |
| `ls -la /opt/minivend/` | Inspect the install dir and the `pi-app` symlink. |
| `systemctl cat minivend-server` | Show the server service file (paths, user). |

### Flashing the ESP32 *from the Pi* (only if it's wired to the Pi)
| Command | What it does |
|---|---|
| `sudo systemctl stop minivend-server` | Free the USB-serial port the server holds open. |
| `pio run -e esp32dev --target upload` | Flash the firmware (requires PlatformIO installed on the Pi). |
| `sudo systemctl start minivend-server` | Restart the server after flashing. |
