#!/usr/bin/env bash
# MiniVend Pi installer.
#
# Run on a fresh Raspberry Pi OS Lite (64-bit) install:
#   sudo bash pi-app/scripts/install.sh
#
# Or, from a fresh Pi with just the script:
#   REPO_URL=https://github.com/azrealgaming503-gif/minivend.git \
#     sudo -E bash install.sh
#
# What it does:
#   1. Installs Node.js 20, Chromium, cage, comitup (captive-portal Wi-Fi
#      provisioning), ffmpeg, git, build tools.
#   2. Creates the `minivend` user with USB-serial + video access.
#   3. Clones (or updates) the repo into /opt/minivend/repo so that OTA
#      updates have a real git checkout to pull from. Symlinks
#      /opt/minivend/pi-app -> /opt/minivend/repo/pi-app.
#   4. Runs npm install.
#   5. Drops in udev rule, sudoers drop-in, systemd units, OTA timer.
#   6. Enables services. You then `set-default graphical.target` and reboot.
#
# Idempotent: safe to re-run after pulling new code locally.

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "This script must be run as root (sudo)."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LOCAL_PI_APP="$(cd "${SCRIPT_DIR}/.." && pwd)"

INSTALL_ROOT=/opt/minivend
REPO_DIR="${INSTALL_ROOT}/repo"
PI_APP_DIR="${INSTALL_ROOT}/pi-app"
SERVICE_USER=minivend

# ---------- 1. Determine the remote git URL for OTA ----------
# Priority: $REPO_URL env -> local checkout's origin -> local checkout path.
LOCAL_REPO_ROOT=""
if git -C "${LOCAL_PI_APP}" rev-parse --show-toplevel >/dev/null 2>&1; then
  LOCAL_REPO_ROOT="$(git -C "${LOCAL_PI_APP}" rev-parse --show-toplevel)"
fi

if [ -z "${REPO_URL:-}" ] && [ -n "${LOCAL_REPO_ROOT}" ]; then
  REPO_URL="$(git -C "${LOCAL_REPO_ROOT}" remote get-url origin 2>/dev/null || true)"
fi
if [ -z "${REPO_URL:-}" ] && [ -n "${LOCAL_REPO_ROOT}" ]; then
  # No remote configured — clone from the local working copy. OTA won't
  # be useful until you push to a remote and update the origin.
  echo "WARN: no REPO_URL or git remote detected; cloning from local path"
  echo "      (OTA updates will not work until you set an origin)."
  REPO_URL="${LOCAL_REPO_ROOT}"
fi
if [ -z "${REPO_URL:-}" ]; then
  echo "ERROR: cannot determine the git repo to install from."
  echo "Run with REPO_URL=... or run from inside a checkout of the MiniVend repo."
  exit 1
fi

REPO_BRANCH="${REPO_BRANCH:-main}"
echo "==> Using REPO_URL=${REPO_URL} branch=${REPO_BRANCH}"

# ---------- 2. apt packages ----------
echo "==> Installing apt packages"
apt update
# Pi OS Bookworm ships `chromium-browser`; Trixie renamed it to plain `chromium`.
# Try the new name first, fall back to the old one. Same logic in the kiosk
# systemd unit picks whichever ends up installed.
if apt-cache show chromium >/dev/null 2>&1; then
  CHROMIUM_PKG=chromium
else
  CHROMIUM_PKG=chromium-browser
fi
apt install -y \
  ca-certificates curl gnupg git rsync \
  ${CHROMIUM_PKG} cage \
  libnss3 libatk-bridge2.0-0 libgtk-3-0 \
  ffmpeg \
  build-essential \
  network-manager wireless-tools

if ! command -v node >/dev/null || [ "$(node -v | sed 's/v\([0-9]*\).*/\1/')" -lt 20 ]; then
  echo "==> Installing Node.js 20 via NodeSource"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi

# ---------- 3. Comitup (captive-portal Wi-Fi provisioning) ----------
# Comitup is optional. If anything in this block fails, log a warning and
# continue — the rest of the kiosk/server install still works, and Wi-Fi
# can be managed via raspi-config / nmcli instead.
COMITUP_OK=0
install_comitup() {
  if command -v comitup-cli >/dev/null; then
    COMITUP_OK=1
    return 0
  fi
  echo "==> Installing comitup (captive-portal Wi-Fi setup)"
  curl -fsSL https://davesteele.github.io/comitup/deb/davesteele-comitup-apt-source_1.2_all.deb \
    -o /tmp/davesteele-comitup-apt-source.deb || return 1
  dpkg -i /tmp/davesteele-comitup-apt-source.deb || true

  # Trixie (Debian 13) rejects the legacy /etc/apt/trusted.gpg.d/ key the
  # davesteele .deb drops in. Import the key into the new keyring location
  # and pin the sources.list entry to it explicitly.
  install -d -m 0755 /etc/apt/keyrings
  local key_fp="4E1609F5CDFE5F2036961B66B5E293D64E192FDE"
  local keyring="/etc/apt/keyrings/davesteele-comitup.gpg"
  if ! gpg --no-default-keyring --keyring "${keyring}" \
        --keyserver hkps://keyserver.ubuntu.com \
        --recv-keys "${key_fp}" >/dev/null 2>&1; then
    # Fall back to a second keyserver in case the first is flaky.
    gpg --no-default-keyring --keyring "${keyring}" \
        --keyserver hkps://keys.openpgp.org \
        --recv-keys "${key_fp}" >/dev/null 2>&1 || return 1
  fi
  chmod 0644 "${keyring}"
  echo "deb [signed-by=${keyring}] http://davesteele.github.io/comitup/repo comitup main" \
    > /etc/apt/sources.list.d/davesteele-comitup.list

  apt update || return 1
  apt install -y comitup || return 1

  # Disable conflicting auto-WiFi-managers so comitup is in charge.
  systemctl disable --now wpa_supplicant.service 2>/dev/null || true
  systemctl disable --now dhcpcd.service          2>/dev/null || true
  systemctl enable  --now NetworkManager.service  2>/dev/null || true

  cat >/etc/comitup.conf <<'EOF'
# MiniVend captive-portal config (see /etc/comitup.conf.example for full ref)
ap_name: MiniVend-Setup-<nnn>
ap_password:
web_service: comitup-web
verbose: 0
enable_appliance_mode: 1
EOF
  systemctl enable --now comitup.service        2>/dev/null || true
  systemctl enable --now comitup-web.service    2>/dev/null || true
  COMITUP_OK=1
  return 0
}

if install_comitup; then
  echo "    comitup installed."
else
  echo "WARN: comitup install failed — captive-portal Wi-Fi provisioning"
  echo "      will be unavailable. The kiosk + server will still install."
  echo "      Manage Wi-Fi with: sudo nmcli device wifi connect <SSID> password <PW>"
  echo "      Or rerun this installer later to retry comitup."
fi

# ---------- 4. Service user ----------
echo "==> Creating ${SERVICE_USER} user (if missing)"
if ! id "$SERVICE_USER" >/dev/null 2>&1; then
  useradd -r -m -d /home/${SERVICE_USER} -s /bin/bash "$SERVICE_USER"
fi
usermod -aG dialout,video,input,render "$SERVICE_USER"

# ---------- 5. Clone / update repo ----------
mkdir -p "${INSTALL_ROOT}"
if [ -d "${REPO_DIR}/.git" ]; then
  echo "==> Updating existing checkout at ${REPO_DIR}"
  git -C "${REPO_DIR}" remote set-url origin "${REPO_URL}"
  git -C "${REPO_DIR}" fetch --quiet origin
  git -C "${REPO_DIR}" checkout -q "${REPO_BRANCH}" || true
  git -C "${REPO_DIR}" reset --hard "origin/${REPO_BRANCH}"
else
  echo "==> Cloning ${REPO_URL} -> ${REPO_DIR}"
  git clone --branch "${REPO_BRANCH}" "${REPO_URL}" "${REPO_DIR}"
fi
# Permissions: minivend owns the checkout (the updater runs npm install as that user).
chown -R ${SERVICE_USER}:${SERVICE_USER} "${REPO_DIR}"
# But the OTA script runs as root via sudoers, and git's "dubious ownership"
# safeguard would block it otherwise. Mark the dir as safe globally.
git config --system --add safe.directory "${REPO_DIR}"

# Symlink convenience paths.
ln -sfn "${REPO_DIR}/pi-app" "${PI_APP_DIR}"

# Persistent state lives outside the checkout so a `git reset --hard`
# during OTA doesn't wipe uploaded animations.
mkdir -p /var/lib/minivend/assets/idle /var/lib/minivend/assets/alerts
chown -R ${SERVICE_USER}:${SERVICE_USER} /var/lib/minivend

# Bootstrap .env (only if absent — never overwrite an existing one).
if [ ! -f "${PI_APP_DIR}/.env" ]; then
  cp "${PI_APP_DIR}/.env.example" "${PI_APP_DIR}/.env"
  # Repoint asset dir at /var/lib/minivend so OTA can't blow it away.
  sed -i 's|^ASSETS_DIR=.*$|ASSETS_DIR=/var/lib/minivend/assets|' "${PI_APP_DIR}/.env"
  chown ${SERVICE_USER}:${SERVICE_USER} "${PI_APP_DIR}/.env"
  echo "    Wrote default .env — edit it before relying on webhooks."
fi

echo "==> npm install"
sudo -u "$SERVICE_USER" -H bash -c "cd ${PI_APP_DIR} && npm install --omit=dev --no-audit --no-fund"

# ---------- 6. udev rule for the ESP32 ----------
echo "==> Installing udev rule for the ESP32 motor controller"
cat >/etc/udev/rules.d/99-minivend.rules <<'EOF'
# Common CP210x / CH340 / FTDI USB-serial bridges seen on ESP32 dev boards.
SUBSYSTEMS=="usb", ATTRS{idVendor}=="10c4", ATTRS{idProduct}=="ea60", \
  SYMLINK+="minivend-motor", GROUP="dialout", MODE="0660"
SUBSYSTEMS=="usb", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="7523", \
  SYMLINK+="minivend-motor", GROUP="dialout", MODE="0660"
SUBSYSTEMS=="usb", ATTRS{idVendor}=="1a86", ATTRS{idProduct}=="55d4", \
  SYMLINK+="minivend-motor", GROUP="dialout", MODE="0660"
SUBSYSTEMS=="usb", ATTRS{idVendor}=="0403", ATTRS{idProduct}=="6001", \
  SYMLINK+="minivend-motor", GROUP="dialout", MODE="0660"
EOF
udevadm control --reload-rules
udevadm trigger

# ---------- 7. sudoers drop-in ----------
echo "==> Installing sudoers drop-in for OTA + Wi-Fi management"
install -m 0440 "${PI_APP_DIR}/scripts/sudoers-minivend" /etc/sudoers.d/minivend
visudo -c -f /etc/sudoers.d/minivend

# ---------- 8. systemd units + OTA timer ----------
echo "==> Installing systemd units"
install -m 0644 "${PI_APP_DIR}/systemd/minivend-server.service"  /etc/systemd/system/
install -m 0644 "${PI_APP_DIR}/systemd/minivend-kiosk.service"   /etc/systemd/system/
install -m 0644 "${PI_APP_DIR}/systemd/minivend-updater.service" /etc/systemd/system/
install -m 0644 "${PI_APP_DIR}/systemd/minivend-updater.timer"   /etc/systemd/system/
chmod +x "${PI_APP_DIR}/scripts/update.sh"

systemctl daemon-reload
systemctl enable minivend-server.service
systemctl enable minivend-kiosk.service
systemctl enable minivend-updater.timer

cat <<EOF

==> Install complete.

Next steps:
  1. (Optional) Edit ${PI_APP_DIR}/.env with your StreamElements /
     Ko-fi webhook secrets and dispense defaults.
  2. Boot to graphical:
        sudo systemctl set-default graphical.target
  3. (Recommended) Enable read-only rootfs:
        sudo raspi-config nonint do_overlayfs 0
  4. Reboot:
        sudo reboot

First-boot Wi-Fi:
  - If the device has no saved Wi-Fi, comitup brings up an access
    point named "MiniVend-Setup-<nnn>". Connect a phone to it; the
    captive portal opens automatically. Pick your Wi-Fi, enter the
    password, the device reboots into that network.

Logs:
  journalctl -u minivend-server -f
  journalctl -u minivend-kiosk -f
  journalctl -u minivend-updater -f

The ESP32 motor controller will appear as /dev/minivend-motor once
plugged in.
EOF
