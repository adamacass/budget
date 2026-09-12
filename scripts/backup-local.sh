#!/usr/bin/env bash
#
# Dump the local Docker Compose Postgres to ./backups/budget-<timestamp>.sql.gz
# and delete dumps older than 30 days.
#
#   ./scripts/backup-local.sh
#
# Safe to run while the app is up — pg_dump takes a consistent snapshot and does
# not lock anything you would notice. See SELF-HOSTING.md for how to schedule it.

set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

RETENTION_DAYS="${RETENTION_DAYS:-30}"

if docker compose version >/dev/null 2>&1; then
  dc() { docker compose "$@"; }
elif command -v docker-compose >/dev/null 2>&1; then
  dc() { docker-compose "$@"; }
else
  echo "ERROR: Docker Compose not found." >&2
  exit 1
fi

if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi
PGUSER_LOCAL="${POSTGRES_USER:-budget}"
PGDB_LOCAL="${POSTGRES_DB:-budget}"

if ! dc exec -T db pg_isready -U "$PGUSER_LOCAL" -d "$PGDB_LOCAL" >/dev/null 2>&1; then
  echo "ERROR: the 'db' service is not accepting connections. Start it with: docker compose up -d" >&2
  exit 1
fi

mkdir -p backups
OUT="backups/budget-$(date +%Y%m%d-%H%M%S).sql.gz"

# Write to a temp file first so an interrupted run never leaves a half-written
# dump that looks like a good backup.
TMP="${OUT}.partial"
trap 'rm -f "$TMP"' EXIT

dc exec -T db pg_dump -U "$PGUSER_LOCAL" -d "$PGDB_LOCAL" \
  --no-owner --no-privileges --clean --if-exists \
  | gzip -9 > "$TMP"

if [ ! -s "$TMP" ]; then
  echo "ERROR: the dump was empty — nothing written." >&2
  exit 1
fi

mv "$TMP" "$OUT"
trap - EXIT

# Prune old dumps (only files this script produces).
DELETED="$(find backups -maxdepth 1 -name 'budget-*.sql.gz' -type f -mtime "+${RETENTION_DAYS}" -print -delete | wc -l | tr -d ' ')"

echo "$(date '+%Y-%m-%d %H:%M:%S')  backup written: $OUT ($(du -h "$OUT" | cut -f1))"
if [ "$DELETED" -gt 0 ]; then
  echo "                     pruned $DELETED dump(s) older than ${RETENTION_DAYS} days"
fi

# Restore one of these with:
#   gunzip -c backups/budget-YYYYMMDD-HHMMSS.sql.gz | docker compose exec -T db psql -U budget -d budget
