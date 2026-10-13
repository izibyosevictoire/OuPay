# Milestone 10 security review

Scope: authentication, sessions, CSRF, cookies, authorisation, the public and provider surfaces, e-mailed links.
Method: read the code paths, then write tests that fail if the property is lost. Test names are in brackets.

## Findings that were fixed

| # | Finding | Impact | Fix and proof |
| --- | --- | --- | --- |
| 1 | **Stale entities after a locking read.** Hibernate keeps an already-loaded entity unchanged when a `PESSIMISTIC_WRITE` query returns it, so state read before the lock could be used after another transaction changed it. | Two owners demoting each other at the same moment could both pass the "another owner exists" check and leave a business without an owner; a just-suspended actor could finish an action. | `MembershipLocks.lockAll` takes the lock and refreshes every row; actors are re-validated after the lock. [`MembershipLocksIT`, `InvitationIT.twoOwnersDemotingEachOther…`] |
| 2 | Rate limiting trusted only the TCP peer, so behind a proxy every user shared one bucket (or, if someone enabled forwarded headers naively, any client could choose its own). | Lockout of everyone, or no limit at all. | `ClientIpResolver`: `X-Forwarded-For` is read only from configured trusted proxies, from the right. [`ClientIpResolverTest`, `RateLimitHardeningIT`, `TrustedProxyRateLimitIT`] |
| 3 | No limit on the account-recovery endpoints; reset links could be requested without bound. | Mail bombing, token guessing. | Own `recovery` bucket plus a per-account budget of 3 links per hour. [`AccountRecoveryIT.aSingleAccountCannotBeMailBombed`] |
| 4 | Provider webhook signatures had no freshness. | A captured genuine request could be replayed indefinitely (idempotency hid the effect, but not a changed event id). | Timestamp inside the MAC, 5-minute tolerance; replay with different content is audited and counted. [`WebhookReplayIT`, `SimulatedProviderAdapterTest`] |
| 5 | Raw provider payloads (payer names, account numbers) were stored verbatim, forever. | Personal data in an append-only table. | Redacted before storage; hash of the original kept. [`WebhookReplayIT.storedEventsHoldNoPersonalData…`] |
| 6 | HSTS was only emitted when the request arrived over HTTPS, which behind a TLS-terminating proxy is never. | No HSTS in the usual deployment. | Always sent when the cookie is Secure. [`ProductionLikeConfigIT`] |
| 7 | An invited placeholder (no password) answered `login` faster than a wrong password. | Timing reveals who has a pending invitation. | `PasswordService.matches` burns equal time for a missing hash. |
| 8 | The reset-token verification contract was a `GET` with the token in the query string. | Tokens in access logs, browser history and `Referer`. | `POST` with a body; access logs record route patterns only. [`ObservabilityIT`] |
| 9 | The mail health contributor would mark the whole service DOWN on an SMTP outage. | A mail outage would take invoicing out of rotation. | Disabled; the outbox indicator reports DEGRADED (HTTP 200) and is not part of readiness. [`EmailOutboxIT`, `SecurityHardeningIT`] |
| 10 | Dependencies with published advisories: Tomcat 11.0.24 (three critical), Jackson 3.1.5 / 2.21.5 (five high or moderate each), BouncyCastle 1.82 (five). | Known vulnerabilities in the request path. | Patch-level overrides in `pom.xml`; OSV scan of all 118 runtime artifacts now reports 0 advisories. |

## Found during final acceptance (browser end-to-end and live probes)

| # | Severity | Finding | Fix and proof |
| --- | --- | --- | --- |
| 11 | Medium | **The CSRF cookie flipped between set and cleared on every signed-in request** (Spring's default session strategy treats every request authenticated by our own filter as a new login). Parallel browser requests could carry a stale token and get 403. | The strategy is now a no-op and the token is rotated explicitly at sign-in. [`CsrfCookieStabilityIT`] |
| 12 | Medium | **Account existence leaked through lockout:** a locked account answered `403 account_unavailable`, an unknown address `401`. Five wrong passwords revealed whether an address is registered. | A locked account now answers exactly like an unknown one. [`AuthenticationIT.repeatedFailuresLock…`] |
| 13 | Low | Password-reset requests for registered addresses were measurably slower than for unknown ones. | Every answer is padded to a 200 ms floor (measured 205.9 ms vs 207.1 ms live). [`AccountRecoveryIT.knownAndUnknownAddresses…`] |
| 14 | Medium (functional) | When the server ended a session mid-use (expiry, reset, revoke) the SPA kept showing a page whose requests all failed. | A 401 from a business endpoint now returns the user to sign-in with the session-expired notice. [`sessionLost.test.ts`, browser-verified] |
| 15 | Medium (functional) | Registering through an invitation link then called accept again; the link is single-use, so a valid sign-up ended in an error message. | Server mode skips the second call. [browser-verified] |
| 16 | Low | Server mode still showed demo-mode notices (sample-data banner, demo accounts and their password on the login page, demo invitation note) and called an expired invitation "cancelled". | Notices hidden in server mode; expired invitations say so. [browser-verified] |

## Properties verified and kept

* **Sessions:** opaque 256-bit value, `HttpOnly`, `SameSite=Lax`, `Secure` and `__Host-` prefixed in production,
  stored only as SHA-256, revoked on logout, password reset (all) and password change (all others).
  [`SecurityHardeningIT.theSessionCookie…`, `ProductionLikeConfigIT`, `AccountRecoveryIT`]
* **CSRF:** double-submit token on every state-changing cookie-authenticated call, including the new endpoints
  and the public recovery endpoints (login CSRF). A request whose `Origin` names another site is refused even with
  a valid token. [`SecurityHardeningIT.theNewStateChangingEndpoints…`, `…aStateChangingRequestFromAnotherSite…`]
* **Authorisation:** every merchant-scoped service authorises itself; `ApiSecurityIT` walks the live route table, so
  new endpoints (invitations, recovery, dev mail) are automatically checked for anonymous access and for leakage to
  another business's members.
* **Public exposure:** the anonymous surface is spelled out in `ApiSecurityIT.theRouteTableIsWhatWeThinkItIs`.
  Milestone 10 adds exactly: `GET /public/invitations/{token}` (holder of the link only; reveals the invitee's own
  address, role and business name), the recovery endpoints (generic answers), `POST /auth/email-verification/confirm`
  and, in development only, `GET /dev/mail`. The management surface is the three health probes, status only.
* **Tokens:** reset, verification and invitation links are 256-bit, stored hashed, single-use (one conditional
  `UPDATE`, race-tested), expiring, and never returned by an API or written to a log or audit entry.
* **Privilege escalation:** the invitation fixes role and branches; the accepting user cannot change them; managers
  cannot invite managers; nobody can invite an owner; an invitation can only activate its own membership for the
  address it was sent to. [`InvitationIT`]

## Accepted residual risks

* Registration still answers `email_taken` (Low, accepted). The sign-up form needs it; login, lockout and reset do
  not reveal anything. Rate limits bound probing. The complete fix is an e-mail-first sign-up ("we sent you a link"),
  a product decision.
* `inviteeHasActiveAccount` in the invitation preview tells the holder of an invitation link whether the invited
  address already has an account. Only the link holder can see it, and the link was sent to that address.
* The rate limiter is per process (see [operations.md](operations.md)).
* No MFA, no breached-password check, no bot challenge on public pages.
* Unverified e-mail addresses can use the product; verification is a trust signal, not a gate.
