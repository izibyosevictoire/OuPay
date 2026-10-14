# OuPay staging deployment: Neon + Render + Vercel

This is a **staging** setup for testing the real application end to end. It is not a live banking launch: there is no
bank connectivity, no real customer data, and payments cannot be confirmed (see section 12).

```
Browser ──https──▶ Vercel  https://<vercel-domain>      static React app + proxy for /api/*
                     │  rewrite (server side)
                     ▼
                   Render  https://<render-service>.onrender.com    Docker, Spring Boot, profile "prod"
                     │  TLS (sslmode=require)
                     ▼
                   Neon    PostgreSQL, Flyway migrations V1–V5
```

The browser only ever talks to the Vercel domain. `/api/*` is proxied to Render server-side, so the session cookie
belongs to the Vercel domain, there is no CORS, and no backend URL or credential reaches the browser.

Every value written as `<like-this>` is something **you** create or choose. No secret value appears in this
repository, and none is invented here.

## 0. Order of work

Vercel needs the Render URL (rewrite) and Render needs the Vercel domain (links, allowed origin), so:

1. Neon: create the project and note the **direct** connection details (section 1).
2. Vercel: create the project from the repository **without deploying** (or deploy once and ignore the failure) to
   learn its production domain `<vercel-domain>` (section 3). Use a custom domain if you have one.
3. Render: create the web service with the environment variables of section 2 (it needs `<vercel-domain>`).
4. Back in the repository, on branch `feature/staging-deployment`:
   `node scripts/set-render-url.mjs https://<render-service>.onrender.com`, commit, push, then deploy Vercel.

## 1. Neon database

1. Create a Neon project in the region **closest to your Render region** (latency on every query). Choose a
   PostgreSQL version of 16 or newer.
2. Create a database (for example `oupay_staging`) and a **dedicated role** for the application (not the project
   owner role if you can avoid it). The role must be allowed to create tables and triggers: Flyway owns the schema.
3. Copy the **direct** connection details (host without `-pooler`). Build the JDBC URL from them. Neon shows
   `postgresql://<user>:<password>@<host>/<db>?sslmode=require`; the application wants the parts separately:

```
OUPAY_DB_URL=jdbc:postgresql://<neon-direct-host>/<db>?sslmode=require
OUPAY_DB_USER=<neon-role>
OUPAY_DB_PASSWORD=<neon-role-password>          # secret
```

Do not paste the password into the URL and do not copy `channel_binding=require` (a libpq option the JDBC driver
does not use). TLS is **mandatory**: in production the application refuses to start unless the JDBC URL says
`sslmode=require` (or `verify-ca` / `verify-full`) for any host other than localhost. `verify-full` also works with
Neon's public certificate if you add `&sslrootcert=system`; test that on staging before relying on it.

### Direct versus pooled connections

| | Direct (`ep-xxxx.<region>.aws.neon.tech`) | Pooled (`ep-xxxx-pooler.<region>…`) |
| --- | --- | --- |
| What it is | a normal PostgreSQL connection | PgBouncer in **transaction** mode |
| Connection limit | the compute's `max_connections` (a few hundred at most; fewer on small computes) | thousands of client connections multiplexed onto a few server connections |
| Session state | kept (`SET statement_timeout` etc. work) | **not reliable** between transactions |
| DDL / Flyway | supported | not recommended: use direct |
| Fits | a small number of long-lived connections | many short-lived clients (serverless functions) |

**Recommendation for staging: use the direct URL for both the application and Flyway.** OuPay is one JVM with a
connection pool; it needs few connections, relies on session settings (statement, lock and idle-in-transaction
timeouts are set on each connection) and takes row locks for the money paths. Keep the pool small
(`OUPAY_DB_POOL_MAX=5`) so staging stays far below Neon's limit.

If you later need pooling (several instances, or a very small Neon plan):

* keep Flyway on the direct URL: set `OUPAY_FLYWAY_DB_URL` (and `OUPAY_FLYWAY_DB_USER` / `OUPAY_FLYWAY_DB_PASSWORD`
  if they differ) to the direct connection, and point `OUPAY_DB_URL` at the `-pooler` host;
* session-level `SET` is unreliable behind the pooler, so replace the init statement:
  `OUPAY_DB_CONNECTION_INIT_SQL=SELECT 1` and rely on the socket timeouts (30 s query timeout through JPA,
  60 s socket timeout);
* pooled mode has not been load-tested with this application.

Neon **scale to zero** suspends an idle compute; the next connection can take a few seconds. Set
`OUPAY_DB_CONNECTION_TIMEOUT_MS=15000` on staging so the first request after idle waits instead of failing. (The
pool's keep-alive pings every 5 minutes while the app is running, which also keeps a free compute awake: that
consumes compute hours.)

Flyway runs **automatically on application start** (`V1`–`V5`), on the same connection unless you set the
`OUPAY_FLYWAY_*` variables. The application never drops, cleans or recreates the schema (`ddl-auto=validate`,
Flyway `clean` is disabled by default).

## 2. Render web service

Create **New → Web Service → Build and deploy from a Git repository**, repository
`https://github.com/izibyosevictoire/OuPay`, branch `feature/staging-deployment` (or `main` after approval).

| Setting | Value |
| --- | --- |
| Language / Runtime | **Docker** |
| Root Directory | `backend` |
| Dockerfile Path | `./Dockerfile` (relative to the root directory) |
| Docker Build Context Directory | `.` (that is, `backend`) |
| Docker Command | leave **empty** (the image's `ENTRYPOINT` starts the JVM) |
| Health Check Path | `/actuator/health/readiness` |
| Auto-Deploy | your choice; **off** is safer while testing |
| Instance type | not the 512 MB free tier: start with **2 GB** (the JVM uses 70% of the container memory; see section 12) |
| Region | next to your Neon region |
| `PORT` | do **not** set it: Render injects it and the application binds `0.0.0.0:$PORT` |

The health check path is open (no session) and returns only `{"status":"UP"}`. It is "ready" when the database
answers; mail trouble does not make it fail.

### Environment variables (Render → Environment)

Set these in the Render dashboard. Mark the ones noted as **secret**; Render hides them after saving.

| Variable | Required | Value / example | Notes |
| --- | --- | --- | --- |
| `OUPAY_DB_URL` | yes | `jdbc:postgresql://<neon-direct-host>/<db>?sslmode=require` | must contain `sslmode=require` |
| `OUPAY_DB_USER` | yes | `<neon-role>` | |
| `OUPAY_DB_PASSWORD` | yes | `<neon-role-password>` | **secret** |
| `OUPAY_APP_BASE_URL` | yes | `https://<vercel-domain>` | must be `https://`; used in every e-mailed link |
| `OUPAY_ALLOWED_ORIGINS` | yes | `https://<vercel-domain>` | exact origin, no trailing slash, no wildcard; without it every login through the proxy is refused with 403 |
| `OUPAY_SMTP_HOST` | yes | `<smtp-host>` | startup fails without it |
| `OUPAY_SMTP_PORT` | no | `587` | default 587 (STARTTLS) |
| `OUPAY_SMTP_USER` | if the server needs auth | `<smtp-user>` | |
| `OUPAY_SMTP_PASSWORD` | if the server needs auth | `<smtp-password>` | **secret** |
| `OUPAY_EMAIL_FROM` | no | `OuPay Staging <no-reply@<your-domain>>` | use a domain you control |
| `OUPAY_DB_POOL_MAX` | recommended | `5` | default 10 |
| `OUPAY_DB_POOL_MIN_IDLE` | recommended | `1` | default 2 |
| `OUPAY_DB_CONNECTION_TIMEOUT_MS` | recommended | `15000` | tolerates Neon waking up; default 5000 |
| `OUPAY_HTTP_THREADS` | no | `40` | default 100 |
| `OUPAY_RATE_LIMIT_PUBLIC_READ` / `_PUBLIC_WRITE` / `_AUTH` / `_RECOVERY` / `_WEBHOOK` | recommended, see below | e.g. `600` / `120` / `120` / `30` / `600` | per minute per client address |
| `OUPAY_TRUSTED_PROXIES` | no | see below | |
| `OUPAY_FLYWAY_DB_URL`, `OUPAY_FLYWAY_DB_USER`, `OUPAY_FLYWAY_DB_PASSWORD` | only with a pooled app URL | direct Neon connection | **secret** (password) |
| `OUPAY_DB_CONNECTION_INIT_SQL` | only with a pooled app URL | `SELECT 1` | |
| `JAVA_OPTS` | no | the image default is `-XX:MaxRAMPercentage=70 -XX:+UseSerialGC …` | replacing it replaces ALL defaults |

`SPRING_PROFILES_ACTIVE=prod` is already set by the image. **Do not** set it to anything else, and never to `dev`
(the application refuses `prod` together with `dev`).

There is **no** session-signing key, JWT secret or simulator secret to configure: sessions are random values stored
hashed in the database, and the bank simulator is switched off in production.

**Why the rate limits need raising on staging.** The limiter keys on the client address as the application sees it.
Behind Vercel and Render's proxy, every browser arrives from the same few proxy addresses, so all users share one
bucket (the default public-write limit is 20 per minute for *everybody*). `OUPAY_TRUSTED_PROXIES` can restore real
client addresses only if the proxy addresses are known and stable, which is not the case for Vercel's egress, so
leave it **empty** (the safe default: `X-Forwarded-For` is ignored) and raise the limits to match your test traffic.
This also means the limits are weaker on staging than they would be with real client addresses; the per-account
protections (login lockout, reset-link budget) do not depend on addresses.

Startup safeguards (they stop the service from starting if anything below is wrong; the message lists every
problem at once and never prints the database URL): secure `__Host-` session cookie, simulator off, SMTP configured
and the dev mail sink off, `https://` base URL, TLS to the database, no wildcard origins.

## 3. Vercel project

Import the repository as a new project.

| Setting | Value |
| --- | --- |
| Framework Preset | Vite (also set by `vercel.json`) |
| Root Directory | `.` (the repository root: `package.json` and `vercel.json` live there) |
| Install Command | `npm ci` (from `vercel.json`) |
| Build Command | `node scripts/check-vercel-config.mjs && npm run build` (from `vercel.json`) |
| Output Directory | `dist` |
| Node.js version | 22.x or newer |
| Production Branch | the branch you deploy from |

`vercel.json` already contains:

* **`VITE_API_MODE=http`** and `VITE_API_BASE_URL=/api/v1` as build variables (public values, not secrets);
* the **rewrites**, in this order: (1) `/api/:path*` → `https://<render-service>.onrender.com/api/:path*`, then
  (2) `/((?!api/).*)` → `/index.html` so deep links such as `/login`, `/invoices`, `/p/<token>`,
  `/accept-invitation/<token>`, `/reset-password/<token>` and `/verify-email/<token>` work on refresh. The API rule
  is first and the fallback excludes `/api`, so an API call can never be answered with the HTML page;
* **headers**: `Cache-Control: no-store` (plus the CDN variants) on every `/api/*` response, so sessions, business
  data and public payment status are never cached by Vercel; and security headers for the app (CSP without inline or
  foreign scripts, `connect-src 'self'`, no framing, `nosniff`, no-referrer, HSTS).

Vercel's `vercel.json` cannot read environment variables, so the Render address is committed as a normal (public)
hostname: run

```bash
node scripts/set-render-url.mjs https://<render-service>.onrender.com
```

then commit the change. Until you do, the build **fails on purpose** at `scripts/check-vercel-config.mjs` with a
message saying the placeholder is still there.

### Vercel environment variables

| Variable | Required | Notes |
| --- | --- | --- |
| *(none required)* | | `VITE_API_MODE` and `VITE_API_BASE_URL` come from `vercel.json` |
| `VITE_PUBLIC_PAYMENT_BASE_URL` | recommended | `https://<vercel-domain>`: the base of the customer payment links printed in QR codes. Public value. Without it the QR codes show the illustrative default `https://pay.oupay.rw` |

Never put a secret in a `VITE_*` variable: everything with that prefix is compiled into the public JavaScript. No
backend credential is needed by the frontend at all.

Preview deployments (other `*.vercel.app` addresses) are **not** in `OUPAY_ALLOWED_ORIGINS`, so state-changing calls
from a preview URL are refused (403). Test on the production domain, or add the specific preview origin on purpose.

## 4. Why cookies and CSRF work through the proxy (and what you must configure)

The proxy does not make Origin handling automatic, so each piece was checked:

| Concern | Behaviour |
| --- | --- |
| Session cookie | `__Host-oupay_session`: `HttpOnly; Secure; Path=/; SameSite=Lax`, **no Domain**. The browser accepts `__Host-` cookies only with exactly that shape, and it is stored for the host the browser talks to: the Vercel domain. Vercel passes `Set-Cookie` back to the browser. |
| CSRF | double-submit: the `XSRF-TOKEN` cookie (Secure, readable) is echoed by the app in `X-XSRF-TOKEN`; it is stable for the whole session and rotated at sign-in. |
| Origin | the browser sends `Origin: https://<vercel-domain>`, but the backend sees its own `Host` (Render). The Origin check therefore needs `OUPAY_ALLOWED_ORIGINS=https://<vercel-domain>`. A foreign Origin is refused even with a valid token. |
| HTTPS | TLS ends at Vercel and Render. Cookie flags and HSTS come from configuration, not from the request scheme, so they are correct behind a TLS-terminating proxy. |
| CORS | none. The browser never makes a cross-origin call, so no `Access-Control-*` header is ever sent (never a wildcard with credentials). |
| Forwarded headers | ignored unless `OUPAY_TRUSTED_PROXIES` lists the sending proxy (see section 2). |

Proof in the repository: `backend/.../security/ProxyArchitectureIT` (login, authenticated read, CSRF writes, logout,
idle and absolute expiry, no CORS, no caching, with the production cookie settings and a foreign Host),
`ProxyWithoutAllowedOriginIT` (fails closed when the variable is missing), and `scripts/verify-staging-proxy.mjs`
(drives a packaged jar through a Vercel-like proxy with a browser-like cookie jar).

## 5. Verify the deployment

### 5.1 Flyway migrations

* Render → **Logs**: look for `Successfully applied 5 migrations to schema "public"` (first start) or
  `Schema "public" is up to date` (later starts). Database credentials are never logged.
* Neon → **SQL Editor**:

```sql
select installed_rank, version, description, success from flyway_schema_history order by installed_rank;
-- expect versions 1, 2, 3, 4, 5, all success = true
select count(*) from pg_trigger where not tgisinternal;   -- 12 or more: the ledger and audit guards
```

### 5.2 Health

```bash
curl -s https://<render-service>.onrender.com/actuator/health/readiness     # {"status":"UP"}
curl -s https://<vercel-domain>/api/v1/auth/session -o /dev/null -w "%{http_code}\n"   # 204: the proxy reaches the backend
curl -s -o /dev/null -w "%{http_code}\n" https://<render-service>.onrender.com/actuator/metrics   # not 200
curl -s -o /dev/null -w "%{http_code}\n" https://<render-service>.onrender.com/v3/api-docs        # not 200
```

### 5.3 Test login and CSRF behind the proxy

Always use the **Vercel** domain. With a throw-away account on a made-up address (`@example.test`; never a real
person's address):

```bash
V=https://<vercel-domain>; J=$(mktemp)
# 1. CSRF cookie
curl -s -c $J -b $J $V/api/v1/auth/session -o /dev/null
X=$(grep XSRF-TOKEN $J | awk '{print $7}')
# 2. register (this also signs in)
curl -s -c $J -b $J -H "Origin: $V" -H "X-XSRF-TOKEN: $X" -H 'Content-Type: application/json' \
  -d '{"fullName":"Staging Tester","email":"tester@example.test","phoneNumber":"","password":"<choose-a-password>"}' $V/api/v1/auth/register -w "\nregister %{http_code}\n"
grep -E "__Host-oupay_session|XSRF" $J            # both present, "#HttpOnly_" in front of the session cookie
# 3. authenticated read
curl -s -b $J $V/api/v1/auth/session -w "\nsession %{http_code}\n"            # 200 with the user
# 4. write WITHOUT the CSRF header must be refused
curl -s -b $J -H "Origin: $V" -X POST $V/api/v1/auth/email-verification/request -w "no csrf: %{http_code}\n"   # 403
# 5. write from a foreign origin must be refused even with a token
X=$(grep XSRF-TOKEN $J | awk '{print $7}')
curl -s -b $J -H "Origin: https://evil.example" -H "X-XSRF-TOKEN: $X" -X POST $V/api/v1/auth/email-verification/request -w "foreign origin: %{http_code}\n"   # 403
```

(The CSRF cookie is re-issued on the first request after sign-in; if `$X` is empty, repeat step 1.)

In the browser (DevTools): **Application → Cookies → `https://<vercel-domain>`** shows `__Host-oupay_session`
(HttpOnly, Secure, SameSite Lax) and `XSRF-TOKEN`; **Network** shows only same-origin `/api/v1/...` calls, no
preflight (`OPTIONS`) calls, an `X-Request-Id` on every response, and a `403` if you replay a write without
`X-XSRF-TOKEN`. Sign out and confirm the cookie disappears and a replayed request returns 401. Sign in on a second
browser, reset the password from the first, and confirm the second browser is signed out.

Automated version of the same checks against any base URL:

```bash
BACKEND_URL=https://<vercel-domain> FRONTEND_ORIGIN=https://<vercel-domain> node scripts/verify-staging-proxy.mjs
```

(When pointed at the Vercel domain this exercises the real rewrite; it registers one throw-away `@example.test` user.)

### 5.4 E-mail links

Verification, reset and invitation links are built from `OUPAY_APP_BASE_URL`, so they open on the Vercel domain
(`/verify-email/<token>`, `/reset-password/<token>`, `/accept-invitation/<token>`). Staging uses a real SMTP **sandbox**
(a service that captures mail in a private inbox: your SMTP provider's test mode), so the messages, and the
one-time links in them, are visible only to you and never reach a real person. Use `@example.test` addresses.
The in-memory development mail sink and its `/api/v1/dev/mail` endpoint are **not available** in this configuration
(production refuses to start with them), which is deliberate: that endpoint would hand every reset link to anyone.

### 5.5 Test customer payment links

1. Register, create a business (onboarding), add a branch, assign yourself to it.
2. **Banking** → link an account with the provider "Equity Bank (simulated)" and a demo reference like `SIM-1234`.
   This is labelled simulated and holds no real banking detail.
3. **Payment links** → create a profile. Note its public token.
4. In a private window (no session) open `https://<vercel-domain>/p/<token>`: the customer page loads, also on a
   hard refresh (SPA fallback). Create a payment request and open it at `/p/<token>/r/<reference>`.
5. DevTools → Network: `GET /api/v1/public/payment-profiles/<token>` returns `Cache-Control: no-store`, sets **no**
   cookie, and contains no internal ids. Reload to see a fresh response every time.
6. The request stays "awaiting payment": confirmation is impossible on staging (section 12).

## 6. Known limitations

* **Payments cannot be confirmed on staging.** The only way to confirm money is a signed event at
  `POST /api/v1/integrations/{provider}/events`. For the simulator that endpoint answers 404 in production mode and
  there is no real provider. This is intentional: a trusted bank-event endpoint must not be public. Reconciliation,
  settlement and the ledger are verified by the automated database tests (`mvn verify`), not on staging. A secured,
  staging-only simulator (for example behind a separate secret and an IP allow-list) would be a separate, explicit
  decision.
* **Rate limiting** is per process and keys on proxy addresses (section 2). Raise the limits; do not rely on them.
* **Cold starts.** Render free/idle instances and Neon computes sleep. The first request can take tens of seconds,
  and Vercel's proxy may answer **504** before Render is up. Retry, or use an always-on Render instance.
* **Memory.** A Spring Boot + Hibernate service is tight in 512 MB. The image sizes the heap from the container
  (70%); watch Render's memory graph and adjust `JAVA_OPTS` or the instance size. This was not measured on Render.
* **Docker was not built locally** (not installed). The image build steps were replicated by hand: package without
  the dev profile, extract the layers, run the launcher with the production profile and the platform `PORT`
  (binds `0.0.0.0`, applies V1–V5 to an empty database, passes the proxy script). The first Render build is the first
  real `docker build`.
* **SIGTERM/graceful shutdown** is configured (`server.shutdown=graceful`, 30 s, JVM is PID 1) but could not be
  exercised on the Windows development machine.
* **Google Fonts** are loaded by the stylesheet from `fonts.googleapis.com` / `fonts.gstatic.com`; the CSP allows
  exactly those two hosts. Self-hosting the font would let you remove them.
* Vercel preview URLs cannot make state-changing calls (not an allowed origin).
* The e-mail dispatcher, housekeeping and rate limiter run inside the one web service. Do not scale to several
  instances without reading `docs/operations.md`.
* Metrics are collected but not exported; use Render's logs (one JSON object per line, with `correlationId`).

## 7. Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Render deploy fails at start with `Unsafe configuration, refusing to start: ...` | read the list: each item names the setting (`oupay.app.base-url` must be https, database URL needs `sslmode=require`, SMTP host missing, …) |
| `Could not resolve placeholder 'OUPAY_SMTP_HOST'` | the variable is not set in Render |
| `FATAL: password authentication failed` / `no pg_hba.conf entry` | wrong role/password, or the URL points at a different project; check `OUPAY_DB_USER`/`OUPAY_DB_PASSWORD`; the URL must include `sslmode=require` |
| `Connection ... timed out` right after idle | Neon waking up: raise `OUPAY_DB_CONNECTION_TIMEOUT_MS` to `15000` or more |
| `FlywayException: Validate failed ... checksum mismatch` | an applied migration file was edited. Never edit V1–V5; restore the file from Git |
| `too many connections` | lower `OUPAY_DB_POOL_MAX`, or use the pooled URL with the settings of section 1 |
| Render health check keeps failing | open the Logs; the service is probably still migrating on first start, or cannot reach Neon. The path must be `/actuator/health/readiness` |
| Login returns **403** `forbidden` through Vercel | `OUPAY_ALLOWED_ORIGINS` is missing or differs from the browser's origin (scheme, host, port; no trailing slash) |
| Login works but you are signed out on the next request | the cookie was not stored: check you are on the Vercel domain over https, and that `__Host-oupay_session` appears in Application → Cookies |
| Every API call returns the HTML page | `vercel.json` rewrites are wrong or the placeholder is still there; the build should have failed |
| `504` from `/api/*` on the first call | Render instance asleep or still starting; retry |
| `429` for ordinary use | raise the `OUPAY_RATE_LIMIT_*` variables (section 2) |
| No e-mail arrives | SMTP settings; look in the Render logs for `email delivery failed`; the sandbox inbox; health shows `DEGRADED` when messages fail permanently |
| Browser console shows CSP violations | a new external resource was added; extend the CSP in `vercel.json` deliberately |
| Links in e-mails point at the wrong host | `OUPAY_APP_BASE_URL` |

Useful: every response has an `X-Request-Id`; search that value in the Render logs to see all lines of the request.

## 8. Rollback

* **Render:** Dashboard → the service → **Events/Deploys** → select the last good deploy → **Rollback**. Turn
  Auto-Deploy off while investigating.
* **Vercel:** Deployments → the last good deployment → **Promote to Production** (instant rollback).
* **Database:** Flyway is **forward-only**: there are no down-migrations. Before any deploy that contains a new
  migration, create a **Neon branch** (a copy-on-write snapshot) of the staging database, or note the time for
  point-in-time restore. To roll back a bad migration, restore that branch or time in Neon and point
  `OUPAY_DB_URL` at it, then roll the application back. Migrations after V5 must be written so that the previous
  application version still works against them (add first, remove later).
* Configuration changes in Render take effect on the next deploy; revert the variable and redeploy.
* The backup scripts in `backend/scripts` (`backup-db.sh`, `restore-verify.sh`) work against Neon with the direct
  connection settings (`PGHOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGSSLMODE=require`) and a role that may
  create databases for the restore check (use a **separate scratch Neon project** for that, never staging itself).

## 9. Secrets checklist

| Secret | Where it lives | Who creates it |
| --- | --- | --- |
| Neon role password | Render env `OUPAY_DB_PASSWORD` (and `OUPAY_FLYWAY_DB_PASSWORD` if separate) | you, in Neon |
| SMTP credentials | Render env `OUPAY_SMTP_USER`, `OUPAY_SMTP_PASSWORD` | you, at your SMTP provider |
| GitHub access | Render/Vercel GitHub integration | you |
| Anything else | **nothing**: no JWT/session key, no simulator secret, no bank credential exists |

Never commit `.env` files (they are git-ignored) or paste any of these into an issue, chat or log.
