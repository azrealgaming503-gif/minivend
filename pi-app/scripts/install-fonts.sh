#!/usr/bin/env bash
# Make sure the kiosk's fonts are present at pi-app/ui/fonts/.
#
# Currently:
#   Indie Flower (Google Font, SIL OFL licensed) — primary UI font
#
# Indie Flower is BUNDLED in the repo at pi-app/ui/fonts/indie-flower.woff2
# so the kiosk works completely offline. This script is now mostly a
# safety net: if for some reason the file is missing (manual deletion,
# a partial checkout, etc.) it pulls a fresh copy from Google Fonts.
#
# Safe to re-run: skips downloads when the local copy already exists.
# Failures are non-fatal — the @font-face rule in styles.css has a
# CDN fallback (https://fonts.gstatic.com/...) so an internet-
# connected kiosk still renders correctly even without this script.
#
# Called automatically by install.sh.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
UI_DIR="$(cd "${SCRIPT_DIR}/../ui" && pwd)"
FONT_DIR="${UI_DIR}/fonts"

mkdir -p "${FONT_DIR}"

# Versioned Google Fonts woff2 URL for Indie Flower v24 (latin subset,
# ~20 KB). Kept in sync with the URL in pi-app/ui/css/styles.css.
INDIE_FLOWER_URL="https://fonts.gstatic.com/s/indieflower/v24/m8JVjfNVeKWVnh3QMuKkFcZVaUuH.woff2"
INDIE_FLOWER_DST="${FONT_DIR}/indie-flower.woff2"

if [ -s "${INDIE_FLOWER_DST}" ]; then
  echo "==> Indie Flower already present at ${INDIE_FLOWER_DST} ($(stat -c%s "${INDIE_FLOWER_DST}" 2>/dev/null || wc -c < "${INDIE_FLOWER_DST}") bytes)"
else
  echo "==> Indie Flower missing locally; downloading"
  if curl -fsSL --retry 3 --retry-delay 2 -o "${INDIE_FLOWER_DST}.tmp" "${INDIE_FLOWER_URL}"; then
    mv "${INDIE_FLOWER_DST}.tmp" "${INDIE_FLOWER_DST}"
    echo "    -> ${INDIE_FLOWER_DST} ($(stat -c%s "${INDIE_FLOWER_DST}" 2>/dev/null || wc -c < "${INDIE_FLOWER_DST}") bytes)"
  else
    rm -f "${INDIE_FLOWER_DST}.tmp"
    echo "WARN: failed to download Indie Flower; CDN fallback will kick in at runtime"
  fi
fi
