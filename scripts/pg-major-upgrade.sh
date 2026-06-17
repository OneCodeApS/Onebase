#!/usr/bin/env bash
# Major-version Postgres upgrade via dump & restore, using the stock postgres
# image (no extra tooling).
#
# WHY THIS IS A SEPARATE, MANUAL STEP:
#   • The official postgres image refuses to start on a data dir created by a
#     different MAJOR (e.g. 18 binaries against a 16 data dir) — it errors and
#     exits, leaving your data untouched. So a tag bump alone won't upgrade.
#   • deploy.sh only ever recreates the dashboard (`--no-deps`), so it never
#     touches Postgres. Major upgrades are always deliberate.
#
# WHAT THIS DOES:
#   1. full cluster backup (scripts/pg-backup.sh) — the safety net,
#   2. tears down the stack and the old data volume,
#   3. initialises a fresh cluster on the NEW major and restores the backup,
#   4. brings the stack back up.
#
# The restore runs in a THROWAWAY container that does NOT mount postgres/init/*.
# The dump already contains every role, schema and row, so letting the bundled
# init scripts run too would double-seed the sample data and throw "already
# exists" errors. (A handful of harmless "role/database already exists" notices
# for the bootstrap superuser during restore are expected.)
#
# Usage:
#   1. Edit docker-compose.yml — bump `image: postgres:<NEW>-alpine`.
#   2. ./scripts/pg-major-upgrade.sh
#
# Nothing is destroyed until you type 'yes' at the confirmation prompt.
# Expect downtime for the duration (the whole stack is down while restoring).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
SCRIPT_DIR="$REPO_ROOT/scripts"
DATA_DIR="/var/lib/postgresql/data"   # must match PGDATA pinned in docker-compose.yml

log() { echo "$@" >&2; }
err() { echo "ERROR: $*" >&2; exit 1; }

command -v docker >/dev/null || err "docker not found"
[ -f .env ] || err ".env missing at $REPO_ROOT/.env"

read_env() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2- ; }
PGUSER="$(read_env POSTGRES_USER)"; PGUSER="${PGUSER:-postgres}"
PGDB="$(read_env POSTGRES_DB)";     PGDB="${PGDB:-postgres}"

# Use the prod override only when this looks like a prod server (GHCR_OWNER set)
# so the final `up` pulls the published dashboard image instead of rebuilding;
# on a dev box, base compose builds locally as usual.
COMPOSE_FILES=(-f docker-compose.yml)
if grep -qE '^GHCR_OWNER=.+' .env; then
  COMPOSE_FILES+=(-f docker-compose.prod.yml)
fi
COMPOSE=(docker compose "${COMPOSE_FILES[@]}")

PROJECT="$(docker compose -f docker-compose.yml config 2>/dev/null | awk '/^name:/{print $2; exit}')"
[ -n "$PROJECT" ] || err "could not resolve the compose project name"
VOLUME="${PROJECT}_postgres-data"

# Target major from the (already edited) compose file.
NEW_IMAGE="$(docker compose -f docker-compose.yml config --images 2>/dev/null | grep -E '^postgres:' | head -1)"
[ -n "$NEW_IMAGE" ] || err "couldn't read the postgres image from docker-compose.yml"
NEW_MAJOR="$(printf '%s' "$NEW_IMAGE" | sed -E 's/^postgres:([0-9]+).*/\1/')"
printf '%s' "$NEW_MAJOR" | grep -qE '^[0-9]+$' || err "couldn't parse a major version from image '$NEW_IMAGE'"

# Current running major.
docker compose -f docker-compose.yml ps --status running --services 2>/dev/null | grep -qx postgres \
  || err "the 'postgres' service must be running so it can be dumped first."
CUR_MAJOR="$(docker compose -f docker-compose.yml exec -T postgres psql -U "$PGUSER" -tAc 'SHOW server_version_num' | cut -c1-2)"

log "Current Postgres major: $CUR_MAJOR"
log "Target  Postgres major: $NEW_MAJOR   (image: $NEW_IMAGE)"
log "Data volume:            $VOLUME"
log ""

if [ "$CUR_MAJOR" = "$NEW_MAJOR" ]; then
  err "running major ($CUR_MAJOR) already matches the target. A same-major (minor/patch) update needs no dump/restore — just: ${COMPOSE[*]} up -d postgres"
fi
[ "$NEW_MAJOR" -gt "$CUR_MAJOR" ] || err "target ($NEW_MAJOR) is not newer than current ($CUR_MAJOR); dump/restore doesn't support downgrades."

# --- 1. Back up before anything destructive ---------------------------------
log "==> Step 1/4: backing up the current cluster"
BACKUP="$("$SCRIPT_DIR/pg-backup.sh")"
log "    backup saved: $BACKUP"
log ""

# --- Point of no return -----------------------------------------------------
cat >&2 <<WARN
About to upgrade Postgres ${CUR_MAJOR} → ${NEW_MAJOR}. This will:
  • stop the whole stack (downtime starts now),
  • DELETE the data volume '${VOLUME}',
  • initialise a fresh ${NEW_MAJOR} cluster and restore the backup into it,
  • bring the stack back up.

Your safety net is the backup above:
  ${BACKUP}
If anything goes wrong, you can restore it into the old image
(revert the tag in docker-compose.yml) — see docs/OPERATIONS.md.

WARN
printf 'Type "yes" to proceed: ' >&2
read -r ANSWER
[ "$ANSWER" = "yes" ] || err "aborted by user — nothing was changed."

# --- 2. Tear down + drop the old data volume --------------------------------
log "==> Step 2/4: stopping the stack and removing the old data volume"
"${COMPOSE[@]}" down
if docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  docker volume rm "$VOLUME" >/dev/null || err "failed to remove volume '$VOLUME' (still in use?)"
else
  log "    (volume '$VOLUME' was not present)"
fi

# --- 3. Fresh new-major cluster, restore without app init -------------------
log "==> Step 3/4: initialising Postgres ${NEW_MAJOR} and restoring (no init scripts)"
TMP="ocb-pgupgrade-$$"
cleanup_tmp() { docker rm -f "$TMP" >/dev/null 2>&1 || true; }
trap cleanup_tmp EXIT

# trust auth: this cluster is throwaway and only reached over the local socket
# via `docker exec`. The real role passwords are restored from the dump, and
# the live stack that comes up afterwards reads them from the restored data —
# so the bootstrap user's password here is irrelevant.
docker run -d --name "$TMP" \
  -e POSTGRES_USER="$PGUSER" \
  -e POSTGRES_DB="$PGDB" \
  -e POSTGRES_HOST_AUTH_METHOD=trust \
  -e PGDATA="$DATA_DIR" \
  -v "${VOLUME}:${DATA_DIR}" \
  "$NEW_IMAGE" >/dev/null

log "    waiting for the new cluster to accept connections…"
ready=0
for _ in $(seq 1 60); do
  if docker exec "$TMP" pg_isready -U "$PGUSER" >/dev/null 2>&1; then ready=1; break; fi
  sleep 1
done
[ "$ready" = 1 ] || err "the new cluster did not become ready in time"
# Let the entrypoint finish its own first-boot work before loading on top.
sleep 2

log "    restoring dump (expect a few benign 'already exists' notices)…"
# ON_ERROR_STOP=0: tolerate the bootstrap role/database that the image already
# created; the rest of the dump still applies.
gunzip -c "$BACKUP" | docker exec -i "$TMP" psql -U "$PGUSER" -d "$PGDB" -v ON_ERROR_STOP=0 >/dev/null

docker stop "$TMP" >/dev/null
cleanup_tmp
trap - EXIT

# --- 4. Bring the real stack back up on the new major -----------------------
log "==> Step 4/4: starting the stack on Postgres ${NEW_MAJOR}"
"${COMPOSE[@]}" up -d --wait

log ""
log "Done — Postgres is now major ${NEW_MAJOR}. Verify:"
log "  ${COMPOSE[*]} exec postgres psql -U $PGUSER -c 'SELECT version();'"
log "  ${COMPOSE[*]} ps        # all services Up, dashboard (healthy)"
log "Backup retained at: $BACKUP"
