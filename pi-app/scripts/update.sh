#!/usr/bin/env bash
# Atomic-ish OTA update for the MiniVend Pi app.
#
# Workflow:
#   1. Snapshot the current commit -> /opt/minivend/pi-app/.last-good-commit
#   2. `git fetch` + `git reset --hard origin/<branch>`
#   3. `npm install --omit=dev`
#   4. `systemctl restart minivend-server.service`
#   5. Health-check the new revision via curl /api/state for up to 60s.
#   6. If it never recovers, roll back to the snapshotted commit and
#      restart the server again.
#
# State (success or rollback details) is written to .update-state.json
# so the UI can display the outcome.
#
# Hosted on the same git repo the install used. Zero hosting cost.

set -euo pipefail

REPO_DIR=/opt/minivend/pi-app
STATE_FILE="${REPO_DIR}/.update-state.json"
LAST_GOOD="${REPO_DIR}/.last-good-commit"
HEALTH_URL="http://localhost:${PORT:-3000}/api/state"
HEALTH_TIMEOUT_S=60

ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }

write_state() {
  # $1=status $2=detail $3?=from $4?=to
  local from="${3:-}" to="${4:-}"
  cat > "${STATE_FILE}" <<JSON
{
  "status":  "$1",
  "detail":  "$2",
  "from":    "${from}",
  "to":      "${to}",
  "when":    "$(ts)"
}
JSON
}

cd "${REPO_DIR}"

# The updater runs as root, so every tree-mutating git step below writes
# files as root:root. The subsequent `npm install` runs as ${APP_USER}
# (via sudo -u) and would then fail with EACCES on root-owned files such
# as package-lock.json. Restore ownership after each git step so the app
# user can always write its own checkout.
APP_USER=minivend
REPO_ROOT="$(git rev-parse --show-toplevel)"
fix_perms() {
  chown -R "${APP_USER}:${APP_USER}" "${REPO_ROOT}" 2>/dev/null || true
}

PREV="$(git rev-parse HEAD)"
BRANCH="$(git rev-parse --abbrev-ref HEAD)"
echo "STARTED prev=${PREV} branch=${BRANCH}"

# Fetch + diff.
git fetch --quiet origin "${BRANCH}"
NEXT="$(git rev-parse "origin/${BRANCH}")"

if [ "${PREV}" = "${NEXT}" ]; then
  echo "Already up to date at ${PREV}"
  write_state "noop" "already_up_to_date" "${PREV}" "${PREV}"
  exit 0
fi

echo "Updating ${PREV} -> ${NEXT}"
echo "${PREV}" > "${LAST_GOOD}"

git reset --hard "${NEXT}"
fix_perms

# Indie Flower ships in git at ui/fonts/, but older installs may be
# missing the file (install-fonts never ran). Ensure it exists so the
# kiosk doesn't fall back to system-ui for every label and button.
FONT_FILE="${REPO_DIR}/ui/fonts/indie-flower.woff2"
if [ ! -s "${FONT_FILE}" ]; then
  echo "Font file missing; running install-fonts.sh..."
  bash "${REPO_DIR}/scripts/install-fonts.sh" || \
    echo "WARN: install-fonts failed; CDN fallback in styles.css"
fi

# Run npm install in the background-safe way (npm forks ssh-agent etc.,
# which doesn't matter here, but isolate the env).
echo "Installing dependencies..."
fix_perms   # install-fonts.sh above may also have written as root
sudo -u minivend -H bash -c "cd ${REPO_DIR} && npm install --omit=dev --no-audit --no-fund --loglevel=error"

# Re-install systemd unit files. They live in /etc/systemd/system/ as
# *copies* (not symlinks — systemd needs them on a stable path during
# early boot before our checkout's filesystem is fully mounted), so a
# bare `git pull` does not update what systemd is running. Without
# this step, edits to *.service files are silently ignored by OTA
# until the next manual install.sh run.
#
# Only copy + daemon-reload + restart when the file actually changed,
# so we don't needlessly bounce the kiosk on every update.
KIOSK_NEEDS_RESTART=0
for unit in minivend-server.service minivend-kiosk.service \
            minivend-updater.service minivend-updater.timer; do
  src="${REPO_DIR}/systemd/${unit}"
  dst="/etc/systemd/system/${unit}"
  if [ ! -f "${src}" ]; then continue; fi
  if [ ! -f "${dst}" ] || ! cmp -s "${src}" "${dst}"; then
    echo "Updating ${dst}"
    install -m 0644 "${src}" "${dst}"
    case "${unit}" in
      minivend-kiosk.service) KIOSK_NEEDS_RESTART=1 ;;
    esac
  fi
done

# Sudoers can also change between releases; safe to refresh.
if [ -f "${REPO_DIR}/scripts/sudoers-minivend" ]; then
  install -m 0440 "${REPO_DIR}/scripts/sudoers-minivend" /etc/sudoers.d/minivend
fi

systemctl daemon-reload

echo "Restarting minivend-server.service..."
systemctl restart minivend-server.service

if [ "${KIOSK_NEEDS_RESTART}" = "1" ]; then
  echo "Kiosk unit changed; restarting minivend-kiosk.service..."
  systemctl restart minivend-kiosk.service
fi

# Health check.
echo "Waiting for health check at ${HEALTH_URL} ..."
HEALTHY=0
for _ in $(seq 1 ${HEALTH_TIMEOUT_S}); do
  if curl -fs --max-time 2 "${HEALTH_URL}" > /dev/null; then
    HEALTHY=1
    break
  fi
  sleep 1
done

if [ "${HEALTHY}" = "1" ]; then
  echo "OK at ${NEXT}"
  write_state "ok" "applied" "${PREV}" "${NEXT}"
  exit 0
fi

# Rollback.
echo "Health check failed; rolling back to ${PREV}"
git reset --hard "${PREV}"
fix_perms
sudo -u minivend -H bash -c "cd ${REPO_DIR} && npm install --omit=dev --no-audit --no-fund --loglevel=error"
systemctl restart minivend-server.service

# Verify the rollback came up healthy too.
for _ in $(seq 1 ${HEALTH_TIMEOUT_S}); do
  if curl -fs --max-time 2 "${HEALTH_URL}" > /dev/null; then
    write_state "rolled_back" "new_revision_failed_health_check" "${PREV}" "${NEXT}"
    exit 1
  fi
  sleep 1
done

write_state "failed" "rollback_also_failed_health_check" "${PREV}" "${NEXT}"
exit 2
