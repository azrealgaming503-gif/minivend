#!/usr/bin/env bash
# Download the kiosk's fonts to pi-app/ui/fonts/ so they're served
# locally and the kiosk doesn't need internet access to render text.
#
# Currently:
#   Indie Flower (Google Font, SIL OFL licensed) — primary UI font
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

# Versioned Google Fonts woff2 URL for Indie Flower v21. Kept in
# sync with the URL in pi-app/ui/css/styles.css @font-face.
INDIE_FLOWER_URL="https://fonts.gstatic.com/s/indieflower/v21/m8JVjfNVeKWVnh3QMuKkFcZlbkGG1dKEDw.woff2"
INDIE_FLOWER_DST="${FONT_DIR}/indie-flower.woff2"

if [ -s "${INDIE_FLOWER_DST}" ]; then
  echo "==> Indie Flower already cached at ${INDIE_FLOWER_DST}"
else
  echo "==> Downloading Indie Flower"
  if curl -fsSL -o "${INDIE_FLOWER_DST}.tmp" "${INDIE_FLOWER_URL}"; then
    mv "${INDIE_FLOWER_DST}.tmp" "${INDIE_FLOWER_DST}"
    echo "    -> ${INDIE_FLOWER_DST} ($(stat -c%s "${INDIE_FLOWER_DST}" 2>/dev/null || wc -c < "${INDIE_FLOWER_DST}") bytes)"
  else
    rm -f "${INDIE_FLOWER_DST}.tmp"
    echo "WARN: failed to download Indie Flower; CDN fallback will kick in at runtime"
  fi
fi
