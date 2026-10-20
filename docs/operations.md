# OuPay backend: operations guide

For people who deploy and run the backend. Architecture and APIs are in [backend.md](backend.md).

## 1. Production checklist

The application **refuses to start** with an unsafe `prod` configuration (`ProductionSafetyCheck`): the session
cookie must be Secure, the simulated bank must be off, the dev mail endpoint must be off, e-mail must be SMTP
with a host, and `oupay.app.base-url` must be `https://`. Beyond that, you must provide:

| Concern | What to do |
| --- | --- |
| Profile | `SPRING_PROFILES_ACTIVE=prod` (structured JSON logs, `__Host-` cookie, API docs off, SMTP mail) |
| TLS | Terminate TLS in front of the application. The `prod` profile sends HSTS even when it sees plain HTTP |
| Database | `OUPAY_DB_URL`, `OUPAY_DB_USER`, `OUPAY_DB_PASSWORD` (a role that may create tables: Flyway owns the schema) |
| E-mail | `OUPAY_SMTP_HOST` (+ `OUPAY_SMTP_PORT`, `OUPAY_SMTP_USER`, `OUPAY_SMTP_PASSWORD`, `OUPAY_EMAIL_FROM`); SPF/DKIM/DMARC on the sending domain |
| Links | `OUPAY_APP_BASE_URL=https://app.example.rw` (the browser application; used in every e-mailed link) |
| Reverse proxy | `OUPAY_TRUSTED_PROXIES=10.0.0.0/8,...` (the proxy addresses ONLY); the proxy must **overwrite** `X-Forwarded-For`, keep `Host`, and add `Origin`-neutral pass-through |
| Cross-origin | Same host as the SPA is allowed automatically; extra origins: `OUPAY_ALLOWED_ORIGINS=https://a.example.rw,...` (no wildcards) |
| Edge limits | Add rate limiting at the gateway/WAF too: the application's limiter is per process |
| Secrets | Environment or a secret manager. Never commit them; `.env*` files (except `.env.example`) are git-ignored |
| Backups | Schedule `scripts/backup-db.sh`, ship dumps off-host **encrypted**, and run `restore-verify.sh` regularly |
| Provider | Real Equity/MTN/Airtel connectivity does not exist yet. Never enable the simulator outside development |

## 2. Configuration reference

| Property (env) | Default | Meaning |
| --- | --- | --- |
| `oupay.app.base-url` (`OUPAY_APP_BASE_URL`) | `http://localhost:5173` | base of e-mailed links |
| `oupay.email.provider` (`OUPAY_EMAIL_PROVIDER`) | `sink` (dev), `smtp` in prod | `sink` keeps mail in memory; `smtp` needs `spring.mail.host` |
| `oupay.email.from` (`OUPAY_EMAIL_FROM`) | `OuPay <no-reply@oupay.rw>` | sender |
| `oupay.email.dispatcher.*` | enabled, 5s poll, batch 20, 8 attempts, 30s base / 1h max backoff, 2m lease | outbox delivery |
| `oupay.security.recovery.*` | reset 1h, verification 48h, invitation 7d, 3 links/hour | link lifetimes and budget |
| `oupay.security.login.*` | 5 failures, 15 min lockout | per-account lockout |
| `oupay.security.session.*` | 30m idle, 12h absolute (7d/30d remembered) | sessions |
| `oupay.security.proxy.trusted` (`OUPAY_TRUSTED_PROXIES`) | empty | proxies whose `X-Forwarded-For` is believed |
| `oupay.rate-limit.*` | public read 120, write 20, auth 20, recovery 10, webhook 600 per minute per client | per-process limits |
| `oupay.housekeeping.*` | daily 03:17 | removes dead sessions/tokens and delivered mail records |
| `OUPAY_DB_POOL_MAX` / `_MIN_IDLE` | 10 / 2 | Hikari pool |
| `OUPAY_DB_CONNECTION_TIMEOUT_MS` | 5000 | wait for a connection before failing the request |
| `OUPAY_DB_STATEMENT_TIMEOUT` / `_LOCK_TIMEOUT` / `_IDLE_TX_TIMEOUT` | 30s / 10s / 60s | server-side guards set on every connection |
| `OUPAY_HTTP_THREADS` | 100 | Tomcat worker threads |

Pool sizing: keep `OUPAY_DB_POOL_MAX` x instances below PostgreSQL's `max_connections` (minus admin and backup
headroom). A pool exhausted for 5 seconds fails the request instead of letting requests pile up. The money paths
hold row locks only for the duration of one short transaction; `lock_timeout` turns an unexpected stall into an
error rather than a hang. `max-lifetime` (25 minutes) is below typical firewall and PgBouncer limits.
Shutdown is graceful (30 seconds to finish in-flight requests).

## 3. Health and readiness

| Endpoint | Meaning | Use for |
| --- | --- | --- |
| `/actuator/health/liveness` | the process is running | restart decision |
| `/actuator/health/readiness` | the database answers | load balancer / orchestrator traffic decision |
| `/actuator/health` | aggregate incl. `emailOutbox` | dashboards; **DEGRADED** (HTTP 200) means e-mail trouble |

Only the status is public. E-mail delivery problems are deliberately not part of readiness: a mail outage must not
stop invoicing. Metrics are not exposed over HTTP (any signed-in user could read them); see section 5.

## 4. Logging and correlation ids

* Every request gets an id (the caller's `X-Request-Id` if it matches `[A-Za-z0-9._-]{8,64}`, otherwise a UUID),
  returned in the `X-Request-Id` response header and present in the logging context as `correlationId`
  (and `userId` once signed in). Give the id to support: it finds every log line of that request.
* `prod` logs one JSON object per line (ECS format). Access lines (`rw.oupay.access`) carry method, **route
  pattern**, status and duration; never the concrete URL (it can hold tokens) or the query string.
* Financial lines (`rw.oupay.financial`): `type=bank_event|allocated|reversed|flagged_for_review|replay_payload_mismatch`
  with ids, amounts and outcomes. Never payer names, references, accounts or payloads.
* E-mail addresses are masked in logs (`j***@example.rw`). Tokens, passwords and payloads are never logged
  (`ArchitectureTest` scans for it).

## 5. Metrics (Micrometer)

Collected in-process; export them with a registry of your choice (for example `micrometer-registry-prometheus` on a
**separate management port** bound to an internal interface) before relying on them.

| Meter | Tags | Alert when |
| --- | --- | --- |
| `oupay.bank.events` | provider, outcome (APPLIED, DUPLICATE, STALE, REJECTED) | REJECTED rises (bad signatures never reach it: look at 401 logs) |
| `oupay.bank.events.payload_mismatch` | provider | **any** increase: a replay with doctored content or a provider bug |
| `oupay.ledger.allocations`, `oupay.ledger.allocated.rwf` | origin | unusual drops against `oupay.bank.events` |
| `oupay.ledger.reversals`, `oupay.ledger.reversed.rwf` | kind | spikes of BANK_REVERSAL |
| `oupay.ledger.review_flags`, gauge `oupay.ledger.transactions.needing_review` | | the gauge grows without being worked down |
| `oupay.email.outbox` | result (sent, retry, failed), kind | `failed` > 0, or `retry` rising |
| `oupay.rate_limited` | bucket | sustained 429s on `auth` or `recovery` (credential or reset abuse) |

## 6. E-mail outbox runbook

Messages are written in the same transaction as the change that caused them and delivered by the dispatcher
(several instances are safe: rows are claimed with `FOR UPDATE SKIP LOCKED` and leased). A failed send is retried
with exponential backoff; after the last attempt the row is `FAILED` and **its body is erased** (it held a
one-time link). Delivered rows lose their body immediately and are deleted after 30 days.

```sql
-- What is wrong?
select status, count(*), min(created_at) from email_outbox group by status;
select kind, recipient, attempts, last_error, updated_at from email_outbox where status = 'FAILED' order by updated_at desc limit 50;
-- After fixing the cause, nothing can be replayed (the link is gone): ask the person to repeat the action
-- (request a new reset link, or invite again). Links already issued stay valid until they expire.
```

## 7. Backup and restore

```bash
export PG_BIN=/usr/lib/postgresql/17/bin PGHOST=db.internal PGUSER=oupay_backup PGDATABASE=oupay   # PGPASSWORD from your secret store
backend/scripts/backup-db.sh                 # custom-format dump + .sha256, atomic, 14 days of retention
backend/scripts/restore-verify.sh            # newest dump: checksum, restore into a THROWAWAY database, invariants, drop
```

`restore-verify.sh` proves more than "pg_restore exited 0": every Flyway migration is recorded, no invoice or
transaction is over-allocated, no active allocation sits on an unconfirmed transaction, no allocation crosses
businesses, active users have credentials, there is at most one pending invitation per membership, and the ledger
and audit triggers survived the round trip. Run it on a schedule and **alert on a non-zero exit**. It needs a role
with `CREATEDB`, and never touches the source database.

Restoring for real: create an empty database, `pg_restore --no-owner --dbname=oupay <dump>`, then start the
application (Flyway sees the history and does nothing). A dump contains personal and financial data and live
session hashes: encrypt it at rest, keep it off the database host, restrict access, and expire it. Restoring
a dump signs nobody out by itself, so after restoring an old dump consider revoking sessions
(`update auth_sessions set revoked_at = now() where revoked_at is null`).

Point-in-time recovery needs continuous WAL archiving, which is a PostgreSQL/infrastructure concern outside this
repository; a logical backup alone has an RPO equal to the backup interval.

## 8. Migrations

Flyway applies `V1..V6` on startup and is the only owner of the schema (Hibernate only validates it). Migrations
are forward-only: never edit an applied one (its checksum is verified, and `.gitattributes` pins LF endings for
that reason). To undo a bad release, restore a backup taken before it. Take a backup before every deployment that
contains a migration.

## 9. Incident quick reference

| Symptom | First look |
| --- | --- |
| Users cannot sign in | 429s (`oupay.rate_limited{bucket=auth}`), lockouts (`users.locked_until`), DB readiness |
| Password reset mail never arrives | `email_outbox` status; SMTP credentials; SPF/DKIM; the reset-link budget (3 per hour) |
| Customer paid but the invoice is unpaid | `bank_events` outcome for the provider event id; `oupay.bank.events`; transaction review state; reference mismatch (matching is exact by design) |
| Payload mismatch alert | `audit_log` kind `REPLAY_PAYLOAD_MISMATCH`: compare with the provider; never "fix" ledger rows by hand |
| Everyone is rate limited | `OUPAY_TRUSTED_PROXIES` wrong: all clients share the proxy's address |
| Startup refuses | the message lists every unsafe setting at once |
