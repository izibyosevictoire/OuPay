# OuPay backend foundation (Milestone 9)

A **modular monolith**: one Spring Boot application, one PostgreSQL database, no microservices, no
message broker, no Kubernetes. Java 21, Spring Boot 4.1, Spring Security 7, Spring Data JPA
(Hibernate 7), Flyway, Bean Validation, springdoc OpenAPI, JUnit 5 + Testcontainers.

> Banking: **nothing here talks to Equity Bank.** The only provider is a clearly labelled simulator
> for local development. No Equity endpoint, payload, field name, signature or credential was invented.
> See [bank-integration.md](bank-integration.md) for the open questions.

## 1. Structure

```
backend/
  pom.xml                       Maven; -Xlint:all -Werror; SpotBugs on `verify`
  compose.yaml                  PostgreSQL only, for local development
  scripts/start-test-postgres.sh  throwaway PostgreSQL for tests when Docker is unavailable
  scripts/backup-db.sh, restore-verify.sh   backup and PROVEN restore (see operations.md)
  src/main/resources/db/migration/   V1..V8 Flyway migrations (the schema's only owner)
  src/main/java/rw/oupay/
    common/        ApiException, one error shape, secure tokens, keyset pagination, startup safety check, housekeeping
    user/          User entity (no role: roles live on memberships)
    auth/          sessions, Argon2id passwords, lockout, CSRF/Origin checks, rate limiting, trusted-proxy client IP,
                   password reset/change, e-mail verification, correlation ids, security config
    membership/    roles, the permission matrix, MerchantAccess (THE authorisation gate), StaffPolicy
    merchant/      merchants and onboarding
    branch/        branches and branch assignments
    staff/         staff list, role changes, suspend/reactivate/revoke, e-mailed invitations
    email/         provider-independent sender (SMTP, dev sink), transactional outbox, dispatcher, templates
    invoice/       invoices, server-side arithmetic, lifecycle
    banking/       provider adapter SPI, simulated provider, connections, destinations, webhook boundary
    ledger/        bank transactions, allocations, balance derivation, event processor, reconciliation
    payment/       payment profiles (QR/NFC), payment requests, the anonymous public API
    notification/  routed, de-duplicated in-app notifications
    dashboard/     figures derived from the same ledger
    audit/         append-only audit log
```

Boundaries: controllers hold no logic and touch no repository; every service authorises through
`MerchantAccess` itself; only `ledger` can change allocations; only `banking.ProviderWebhookController`
can reach the event processor. `ArchitectureTest` enforces these by scanning the source.

## 2. Database

Normalised PostgreSQL, one migration per area:

| Migration | Contents |
| --- | --- |
| V1 | `users`, `auth_sessions`, `merchants`, `memberships`, `branches`, `branch_assignments` |
| V2 | `invoices`, `invoice_items`, `invoice_number_sequences` + lifecycle/immutability triggers |
| V3 | `bank_connections`, `payment_destinations`, `payment_profiles`, `payment_requests`, `bank_events`, `bank_transactions`, `payment_allocations` + financial triggers |
| V4 | `notifications`, `audit_log` (append-only) |

Conventions:

* **Money:** whole RWF in `BIGINT` columns named `*_rwf`. RWF has exponent 0 (no minor unit in
  everyday use). No float, no decimal, anywhere (a test scans the schema and the source).
* **Merchant ownership and isolation:** every business table has `merchant_id`. Cross-table references
  use **composite foreign keys** `(id, merchant_id)`, so the database itself refuses a record that
  points into another business (an invoice cannot use another business's branch, an allocation cannot
  join one business's money to another's invoice).
* **Uniqueness:** `(provider, provider_transaction_id)`, `(provider, provider_event_id)`,
  `(merchant, invoice_number)`, public token, public reference, one live link per provider account,
  one live link per merchant and provider, one notification per recipient and event, email (case-insensitive).
* **Explicit transitions** are enforced twice (service and trigger): invoice DRAFT→ISSUED|CANCELLED,
  ISSUED→VOIDED; bank transaction PENDING→CONFIRMED|FAILED|REVERSED, CONFIRMED→REVERSED, never back, never
  backwards in provider time; allocation ACTIVE→REVERSED only.
* **Audit fields:** `created_at`, `updated_at`, optimistic `version`, actor ids; `audit_log` and raw
  `bank_events` are append-only (updates and deletes are refused by triggers).

## 3. Authentication and sessions

* **Passwords:** Argon2id (`DelegatingPasswordEncoder`, hashes carry their algorithm id and are upgraded
  on login). Policy: 8–128 characters, a letter and a digit, not the email. Unknown accounts burn equal
  time and get the same answer as a wrong password (no account probing).
* **Lockout:** 5 failures lock the account for 15 minutes (the lock applies even to the right password).
* **Sessions:** a random 256-bit value in an **HttpOnly, SameSite=Lax** cookie (`Secure` outside dev),
  stored **hashed (SHA-256)** server-side. Idle timeout 30 minutes (sliding), absolute 12 hours;
  "remember me" 7 days idle / 30 days absolute. Logout revokes the session on the server, so a copied
  cookie dies with it. A suspended user, or a suspended membership, loses access on the next request.
* **CSRF:** double-submit (`XSRF-TOKEN` cookie echoed in `X-XSRF-TOKEN`). The cookie-less surfaces
  (public API, provider webhooks) are exempt and never receive a cookie.
* **Nothing long-lived is ever given to JavaScript or localStorage.**
* Headers: CSP `default-src 'none'`, `nosniff`, no-referrer, frame denial, HSTS.
* **Password reset** (Milestone 10): `POST /auth/password-reset/request|verify|confirm`. The request answers 204 for any
  address (no enumeration); the link is single-use, expires in 1 hour, is stored hashed, and a new request retires
  the old link. At most 3 links per account and purpose per hour (mail-bombing bound). A weak password does not
  burn the link. Completing a reset signs out **every** device, lifts a lockout, marks the address verified
  (the mailbox received the link) and e-mails the owner. The token travels in a POST body, never in a URL.
* **Password change** (`POST /auth/password/change`): needs the current password (wrong guesses count toward
  the lockout, answered 422 so the SPA does not mistake it for a lost session), signs out every OTHER device.
* **E-mail verification:** a link is queued at registration (`POST /auth/email-verification/request|confirm`);
  it verifies only the address it was sent to. Unverified accounts can sign in (verification is a recovery
  and trust signal, not a gate). Accepting an invitation or completing a reset also verifies the address.
* Not built: MFA, breached-password checks, session listing in the API.

## 4. Authorisation

`MerchantAccess.require(merchantId, permission)` is the first line of every service method that touches
business data (not the controller): not signed in → 401; no ACTIVE membership in that business (or no such
business) → **404**, indistinguishable from "does not exist"; member without the permission → 403.
Record-level scope (a cashier sees only invoices assigned to them, and only transactions applied to those
invoices) is applied **inside the queries**. `ApiSecurityIT` walks the live route table so a new endpoint
is automatically checked for anonymous access and cross-business leakage.

Roles: OWNER, MANAGER, CASHIER. The matrix mirrors the frontend's `PERMISSION_DEFINITIONS`
(`Permission.java`, verified by `PermissionTest`).

## 5. API

Base path `/api/v1`. OpenAPI at `/v3/api-docs` and `/swagger-ui.html` (disabled by the `prod` profile).
Errors are always `{ "code", "message", "fields" }` with the stable codes the frontend contracts use.

| Area | Endpoints |
| --- | --- |
| Auth | `POST /auth/register`, `POST /auth/login`, `GET /auth/session` (204 when signed out), `POST /auth/logout`, `POST /auth/password-reset/request|verify|confirm`, `POST /auth/password/change`, `POST /auth/email-verification/request|confirm` |
| Merchants | `POST /merchants`, `GET /merchants`, `GET/PUT /merchants/{id}` |
| Settings (operating mode) | `GET/PUT /merchants/{m}/settings` (read: any member; change: owner, with `expectedVersion`) |
| Branches | `GET/POST /merchants/{m}/branches`, `GET/PUT …/{id}`, `PUT …/{id}/status`, `GET …/branch-assignments`, `PUT /merchants/{m}/memberships/{id}/branch-assignments` |
| Staff | `GET …/staff`, `PUT …/memberships/{id}/role`, `POST …/memberships/{id}/suspend|reactivate|revoke`, `GET/POST …/invitations`, `POST /invitations/{token}/accept` |
| Invoices | `GET/POST …/invoices`, `GET …/invoices/{id}`, `GET …/invoices/form-options`, `PUT …/{id}?expectedVersion`, `POST …/{id}/issue|cancel|void?expectedVersion` |
| Banking | `GET /banking/providers`, `GET/POST …/bank-connections`, `POST …/bank-connections/{id}/complete|disable`, `GET …/payment-destinations` |
| Ledger | `GET …/bank-transactions` (paged), `GET …/bank-transactions/{id}`, `GET …/payment-allocations` (paged), `GET …/payable-invoices`, `POST …/reconciliation/allocations`, `POST …/reconciliation/allocations/{id}/reverse`, `POST …/bank-transactions/{id}/review` |
| Simplified checkout | `GET …/checkout/simple/options`, `POST …/checkout/simple` (requires `Idempotency-Key`; see [simplified-checkout.md](simplified-checkout.md)) |
| Payment links | `GET/POST …/payment-profiles`, `GET …/{id}`, `GET …/form-options`, `PUT …/{id}/active`, `POST …/{id}/reissue`, `POST/GET …/invoices/{id}/payment-requests`, `POST …/payment-requests/{id}/cancel` |
| Notifications | `GET …/notifications` (paged), `POST …/notifications/{id}/read`, `POST …/notifications/read-all` |
| Dashboard | `GET …/dashboard/summary|recent-transactions|daily-payment-activity|provider-breakdown` |
| Audit | `GET …/audit-log` (owners, managers; paged) |
| **Public (anonymous)** | `GET /public/invitations/{token}`, `GET /public/payment-profiles/{token}`, `POST …/{token}/requests`, `GET …/{token}/requests/{reference}`, `POST …/instructions-opened`, `POST …/claim` |
| **Provider boundary** | `POST /integrations/{provider}/events` (signature required) |
| Operations | `GET /actuator/health`, `/actuator/health/liveness`, `/actuator/health/readiness` (status only); `GET /dev/mail` (development sink only) |

**Pagination.** Invoices, bank transactions, payment allocations, notifications and the audit log are
server-paged: `?limit=` (default 50, max 200) and `?cursor=`, answered as `{ items, nextCursor, totalCount? }`.
Paging is keyset ("seek") over a **total order** (sort column plus id), so no row is skipped or repeated
even when many rows share a timestamp or new rows arrive while someone is paging; cursors are opaque and a
malformed one is a 400. Cashier scoping is applied in the query, so pages and totals never leak other
people's records. The frontend HTTP services follow the cursor, so UI behaviour is unchanged.

There is **no** endpoint that creates a bank transaction, confirms a payment or marks an invoice paid,
for any role, public or authenticated. `LedgerIT.thereIsNoMerchantApiThatCreatesOrConfirmsATransaction`
and `PublicPaymentIT.thePublicCallerCannotForgeABankConfirmation` prove it.

## 6. Financial consistency guarantees

All inside **one database transaction per operation**, with row locks in a fixed order
(**bank transaction first, then invoices in id order**), so nothing deadlocks and nothing double-allocates.

1. **Invoice balance is derived**, never stored: `remaining = total − Σ ACTIVE allocations`. The status is
   derived the same way. A reversal restores the balance.
2. **Idempotent ingestion:** the unique `(provider, event id)` index makes "seen before" a database fact;
   concurrent deliveries serialise on it. A re-delivery under a new event id is stopped by
   `(provider, provider transaction id)`. Raw events are stored immutably before processing.
3. **Ordering:** a status change applies only if newer in provider time and a legal transition; stale events
   are recorded and ignored (a late "confirmed" never undoes a newer "reversed").
4. **Exact reference only.** Never by amount, time, payer name or branch. No reference → unmatched.
5. **No overpayment:** at most the remaining balance is applied; the rest is flagged for a human.
6. **Manual reconciliation** needs `payments:reconcile`, quotes the transaction `version` and each invoice's
   expected remaining balance (optimistic locking), validates every line before applying any, and is atomic.
7. **Defence in depth in PostgreSQL:** triggers re-check, under their own row locks, that an allocation is
   ≤ the unapplied money and ≤ the invoice's remaining balance, that money is CONFIRMED and the invoice
   ISSUED, and a **deferred constraint** refuses to commit a non-confirmed transaction that still carries
   active allocations. `DatabaseGuaranteesIT` attacks these with raw SQL.
8. **Concurrency is tested for real** (`ConcurrencyIT`): 8 simultaneous payments for one invoice, one event
   delivered 12 times at once, two people allocating the last balance, a payment racing a void, a reversal
   racing a manual allocation, and a mixed storm, each followed by global invariant checks.

HTTP idempotency keys, the retry policy and how database errors reach API responses are described in [idempotency.md](idempotency.md). The HTTP key table is a 30-day replay cache; permanent duplicate protection always lives on the business rows.

## 7. Banking integration boundary

* `BankingProviderAdapter` is provider-neutral. Optional operations are **separate interfaces**
  (`AccountLinkingCapable`, `EventAuthenticating`); callers must check `instanceof` and the capability.
* `POST /integrations/{provider}/events` is the only door: unknown provider 404, provider without an adapter
  (real Equity, MTN, Airtel) **501**, an adapter that cannot authenticate events is never exposed, the event
  must verify **before** it is parsed (constant-time HMAC for the simulator), bad payloads are 400, and
  oversized payloads 413. Not covered by CSRF (no cookies), rate limited.
* **Replay handling (Milestone 10).** The simulator's stand-in signature is `t=<epoch>,v1=<hmac(t.body)>`:
  the timestamp is inside the MAC and must be within 5 minutes, so a captured request cannot be replayed later.
  Inside the window, repeats are absorbed by the idempotency keys (`(provider, event id)` and
  `(provider, transaction id)`) and reported as DUPLICATE. A repeated event id with **different content**
  is ignored, audited (`REPLAY_PAYLOAD_MISMATCH`) and counted (`oupay.bank.events.payload_mismatch`).
* **Sensitive event data.** The copy kept in `bank_events` is **redacted** before it is written (names reduced
  to an initial, account/phone numbers to the last four digits); the SHA-256 of the original is stored for
  integrity. The ledger needs only the normalised fields, which live in typed columns. Payloads are never logged.
* The **simulated** provider uses an *invented* format marked `"simulated": true`, a shared secret that has
  **no default** and is configured only in the `dev`/`test` profiles. In any other environment it answers 404.
* Open questions for the real bank are in [bank-integration.md](bank-integration.md); every real-provider
  capability is `UNCONFIRMED`.

## 8. Public payment API

Minimal by construction (`PublicPaymentService` cannot even see the ledger or invoice repositories, and a test
checks that): merchant display name, optional branch and cashier first name + initial, a verified flag that is
true only for a really verified business, amount, reference, request-specific stage, generic instructions
(no USSD, deep links or credential requests). Dead, revoked, suspended or disconnected links return a view that
names nothing. Controls: strict token/reference formats (malformed input never reaches the database), per-IP rate
limiting (reads and a stricter write limit), a per-link cap on requests per hour, `Cache-Control: no-store`,
one claim endpoint that is explicitly **only a claim**. There is no list, search or history endpoint.

## 9. Implemented versus pending

| Module | State |
| --- | --- |
| Authentication, sessions, authorisation | **Implemented** (password reset, change, e-mail verification; MFA: pending) |
| Users and memberships | **Implemented** (staff invitations, last-owner protection) |
| Merchants and onboarding | **Implemented** (back-office verification: not built) |
| Branches and assignments | **Implemented** |
| Invoicing | **Implemented** (PDF/fiscal documents, credit notes: pending) |
| Bank accounts and integrations | **Implemented for the simulator**; real providers: contract only |
| Bank transaction ingestion | **Implemented** (simulated provider) |
| Reconciliation and allocations | **Implemented** (refunds: model only, no endpoint) |
| Payment links and requests | **Implemented** (server side; QR/NFC rendering stays in the frontend) |
| Notifications | **Implemented** (in-app; SMS/push: pending) |
| E-mail | **Implemented** (provider-independent, SMTP + dev sink, outbox with retries; account and invitation mail only) |
| Audit logging | **Implemented** (read endpoint for owners/managers) |
| Reports, settings, back office | Not started |

## 10. Running and testing

```bash
# 1. PostgreSQL (Docker) ...
docker compose -f backend/compose.yaml up -d
# ... or, without Docker, a throwaway local cluster used by the tests:
PG_BIN="/c/Program Files/PostgreSQL/18/bin" backend/scripts/start-test-postgres.sh

# 2. Run the API with the dev profile (simulated provider ON, cookies not Secure)
cd backend
OUPAY_DB_URL=jdbc:postgresql://localhost:5432/oupay OUPAY_DB_USER=oupay OUPAY_DB_PASSWORD=oupay \
  mvn spring-boot:run -Dspring-boot.run.profiles=dev

# Read the e-mails the dev sink captured (password-reset and invitation links):
curl http://localhost:8080/api/v1/dev/mail

# 3. Tests: unit + database integration + concurrency + security + SpotBugs
mvn verify                                    # starts a PostgreSQL Testcontainer (needs Docker), or:
OUPAY_TEST_DB_URL=jdbc:postgresql://localhost:55432/oupay_test mvn verify
```

The integration tests **always use real PostgreSQL**; they never use H2 or mocks for the database.

## 11. Frontend integration (demo mode and server mode)

The frontend's service contracts were left untouched. `src/services/http/` adds HTTP-backed
implementations of every contract, selected in **one place** (`src/services/index.ts`):

| | Demo mode (default) | Server mode |
| --- | --- | --- |
| Switch | `VITE_API_MODE` unset or `mock` | `VITE_API_MODE=http` |
| Data | in-browser mock services and storage | the backend over `credentials: 'include'` |
| Session | mock session in browser storage | server HttpOnly cookie; **nothing in storage** |
| Mock graph | constructed | **never constructed** (no mock data read, written or shown) |
| Demo tools | bank simulator page and buttons (dev builds) | removed (`DEMO_TOOLS_BUILD` is false) |
| Account recovery and invitations | simulated links (no e-mail) | real: e-mailed single-use links; the server never returns a token to a browser |
| Lists | whole lists | the HTTP services follow server pagination cursors |

Existing mock data and mock services were not deleted or changed. Run the dev server proxied to the API:

```bash
VITE_API_MODE=http npm run dev          # /api is proxied to http://localhost:8080 (VITE_API_PROXY_TARGET)
```

A **live contract test** runs the frontend's real HTTP services against a running backend
(register → business → branch → invoice → link → request → signed bank event → settlement → isolation → logout):

```bash
OUPAY_BACKEND_URL=http://localhost:8080 npx vitest run src/services/http/backendContract.test.ts
```

## 12. Security limitations (read before deploying)

See [operations.md](operations.md) for the production checklist and [security-review.md](security-review.md) for the
Milestone 10 review. Known limitations:

* The rate limiter is **per process** (so the effective limit is multiplied by the instance count). The client
  address comes from `ClientIpResolver`: `X-Forwarded-For` is believed ONLY from proxies listed in
  `oupay.security.proxy.trusted`, read from the right. Repeat limits at the edge, or move to a shared store.
  Per-account protections (lockout, reset-link budget) live in the database and are exact across instances.
* Registration answers `email_taken` for a registered address (the sign-up form needs it). Everything else that
  takes an address (login, password reset) is enumeration-resistant. Rate limits bound probing.
* No MFA or breached-password check yet. Session listing/"sign out everywhere" is not exposed in the API
  (the service supports it; a reset or change uses it).
* Public pages have no bot challenge. Tokens are unguessable but are public identifiers; enumeration attempts are
  limited by rate limits, not detected.
* The `dev` profile has a development-only simulator secret and non-Secure cookies: never deploy it.
* No encryption at rest, field-level encryption or key management beyond what the database provides. Provider
  events are stored redacted; backups contain personal data and must be encrypted and access controlled.
* The dashboard aggregates are still computed in memory over a business's transactions (the lists are paged,
  the dashboard is not); move them to SQL aggregates before businesses reach very large volumes.
* Timestamps in the payment APIs are UTC instants; Kigali-day bucketing is done only for the dashboard.
* Metrics are collected (Micrometer) but not exported: no Prometheus/OTLP registry and no alerting rules ship
  with the application. There is no Docker image, CI pipeline or migration rollback plan (Flyway is forward-only;
  restore from backup).

## 13. Next steps

1. Obtain the bank's integration documentation, sandbox and approval; build the real adapter behind the same SPI.
2. Notification e-mail and SMS (the outbox and templates are ready for it).
3. Filtering and indexes tuned on real volumes; SQL read models for the dashboard.
4. Refund and credit-note flows; fiscal (EBM) documents.
5. Edge rate limiting, bot protection for public pages, structured audit export, retention policy.
6. Operations: Docker image, CI pipeline running `mvn verify` with Testcontainers, metrics export and alerts,
   scheduled backups wired to real storage.
7. Back office for merchant verification; reports.
