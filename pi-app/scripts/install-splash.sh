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
# Plymouth itself, the script-plugin module, ImageMagick (used
# to generate the wordmark PNG so we don't have to ship binary art
# in the git repo), and initramfs-tools so plymouth can start from
# the initrd — that's the critical bit that lets the splash cover
# the *whole* boot instead of only the last few seconds.
#
# Without an initramfs, plymouth-start.service can't run until the
# rootfs is mounted AND systemd reaches basic.target, which on a
# Pi 5 is about 6–10 seconds in. With an initramfs, plymouth is the
# first userspace program drawn after kernel init, ~1 second in.
echo "==> Installing plymouth + initramfs-tools + imagemagick"
apt install -y plymouth plymouth-themes plymouth-label \
               initramfs-tools \
               imagemagick fonts-dejavu-core

# ---------- 2. Theme files ----------
echo "==> Installing theme to ${THEME_DST}"
install -d -m 0755 "${THEME_DST}"
install -m 0644 "${THEME_SRC}/blu.plymouth" "${THEME_DST}/blu.plymouth"
install -m 0644 "${THEME_SRC}/blu.script"   "${THEME_DST}/blu.script"

# ---------- 3. Generate the logo PNG ----------
# We pre-render at 600x220 in landscape orientation, then rotate the
# image to match KIOSK_ROTATE so the wordmark reads correctly when
# the display is physically mounted in portrait.
#
# Plymouth runs *before* cage/wlr-randr, so the firmware always
# outputs in the panel's native landscape orientation. If the panel
# is physically mounted 90° clockwise (KIOSK_ROTATE=90) the user
# perceives the firmware's output as rotated 90° CCW — so we
# pre-rotate the logo image 90° CW to compensate.
#
# Color: --text from the pastel theme (#3d2e54, dark plum).
# Font:  DejaVu Sans Bold ships in fonts-dejavu-core on every Pi OS.
echo "==> Rendering Blu wordmark"

rotate_value="$( \
  awk -F= '/^[[:space:]]*Environment=KIOSK_ROTATE=/ {gsub(/"|[[:space:]]/, "", $3); print $3}' \
    /etc/systemd/system/minivend-kiosk.service.d/override.conf 2>/dev/null \
    | tail -n1)"
rotate_value="${rotate_value:-normal}"
# IMPORTANT: ImageMagick's `-rotate N` rotates the image CLOCKWISE by N
# degrees, but wlr-randr's `--transform N` rotates the OUTPUT
# COUNTER-CLOCKWISE by N degrees (wlroots convention). To make
# plymouth's pre-rotated logo end up in the same orientation as the
# rotated cage output, we have to rotate the IMAGE by 360 - N
# (i.e. apply the *inverse* rotation).
#
# Earlier versions rotated by the same number, which made the splash
# appear 180° off when KIOSK_ROTATE was 90 or 270.
case "${rotate_value}" in
  90)          rot_arg="-rotate 270" ;;
  180)         rot_arg="-rotate 180" ;;
  270)         rot_arg="-rotate 90"  ;;
  flipped-180) rot_arg="-rotate 180 -flop" ;;
  normal|*)    rot_arg="" ;;
esac
echo "    using KIOSK_ROTATE=${rotate_value} -> ImageMagick args: '${rot_arg}'"

convert -size 600x220 xc:none \
  -font DejaVu-Sans-Bold \
  -pointsize 160 \
  -fill '#3d2e54' \
  -gravity center \
  -annotate +0+0 'Blu' \
  -fill '#ff8fb6' \
  -draw "circle 400,170 410,170" \
  ${rot_arg} \
  "${THEME_DST}/logo.png"
chmod 0644 "${THEME_DST}/logo.png"

# ---------- 4. Make it the default theme + build initramfs ----------
# `plymouth-set-default-theme -R` rebuilds the initramfs with the
# new theme bundled in. We then explicitly run update-initramfs -c
# (create) to ensure an initrd actually exists — on a stock Pi OS
# Lite install there isn't one until you ask for it. With both:
#   - The Blu theme is inside the initrd
#   - Plymouth can start from the initrd (very early in boot)
echo "==> Setting Blu as the default plymouth theme"
plymouth-set-default-theme -R blu || plymouth-set-default-theme blu

echo "==> Building initramfs (so plymouth starts at the top of boot)"
# `-c` creates the initrd if missing, `-u` updates an existing one.
# The first run on a fresh Pi OS Lite needs -c; later runs need -u.
update-initramfs -c -k all 2>/dev/null || update-initramfs -u -k all

# update-initramfs writes to /boot/initrd.img-<ver>. The Pi
# firmware reads from /boot/firmware/ on Bookworm+. The
# raspi-firmware package's kernel post-install hooks usually sync
# them, but `update-initramfs` alone doesn't trigger those hooks.
# Mirror manually so `auto_initramfs=1` in config.txt actually
# finds an initrd next to the kernel.
if [ "${FW_DIR}" = "/boot/firmware" ]; then
  for initrd in /boot/initrd.img-*; do
    [ -f "${initrd}" ] || continue
    cp -f "${initrd}" "${FW_DIR}/$(basename "${initrd}")"
  done
fi

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
# Auto-load the initramfs the kernel was packaged with. This is what
# lets plymouth start from the initrd (very early in boot), so the
# splash covers the entire kernel/userspace bring-up instead of only
# the last few seconds. Without this, plymouth has to wait for
# basic.target which is 6–10s into boot on a Pi 5.
auto_initramfs=1
# <<< minivend-splash <<<
EOF
else
  echo "WARN: ${CONFIG_TXT} not found — skipping config.txt patch"
fi

# ---------- 6. Keep the splash visible until the kiosk paints ----------
# Plymouth ships two services that tear down the splash on systemd's
# default schedule:
#   - plymouth-quit.service       runs `plymouth quit` after
#                                 systemd-user-sessions
#   - plymouth-quit-wait.service  blocks boot transitions until
#                                 plymouth exits
#
# Both fire WAY before cage + chromium have finished loading the
# kiosk page. On a Pi 5 cold boot the gap is ~3–8 seconds of black
# screen between plymouth quitting and the kiosk painting.
#
# We mask both so they cannot run, and we drive the quit ourselves
# from the kiosk page: the moment the idle animation's first frame
# is composited, the page POSTs /api/kiosk-ready, the server runs
# `plymouth quit --retain-splash`, and the splash image holds in
# the framebuffer until chromium overwrites it. Result: a single-
# frame handoff with no visible gap.
echo "==> Enabling plymouth-start, masking the auto-quit services"
systemctl enable plymouth-start.service       >/dev/null 2>&1 || true
systemctl mask   plymouth-quit.service        >/dev/null 2>&1 || true
systemctl mask   plymouth-quit-wait.service   >/dev/null 2>&1 || true

KIOSK_DROPIN_DIR=/etc/systemd/system/minivend-kiosk.service.d
install -d -m 0755 "${KIOSK_DROPIN_DIR}"
cat >"${KIOSK_DROPIN_DIR}/plymouth.conf" <<'EOF'
# Auto-generated by install-splash.sh. Order the kiosk after
# plymouth-start so the splash is on-screen before cage takes over.
# NOTE: We intentionally do NOT call `plymouth quit` here — the
# idle page hits /api/kiosk-ready when its first frame paints, and
# the server tears down the splash from there. That gives us a
# seamless splash → kiosk handoff instead of a 3-8 second black
# screen while Chromium loads.
[Unit]
After=plymouth-start.service
Wants=plymouth-start.service
EOF

# Belt-and-suspenders timeout: if for any reason /api/kiosk-ready
# never fires (server down, page crash, etc), don't strand plymouth
# on screen forever. This systemd timer fires 45 seconds after boot
# and unconditionally kills the splash. 45s is well past a normal
# cold boot to first kiosk frame on a Pi 5 (~15-20s).
cat >/etc/systemd/system/minivend-plymouth-timeout.service <<'EOF'
[Unit]
Description=MiniVend plymouth-quit safety timeout
After=plymouth-start.service
ConditionPathExists=/usr/bin/plymouth

[Service]
Type=oneshot
ExecStart=/usr/bin/plymouth quit --retain-splash
RemainAfterExit=no
EOF
cat >/etc/systemd/system/minivend-plymouth-timeout.timer <<'EOF'
[Unit]
Description=MiniVend plymouth-quit safety timeout (45s after boot)

[Timer]
OnBootSec=45s
AccuracySec=1s
Unit=minivend-plymouth-timeout.service

[Install]
WantedBy=timers.target
EOF
systemctl enable minivend-plymouth-timeout.timer >/dev/null 2>&1 || true

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
   sudo systemctl unmask plymouth-quit.service plymouth-quit-wait.service

Backups of edited boot files (first run only):
   ${CMDLINE_TXT}.minivend-backup
   ${CONFIG_TXT}.minivend-backup
EOF
