#!/usr/bin/env bash
# Starts a THROWAWAY PostgreSQL cluster for the backend tests when Docker (Testcontainers) is not
# available. It never touches an existing PostgreSQL installation: it creates its own data
# directory and listens only on localhost:55432 with a throwaway password.
#
# The data directory lives in backend/.test-pgdata (git-ignored), deliberately OUTSIDE target/, so
# `mvn clean` cannot destroy a running database.
#
#   PG_BIN="/c/Program Files/PostgreSQL/18/bin" ./scripts/start-test-postgres.sh
#   export OUPAY_TEST_DB_URL=jdbc:postgresql://localhost:55432/oupay_test
#   export OUPAY_TEST_DB_USER=oupay_test OUPAY_TEST_DB_PASSWORD=oupay_test
#
# Stop it with:  "$PG_BIN/pg_ctl" -D backend/.test-pgdata stop
set -euo pipefail
PG_BIN="${PG_BIN:-/usr/lib/postgresql/16/bin}"
DATA_DIR="${OUPAY_TEST_PGDATA:-$(cd "$(dirname "$0")/.." && pwd)/.test-pgdata}"
PORT="${OUPAY_TEST_PGPORT:-55432}"

if [ ! -d "$DATA_DIR" ]; then
  mkdir -p "$DATA_DIR"
  echo "oupay_test" > "$DATA_DIR.pw"
  "$PG_BIN/initdb" -D "$DATA_DIR" -U oupay_test --auth=scram-sha-256 --pwfile="$DATA_DIR.pw" -E UTF8 >/dev/null
fi

if ! PGPASSWORD=oupay_test "$PG_BIN/pg_isready" -h localhost -p "$PORT" >/dev/null 2>&1; then
  # Detached, with output redirected, so this script (and the shell calling it) never hangs on the server.
  nohup "$PG_BIN/pg_ctl" -D "$DATA_DIR" -o "-p $PORT -c listen_addresses=localhost -c fsync=off" \
    -l "$DATA_DIR/server.log" start >/dev/null 2>&1 &
  for _ in $(seq 1 30); do
    PGPASSWORD=oupay_test "$PG_BIN/pg_isready" -h localhost -p "$PORT" >/dev/null 2>&1 && break
    sleep 1
  done
fi

PGPASSWORD=oupay_test "$PG_BIN/psql" -h localhost -p "$PORT" -U oupay_test -d postgres -tc \
  "SELECT 1 FROM pg_database WHERE datname='oupay_test'" | grep -q 1 || \
  PGPASSWORD=oupay_test "$PG_BIN/psql" -h localhost -p "$PORT" -U oupay_test -d postgres -c "CREATE DATABASE oupay_test"
echo "Test PostgreSQL ready on localhost:$PORT (database oupay_test)"
