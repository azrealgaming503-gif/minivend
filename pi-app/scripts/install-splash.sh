#!/usr/bin/env bash
# Install the MiniVend "Blu" Plymouth boot splash.
#
# This replaces everything the user sees between the firmware handing
# off and the cage compositor coming up:
#   - Pi rainbow square              (disable_splash=1)
#   - Kernel log spam                (quiet loglevel=0)
#   - Console blinking cursor        (vt.global_cursor_default=0)
#   - Tux penguin                    (logo.nologo)
#   - Login prompt on tty1           (handled by main installer)
#
# What's left is a single, soft lavender screen with the "Blu"
# wordmark pulsing gently until the kiosk page paints.
#
# Safe to re-run: every change is idempotent. Backups of edited
# /boot/firmware/cmdline.txt and config.txt are kept as
# <file>.minivend-backup the first time we touch them.
#
# Run as root via the main installer, or stand-alone:
#   sudo bash pi-app/scripts/install-splash.sh

set -euo pipefail

if [ "$EUID" -ne 0 ]; then
  echo "This script must be run as root (sudo)."
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
THEME_SRC="$(cd "${SCRIPT_DIR}/../splash/blu" && pwd)"
THEME_DST="/usr/share/plymouth/themes/blu"

# Pi OS Bookworm/Trixie puts the firmware partition at /boot/firmware.
# Older Pi OS releases (Bullseye and earlier) used /boot directly.
if [ -d /boot/firmware ]; then
  FW_DIR=/boot/firmware
else
  FW_DIR=/boot
fi
CMDLINE_TXT="${FW_DIR}/cmdline.txt"
CONFIG_TXT="${FW_DIR}/config.txt"

# ---------- 1. Packages ----------
# Plymouth itself, the script-plugin module, and ImageMagick (used
# to generate the wordmark PNG so we don't have to ship binary art
# in the git repo).
echo "==> Installing plymouth + imagemagick"
apt install -y plymouth plymouth-themes plymouth-label \
               imagemagick fonts-dejavu-core

# ---------- 2. Theme files ----------
echo "==> Installing theme to ${THEME_DST}"
install -d -m 0755 "${THEME_DST}"
install -m 0644 "${THEME_SRC}/blu.plymouth" "${THEME_DST}/blu.plymouth"
install -m 0644 "${THEME_SRC}/blu.script"   "${THEME_DST}/blu.script"

# ---------- 3. Generate the logo PNG ----------
# We pre-render at 600x220 — readable on both 600x1024 portrait and
# 1024x600 landscape orientations without scaling. Plymouth centers
# the image, so any aspect ratio works.
#
# Color: --text from the pastel theme (#3d2e54, dark plum).
# Font:  DejaVu Sans Bold ships in fonts-dejavu-core on every Pi OS.
echo "==> Rendering Blu wordmark"
convert -size 600x220 xc:none \
  -font DejaVu-Sans-Bold \
  -pointsize 160 \
  -fill '#3d2e54' \
  -gravity center \
  -annotate +0+0 'Blu' \
  -fill '#ff8fb6' \
  -draw "circle 400,170 410,170" \
  "${THEME_DST}/logo.png"
chmod 0644 "${THEME_DST}/logo.png"

# ---------- 4. Make it the default theme ----------
# -R rebuilds the initramfs so the splash is available during very
# early boot (where the theme would otherwise be invisible because
# /usr isn't mounted yet). On Pi OS Lite there isn't always an
# initramfs to rebuild — the command is harmless in that case.
echo "==> Setting Blu as the default plymouth theme"
plymouth-set-default-theme -R blu || plymouth-set-default-theme blu

# ---------- 5. Suppress everything before plymouth ----------
echo "==> Patching ${CMDLINE_TXT}"
if [ -f "${CMDLINE_TXT}" ]; then
  if [ ! -f "${CMDLINE_TXT}.minivend-backup" ]; then
    cp -a "${CMDLINE_TXT}" "${CMDLINE_TXT}.minivend-backup"
  fi
  # cmdline.txt is a single space-separated line. Add each flag if
  # it isn't already present.
  for flag in quiet splash loglevel=0 vt.global_cursor_default=0 \
              logo.nologo plymouth.ignore-serial-consoles \
              fastboot disable_splash=1; do
    if ! grep -qE "(^|[[:space:]])${flag}([[:space:]]|$)" "${CMDLINE_TXT}"; then
      sed -i "s|$| ${flag}|" "${CMDLINE_TXT}"
    fi
  done
  # Collapse any double spaces left behind by repeated runs.
  sed -i 's|  *| |g; s| $||' "${CMDLINE_TXT}"
else
  echo "WARN: ${CMDLINE_TXT} not found — skipping cmdline patch"
fi

echo "==> Patching ${CONFIG_TXT}"
if [ -f "${CONFIG_TXT}" ]; then
  if [ ! -f "${CONFIG_TXT}.minivend-backup" ]; then
    cp -a "${CONFIG_TXT}" "${CONFIG_TXT}.minivend-backup"
  fi
  # Strip any previous MiniVend block (so re-runs don't accumulate)
  # then append a fresh one.
  sed -i '/^# >>> minivend-splash >>>$/,/^# <<< minivend-splash <<<$/d' "${CONFIG_TXT}"
  cat >> "${CONFIG_TXT}" <<'EOF'
# >>> minivend-splash >>>
# Suppress the firmware rainbow square between power-on and kernel
# handoff. Plymouth ("Blu" theme) takes over from there.
disable_splash=1
# <<< minivend-splash <<<
EOF
else
  echo "WARN: ${CONFIG_TXT} not found — skipping config.txt patch"
fi

# ---------- 6. Keep the splash visible until the kiosk paints ----------
# Plymouth normally quits as soon as the display-manager starts.
# We don't run a DM — cage owns the VT directly — so we keep
# plymouth around until the kiosk service signals "ready" by
# successfully serving its UI. The kiosk unit's ExecStartPre
# already curl-polls localhost:3000, so by the time cage launches
# the page is reachable. plymouth-quit-wait will release shortly
# after that.
systemctl enable plymouth-start.service       >/dev/null 2>&1 || true
systemctl enable plymouth-quit.service        >/dev/null 2>&1 || true
systemctl enable plymouth-quit-wait.service   >/dev/null 2>&1 || true

# Make the kiosk service's start gate the plymouth quit, so the
# splash never disappears before the first kiosk frame is painted.
KIOSK_DROPIN_DIR=/etc/systemd/system/minivend-kiosk.service.d
install -d -m 0755 "${KIOSK_DROPIN_DIR}"
cat >"${KIOSK_DROPIN_DIR}/plymouth.conf" <<'EOF'
# Auto-generated by install-splash.sh. Order the kiosk after
# plymouth-start so the splash is on-screen before cage takes over,
# and signal plymouth-quit-wait once the kiosk is fully up.
[Unit]
After=plymouth-start.service
Wants=plymouth-start.service

[Service]
# Tell plymouth to deactivate after cage has had a moment to paint
# its first frame. The kiosk's ExecStartPre already waits for the
# local server, so by the time we hit here Chromium is loading.
ExecStartPost=/bin/sh -c 'sleep 2; /usr/bin/plymouth quit --retain-splash 2>/dev/null || true'
EOF

systemctl daemon-reload

cat <<EOF

==> Splash install complete.

The "Blu" boot splash is now the system plymouth theme. It will be
visible from shortly after firmware handoff until the kiosk paints
its first frame.

Test without rebooting (briefly takes over the screen):
   sudo plymouthd; sudo plymouth --show-splash; sleep 3; sudo plymouth quit

To preview just the theme rendering on a development PC:
   plymouth-set-default-theme blu
   sudo plymouthd --debug --debug-file=/tmp/plymouth.log
   sudo plymouth --show-splash
   # ...press Ctrl+C when done...
   sudo plymouth quit

To remove the splash and restore the original boot output:
   sudo plymouth-set-default-theme -R \$(cat /etc/alternatives/default.plymouth | xargs basename .plymouth || echo bgrt)
   sudo cp ${CMDLINE_TXT}.minivend-backup ${CMDLINE_TXT}
   sudo cp ${CONFIG_TXT}.minivend-backup ${CONFIG_TXT}
   sudo rm -f ${KIOSK_DROPIN_DIR}/plymouth.conf

Backups of edited boot files (first run only):
   ${CMDLINE_TXT}.minivend-backup
   ${CONFIG_TXT}.minivend-backup
EOF
