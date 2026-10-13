#!/usr/bin/env bash
# Proves that a backup can actually be restored and that the restored data is internally consistent.
# It restores into a THROWAWAY database (created and dropped by this script) and never touches the source.
#
#   PGHOST=... PGUSER=... PGPASSWORD=... ./scripts/restore-verify.sh backups/oupay-20261013T031700Z.dump
#   ./scripts/restore-verify.sh            # verifies the newest dump in $BACKUP_DIR
#
# The PostgreSQL role needs CREATEDB. Exit code 0 means: checksum matches, restore succeeded, every Flyway
# migration is recorded as successful, the financial invariants hold, and the database guards (triggers) exist.
# Set COMPARE_SOURCE=1 (with PGDATABASE pointing at the live database) to also compare row counts with it;
# expect the restore to have FEWER or equal rows if the live database changed since the dump.
set -euo pipefail
PG_BIN="${PG_BIN:-}"
BACKUP_DIR="${BACKUP_DIR:-./backups}"
SOURCE_DB="${PGDATABASE:-oupay}"
pg() { if [ -n "$PG_BIN" ]; then "$PG_BIN/$1" "${@:2}"; else "$1" "${@:2}"; fi; }

dump="${1:-}"
if [ -z "$dump" ]; then
  dump="$(ls -1t "$BACKUP_DIR"/oupay-*.dump 2>/dev/null | head -n 1 || true)"
  [ -n "$dump" ] || { echo "No backup found in $BACKUP_DIR" >&2; exit 2; }
fi
[ -f "$dump" ] || { echo "Backup not found: $dump" >&2; exit 2; }

fail() { echo "RESTORE VERIFICATION FAILED: $*" >&2; exit 1; }

# 1. Integrity of the file itself.
if [ -f "$dump.sha256" ]; then
  ( cd "$(dirname "$dump")" && sha256sum --check --status "$(basename "$dump").sha256" ) || fail "checksum mismatch for $dump"
  echo "ok  checksum matches"
else
  echo "warn no checksum file next to the dump; skipping the integrity check" >&2
fi

# 2. Restore into a scratch database.
scratch="oupay_restore_verify_$(date -u +%H%M%S)_$RANDOM"
export PGDATABASE=postgres
cleanup() { PGDATABASE=postgres pg psql -q -c "DROP DATABASE IF EXISTS \"$scratch\"" >/dev/null 2>&1 || true; }
trap cleanup EXIT
pg psql -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$scratch\"" || fail "cannot create scratch database (role needs CREATEDB)"
echo "ok  scratch database $scratch created"
pg pg_restore --exit-on-error --no-owner --no-privileges --dbname="$scratch" "$dump" || fail "pg_restore reported errors"
echo "ok  restore completed"

q() { PGDATABASE="$scratch" pg psql -X -A -t -v ON_ERROR_STOP=1 -c "$1"; }
expect_zero() {
  local description="$1" sql="$2" n
  n="$(q "$sql")"
  [ "$n" = "0" ] || fail "$description (count: $n)"
  echo "ok  $description"
}

# 3. Schema history.
failed="$(q "select count(*) from flyway_schema_history where not success")"
[ "$failed" = "0" ] || fail "flyway history contains failed migrations"
applied="$(q "select count(*) from flyway_schema_history where success")"
[ "$applied" -ge 1 ] || fail "no migrations recorded"
echo "ok  $applied migrations recorded, latest version $(q "select max(version::int) from flyway_schema_history where version is not null")"

# 4. Financial and structural invariants.
expect_zero "no invoice is allocated more than it is worth" \
  "select count(*) from (select i.id from invoices i join payment_allocations a on a.invoice_id = i.id and a.status = 'ACTIVE' group by i.id, i.grand_total_rwf having sum(a.amount_rwf) > i.grand_total_rwf) x"
expect_zero "no bank transaction is allocated more than it received" \
  "select count(*) from (select t.id from bank_transactions t join payment_allocations a on a.bank_transaction_id = t.id and a.status = 'ACTIVE' group by t.id, t.amount_rwf having sum(a.amount_rwf) > t.amount_rwf) x"
expect_zero "no active allocation sits on a transaction that is not CONFIRMED" \
  "select count(*) from payment_allocations a join bank_transactions t on t.id = a.bank_transaction_id where a.status = 'ACTIVE' and t.status <> 'CONFIRMED'"
expect_zero "no allocation crosses businesses" \
  "select count(*) from payment_allocations a join invoices i on i.id = a.invoice_id join bank_transactions t on t.id = a.bank_transaction_id where i.merchant_id <> a.merchant_id or t.merchant_id <> a.merchant_id"
expect_zero "every ACTIVE user has a password hash" "select count(*) from users where status = 'ACTIVE' and password_hash is null"
expect_zero "no more than one PENDING invitation per membership" \
  "select count(*) from (select membership_id from staff_invitations where status = 'PENDING' group by membership_id having count(*) > 1) x"
expect_zero "no membership points at a missing user or business" \
  "select count(*) from memberships m where not exists (select 1 from users u where u.id = m.user_id) or not exists (select 1 from merchants b where b.id = m.merchant_id)"

# 5. The database guards must have survived the round trip.
triggers="$(q "select count(*) from pg_trigger where not tgisinternal")"
[ "$triggers" -ge 10 ] || fail "expected the ledger and audit triggers to be restored, found only $triggers"
echo "ok  $triggers database triggers restored"
expect_zero "the audit log is still append-only" \
  "select case when exists (select 1 from pg_trigger where tgname = 'trg_audit_log_immutable') then 0 else 1 end"

# 6. Optional: compare with the live database.
if [ "${COMPARE_SOURCE:-0}" = "1" ]; then
  for table in users merchants memberships invoices bank_transactions payment_allocations audit_log; do
    live="$(PGDATABASE="$SOURCE_DB" pg psql -X -A -t -c "select count(*) from $table")"
    restored="$(q "select count(*) from $table")"
    echo "info $table: live=$live restored=$restored"
    [ "$restored" -le "$live" ] || fail "$table has more rows in the restore than in the live database"
  done
fi

echo "RESTORE VERIFIED: $dump"
