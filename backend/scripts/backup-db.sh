#!/usr/bin/env bash
# Logical backup of the OuPay database with pg_dump (custom format, compressed, consistent snapshot).
#
#   PGHOST=db.internal PGUSER=oupay_backup PGPASSWORD=... PGDATABASE=oupay ./scripts/backup-db.sh
#
# Environment:
#   PG_BIN           directory holding pg_dump (default: found on PATH)
#   BACKUP_DIR       where dumps are written (default: ./backups, created with mode 700)
#   RETENTION_DAYS   delete dumps older than this many days (default: 14; 0 keeps everything)
#   PGHOST/PGPORT/PGUSER/PGPASSWORD/PGDATABASE   standard libpq settings (PGDATABASE defaults to "oupay")
#
# A dump is written to a temporary name and only renamed when pg_dump has finished successfully, so an
# interrupted run can never leave something that looks like a good backup. A SHA-256 file is written next
# to it; restore-verify.sh checks it. Dumps contain personal and financial data: keep them encrypted at
# rest, off the database host, and apply the same access controls as the database itself.
set -euo pipefail
PG_BIN="${PG_BIN:-}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
export PGDATABASE="${PGDATABASE:-oupay}"
pg() { if [ -n "$PG_BIN" ]; then "$PG_BIN/$1" "${@:2}"; else "$1" "${@:2}"; fi; }

umask 077
mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
final="$BACKUP_DIR/oupay-$stamp.dump"
partial="$final.partial"
trap 'rm -f "$partial"' EXIT

echo "Backing up database '$PGDATABASE' to $final"
pg pg_dump --format=custom --compress=6 --no-owner --no-privileges --file="$partial"
# Refuse an unreadable result: pg_restore --list must be able to read the archive.
pg pg_restore --list "$partial" > /dev/null
mv "$partial" "$final"
( cd "$BACKUP_DIR" && sha256sum "$(basename "$final")" > "$(basename "$final").sha256" )
echo "Backup complete: $final ($(wc -c < "$final") bytes)"

if [ "$RETENTION_DAYS" -gt 0 ]; then
  find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'oupay-*.dump' -o -name 'oupay-*.dump.sha256' \) -mtime +"$RETENTION_DAYS" -print -delete \
    | sed 's/^/Removed expired backup: /'
fi
