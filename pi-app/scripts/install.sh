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
# Scrub any leftover broken davesteele/comitup sources from a previous
# partial install. On Trixie the .deb shipped a key in the legacy location
# that apt no longer trusts, and the resulting "InRelease is not signed"
# error breaks every subsequent `apt update` system-wide. install_comitup()
# below will recreate the source list with a correctly-pinned keyring.
rm -f /etc/apt/sources.list.d/davesteele-comitup.list \
      /etc/apt/sources.list.d/davesteele-comitup.sources \
      /etc/apt/trusted.gpg.d/davesteele-comitup-keyring.gpg \
      /etc/apt/trusted.gpg.d/davesteele-comitup.gpg 2>/dev/null || true

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
  ${CHROMIUM_PKG} cage wlr-randr \
  libnss3 libatk-bridge2.0-0 libgtk-3-0 \
  ffmpeg \
  build-essential \
  network-manager wireless-tools \
  fonts-noto-color-emoji \
  avahi-daemon

# mDNS: lets phones/laptops reach the kiosk at "<hostname>.local" (e.g.
# minivend.local) without knowing its IP — used by the "Access from your
# phone" panel. Enable now and on boot; harmless if already running.
systemctl enable --now avahi-daemon.service 2>/dev/null || true

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
# plugdev: read automounted USB sticks under /media/<user>/…
usermod -aG dialout,video,input,render,plugdev "$SERVICE_USER"

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

# Touchscreen rotation. Reads $KIOSK_ROTATE from /etc/systemd/system/
# minivend-kiosk.service.d/override.conf so it always matches the display.
echo "==> Installing touchscreen rotation udev rule"
rotate_value="$( \
  awk -F= '/^[[:space:]]*Environment=KIOSK_ROTATE=/ {gsub(/"|[[:space:]]/, "", $3); print $3}' \
    /etc/systemd/system/minivend-kiosk.service.d/override.conf 2>/dev/null \
    | tail -n1)"
case "${rotate_value:-normal}" in
  90)     ts_matrix="0 -1 1 1 0 0" ;;
  180)    ts_matrix="-1 0 1 0 -1 1" ;;
  270)    ts_matrix="0 1 0 -1 0 1" ;;
  normal|*) ts_matrix="1 0 0 0 1 0" ;;
esac
echo "    using touch matrix '${ts_matrix}' for rotation '${rotate_value:-normal}'"
sed "s|__MATRIX__|${ts_matrix}|" "${PI_APP_DIR}/systemd/99-minivend-touchscreen.rules" \
  > /etc/udev/rules.d/99-minivend-touchscreen.rules

# Backlight brightness: kernel exposes /sys/class/backlight/*/brightness
# as root-only by default. Give the `video` group write access so the
# minivend service (which is already in `video`) can adjust brightness
# from the settings UI. Harmless on panels with no backlight node.
echo "==> Installing backlight permissions udev rule"
cat >/etc/udev/rules.d/99-minivend-backlight.rules <<'EOF'
# Allow the `video` group (which the minivend service user is in) to
# adjust the panel backlight. Applies to every backlight device the
# kernel exposes; ignored if there isn't one.
SUBSYSTEM=="backlight", ACTION=="add|change", \
  RUN+="/bin/chgrp video /sys/class/backlight/%k/brightness", \
  RUN+="/bin/chmod 0664 /sys/class/backlight/%k/brightness"
EOF

udevadm control --reload-rules
udevadm trigger

# ---------- 6b. Blank cursor theme (touchscreen kiosk) ----------
# Cage / wlroots draws its own mouse cursor as soon as anything emits a
# pointer event (touchscreens often produce pointer-emulated events even
# though we want pure touch). The minimal cage CLI has no `--hide-cursor`
# flag, so the standard fix is to ship a cursor theme whose only cursor
# is a 1x1 fully-transparent image and point XCURSOR_THEME at it.
echo "==> Installing blank cursor theme (XCURSOR_THEME=blank) for kiosk"
install -d -m 0755 /usr/share/icons/blank/cursors
# IMPORTANT: do NOT include an `Inherits=` line. Some xcursor loaders
# treat "self-inheriting" themes as invalid and fall back to the system
# default theme (which has a real cursor). Omitting Inherits means "this
# theme is standalone; do not fall back".
cat >/usr/share/icons/blank/index.theme <<'EOF'
[Icon Theme]
Name=blank
Comment=Fully-transparent cursor theme — used by the MiniVend kiosk to
 hide the compositor cursor on touchscreen-only hardware.
EOF
cat >/usr/share/icons/blank/cursor.theme <<'EOF'
[Icon Theme]
Name=blank
EOF
# Write the actual Xcursor file. We ship a 32x32 fully transparent image
# (rather than 1x1) because some wlroots/DRM hardware-cursor paths reject
# undersized cursors and fall back to a built-in default. Format ref:
#   https://man.archlinux.org/man/Xcursor.3.en
python3 - <<'PYEOF'
import struct
TYPE_IMAGE = 0xfffd0002
SIZE = 32
buf = bytearray()
buf += b'Xcur'
buf += struct.pack('<III', 16, 0x10000, 1)             # hdr_size, version, ntoc
buf += struct.pack('<III', TYPE_IMAGE, SIZE, 28)       # toc: type, subtype=nominal, pos
buf += struct.pack('<IIIIIIIII',                        # image chunk header (36 bytes)
    36, TYPE_IMAGE, SIZE, 1,                            #   hdr_size, type, subtype, ver
    SIZE, SIZE, 0, 0, 0)                                #   w, h, xhot, yhot, delay
buf += b'\x00\x00\x00\x00' * (SIZE * SIZE)              # SIZE*SIZE transparent ARGB px
open('/usr/share/icons/blank/cursors/left_ptr', 'wb').write(bytes(buf))
PYEOF
chmod 0644 /usr/share/icons/blank/cursors/left_ptr
# Make every other common cursor name resolve to the blank one too —
# wlroots reads names like "default", "pointer", "watch", "text", grab,
# etc. We cover the full freedesktop cursor-spec name set so any
# fallback request also resolves to blank.
for alias in default pointer arrow text watch hand1 hand2 crosshair \
             xterm wait progress help question_arrow \
             size_all size_ver size_hor size_fdiag size_bdiag \
             sb_h_double_arrow sb_v_double_arrow \
             top_left_corner top_right_corner \
             bottom_left_corner bottom_right_corner \
             left_side right_side top_side bottom_side \
             grab grabbing closedhand openhand pointing_hand \
             move copy alias dnd-move dnd-copy dnd-no-drop \
             no-drop not-allowed forbidden \
             ibeam cell row-resize col-resize \
             ew-resize ns-resize nesw-resize nwse-resize all-scroll \
             zoom-in zoom-out fleur plus circle dotbox draft \
             X_cursor center_ptr right_ptr ul_angle ur_angle \
             ll_angle lr_angle; do
  ln -sf left_ptr "/usr/share/icons/blank/cursors/${alias}"
done

# Override the system DEFAULT cursor theme so anything that falls back
# to "default" (rather than our explicit XCURSOR_THEME=blank) also gets
# the blank cursors. wlroots' default cursor manager will pick up our
# inherits chain and resolve every cursor name through the blank theme.
install -d -m 0755 /usr/share/icons/default
# Preserve the original default theme metadata so we can restore it if
# someone later installs a real desktop environment on this Pi.
if [ -f /usr/share/icons/default/index.theme ] && \
   ! grep -q "^Inherits=blank" /usr/share/icons/default/index.theme && \
   [ ! -f /usr/share/icons/default/index.theme.minivend-backup ]; then
  cp -a /usr/share/icons/default/index.theme \
        /usr/share/icons/default/index.theme.minivend-backup
fi
cat >/usr/share/icons/default/index.theme <<'EOF'
[Icon Theme]
Name=Default
Comment=Inherits the MiniVend blank cursor theme so touchscreen kiosks
 don't flash a system cursor when the pointer is woken by a touch event.
Inherits=blank
EOF

# Some wlroots / cage builds ignore $XCURSOR_THEME for at least one
# code path and fall back to whatever cursor theme GTK has installed
# (usually Adwaita on Debian-derived systems). To bulletproof this,
# we replace every cursor in every other installed cursor theme with
# a symlink to our blank cursor. Backups are kept alongside (.bak dir)
# so an OS desktop install can be restored later if ever needed.
echo "==> Pointing other cursor themes at blank (backups kept as .minivend-backup)"
for theme_dir in /usr/share/icons/*/cursors; do
  [ -d "$theme_dir" ] || continue
  # Skip our own blank theme
  case "$theme_dir" in *blank/cursors) continue ;; esac
  backup_dir="${theme_dir}.minivend-backup"
  if [ ! -d "$backup_dir" ]; then
    cp -a "$theme_dir" "$backup_dir"
  fi
  for f in "$theme_dir"/*; do
    [ -e "$f" ] || continue
    if [ -L "$f" ] && readlink "$f" | grep -q "blank/cursors"; then
      continue
    fi
    rm -f "$f"
    ln -s /usr/share/icons/blank/cursors/left_ptr "$f"
  done
done

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

# ---------- 8a. Fonts ----------
# Caches Indie Flower (Google Font) locally so the kiosk works
# without internet. Failures are non-fatal — the @font-face rule
# falls back to the Google CDN at runtime.
echo "==> Caching kiosk fonts"
bash "${PI_APP_DIR}/scripts/install-fonts.sh" || \
  echo "WARN: font cache step failed; continuing"

# ---------- 8b. Boot splash ----------
# Hides the rainbow / kernel log / login prompt between firmware and
# the cage compositor with a branded "Blu" plymouth theme. Self-
# contained installer; failures here are non-fatal (the kiosk still
# works, you just get a more noisy boot).
echo "==> Installing boot splash"
if bash "${PI_APP_DIR}/scripts/install-splash.sh"; then
  echo "    splash installed."
else
  echo "WARN: boot splash install failed; continuing without it."
fi

# Free up tty1 so the kiosk service can grab the active VT (HDMI default).
# Without this, getty + any autologin on tty1 keep the display, and cage
# silently ends up on an inactive VT (tty7) — kiosk runs but nothing shows
# on the HDMI screen.
systemctl disable --now getty@tty1.service 2>/dev/null || true
# Pi OS Bookworm/Trixie may also have raspi-config's autologin override
# pointing at a different user/tty — clear it if present so it can't fight us.
rm -f /etc/systemd/system/getty@tty1.service.d/autologin.conf 2>/dev/null || true
systemctl daemon-reload

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
