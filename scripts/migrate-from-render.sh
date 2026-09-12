#!/usr/bin/env bash
#
# Copy the live Render Postgres database into the local Docker Compose Postgres.
#
#   ./scripts/migrate-from-render.sh "postgresql://user:pass@dpg-xxx.oregon-postgres.render.com/dbname"
#   RENDER_DATABASE_URL=... ./scripts/migrate-from-render.sh
#
# Find the URL in the Render dashboard: your Postgres instance -> Connections ->
# "External Database URL" (the internal one only works from inside Render).
#
# What it does:
#   1. checks the local db service is up and healthy
#   2. pg_dump from Render into ./backups/render-<timestamp>.sql
#   3. stops the app container (so it cannot write while tables are swapped)
#   4. restores the dump into the local database
#   5. starts the app again and prints row counts for the key tables
#
# The dump uses --clean --if-exists, so it REPLACES the local contents of those
# tables (including the demo data the app seeds on a fresh database).

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

# --- helpers ---------------------------------------------------------------

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
info() { printf '    %s\n' "$*"; }
fail() { printf '\n\033[31mERROR: %s\033[0m\n' "$*" >&2; exit 1; }

if docker compose version >/dev/null 2>&1; then
  dc() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  dc() { docker-compose "$@"; }
else
  fail "Docker Compose not found. Install Docker Desktop (or the compose plugin) first."
fi

# --- inputs ----------------------------------------------------------------

RENDER_URL="${1:-${RENDER_DATABASE_URL:-}}"
if [ -z "$RENDER_URL" ]; then
  fail "No Render connection string.
       Usage: $0 \"postgresql://user:pass@dpg-xxxx.oregon-postgres.render.com/dbname\"
       or set RENDER_DATABASE_URL in your environment / .env"
fi

# Pull the local database credentials out of .env, falling back to the same
# defaults docker-compose.yml uses.
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
PGUSER_LOCAL="${POSTGRES_USER:-budget}"
PGDB_LOCAL="${POSTGRES_DB:-budget}"

TIMESTAMP="$(date +%Y%m%d-%H%M%S)"
mkdir -p backups
DUMP_FILE="backups/render-${TIMESTAMP}.sql"

# --- 1. preflight ----------------------------------------------------------

step "Checking the local database is running"
if ! dc ps --services --status running 2>/dev/null | grep -qx db; then
  fail "The 'db' service is not running.
       Start the stack first:  docker compose up -d
       Then re-run this script."
fi
if ! dc exec -T db pg_isready -U "$PGUSER_LOCAL" -d "$PGDB_LOCAL" >/dev/null 2>&1; then
  fail "The 'db' container is running but Postgres is not accepting connections yet.
       Wait a few seconds and try again, or check:  docker compose logs db"
fi
info "Local Postgres is up (user=$PGUSER_LOCAL db=$PGDB_LOCAL)."

# --- 2. dump from Render ---------------------------------------------------

step "Dumping the Render database"
info "This reads from Render and writes nothing to it."

if command -v pg_dump >/dev/null 2>&1; then
  info "Using pg_dump from your machine ($(pg_dump --version))."
  pg_dump "$RENDER_URL" \
    --no-owner --no-privileges --clean --if-exists \
    --file "$DUMP_FILE"
else
  info "No pg_dump on this machine — running it inside the postgres:16 container instead."
  dc exec -T db pg_dump "$RENDER_URL" \
    --no-owner --no-privileges --clean --if-exists \
    > "$DUMP_FILE"
fi

if [ ! -s "$DUMP_FILE" ]; then
  rm -f "$DUMP_FILE"
  fail "The dump came out empty. Check the connection string, and that the Render
       database still exists (free-tier databases expire after 90 days)."
fi
info "Saved $DUMP_FILE ($(du -h "$DUMP_FILE" | cut -f1))."

# --- 3. stop the app -------------------------------------------------------

step "Stopping the app container while the tables are replaced"
dc stop app >/dev/null 2>&1 || true
info "Stopped."

# --- 4. restore ------------------------------------------------------------

step "Restoring into the local database"
info "DROPs and recreates the tables in the dump, then loads the rows."
set +e
dc exec -T db psql -v ON_ERROR_STOP=1 --quiet -U "$PGUSER_LOCAL" -d "$PGDB_LOCAL" \
  < "$DUMP_FILE" > "backups/restore-${TIMESTAMP}.log" 2>&1
RESTORE_STATUS=$?
set -e

if [ "$RESTORE_STATUS" -ne 0 ]; then
  printf '\n\033[31mRestore reported errors. Last 20 lines:\033[0m\n' >&2
  tail -20 "backups/restore-${TIMESTAMP}.log" >&2
  fail "Restore failed. Full log: backups/restore-${TIMESTAMP}.log
       The dump is still there ($DUMP_FILE) — nothing was lost on the Render side.
       Start the app again with:  docker compose start app"
fi
info "Restore completed. Log: backups/restore-${TIMESTAMP}.log"

# --- 5. restart and verify -------------------------------------------------

step "Starting the app again"
dc start app >/dev/null
info "Started. It re-applies its own idempotent schema migrations on boot;"
info "it will NOT re-seed demo data because the tables now have rows."

step "Row counts in the local database"
TABLES="users expenses income_entries account_balances savings_goals goal_contributions fund_allocations levers category_budgets"
for t in $TABLES; do
  count="$(dc exec -T db psql -At -U "$PGUSER_LOCAL" -d "$PGDB_LOCAL" \
    -c "SELECT CASE WHEN to_regclass('public.$t') IS NULL THEN 'MISSING' ELSE (SELECT count(*)::text FROM $t) END" 2>/dev/null | tr -d '\r')"
  printf '    %-22s %s\n' "$t" "${count:-?}"
done

step "Done"
cat <<EOF
    Compare those counts against Render before you switch over. If they look
    right, open the app and log in with your existing username and password
    (password hashes come across in the dump, so nothing is reset).

      App:   http://localhost:${APP_PORT:-8080}
      Logs:  docker compose logs -f app

    Keep $DUMP_FILE until you are satisfied — it is your rollback.
EOF
