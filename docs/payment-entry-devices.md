# R8a: payment-entry devices (static QR, NFC tag, NFC bracelet)

A **payment-entry device** is a persistent doorway at a counter: a printed QR code, an NFC sticker/card/tag or an NFC bracelet. It carries one
**permanent HTTPS URL** and nothing else. The object never changes between customers; OuPay decides, **server side**, which prepared bill the
doorway currently leads to.

**QR and NFC are entry methods only.** Scanning or tapping opens a bill. It does not move money, create an invoice, create a payment request,
or confirm anything. The customer still pays with the bank-approved **collection code** shown on the bill, and R6d-B evidence-based
reconciliation stays the only authority on whether money arrived. R8a adds no payment rail, no ledger and no inventory change.

## 1. Architecture review: what was reused, and where the brief and the code differ

| Existing piece | Reused how |
| --- | --- |
| R6c/R7b **code sale** (`code_sales`, payment request = sale, `OP-…` reference) | A device is bound to an existing sale. Agent code sales and POS bills are both `code_sales` rows, so one mechanism serves both. The sale keeps its identity and its code-assignment snapshot. |
| `PublicCodeSaleService` (the customer view of a sale) | The bill shown to a customer is this exact view: no agent, no account, no internal id, a bank code only for a LIVE sale, instructions only for LIVE. Its status (`PAID` only when bank money was **applied**) is the one shown. |
| `MerchantAccess` / `Permission`, `AuditService`, `ApiException`, JdbcClient style | New permissions `entry_devices:view / manage / bind`; every write is audited. |
| `/api/v1/public/**` (no cookies, CSRF-exempt, `no-store`, public rate-limit buckets) | The customer endpoints live there. |
| `QrCode`, `describeNdefUriRecord`, NFC guidance | The printable sign and the NFC instructions. |

Differences from the brief, decided deliberately:

* **The resolver is read-only; taking the device is a separate POST.** A QR/NFC URL can be pre-fetched by a phone, a messaging app or a link
  scanner. If opening the URL took the device, a bot could lock customers out. So `GET` only reads; the customer explicitly chooses "Show my bill"
  (`POST …/claim`).
* **The device token is stored as is, not hashed.** The owner must be able to copy and reprint the same URL later, so a hash-only token would make
  the URL unrecoverable. It is a 128-bit opaque **public identifier** (anyone holding the tag can read it), not a credential, and it opens nothing
  by itself. The **claim** token, which *is* a bearer secret of one customer session, is stored only as a SHA-256 hash.
* **The backend does not know the customer-facing domain** (it is frontend configuration, `VITE_PUBLIC_PAYMENT_BASE_URL`, default
  `https://pay.oupay.rw`, *illustrative*). The API returns the permanent path `/e/{token}`; the browser prefixes the domain.
* **Existing payment links (`/p/{token}`, V3) are a different feature** (an open amount the customer chooses) and are untouched.

## 2. Data model (V19, additive; V1–V18 untouched)

| Table | Purpose | Key constraints |
| --- | --- | --- |
| `payment_entry_devices` | The registered doorway: merchant, branch, type (`STATIC_QR`, `NFC_TAG`, `NFC_BRACELET`), opaque `public_token` (22 chars, 128 bits), name, optional cashier, `ACTIVE / SUSPENDED / REVOKED`, `client_request_id`, version | unique token; tenant FK `(branch_id, merchant_id)`; a bracelet requires a cashier; name unique among non-revoked devices; `REVOKED` is final |
| `payment_entry_device_assignments` | Immutable history of every (branch, cashier) a device had, with who changed it and a name snapshot | one open row per device; rows are only ever closed, never rewritten or deleted |
| `payment_entry_bindings` | Which sale a device leads to | **one open binding per device** and **one open binding per sale** (partial unique indexes); FK `(sale_id, merchant_id, branch_id)` to `code_sales` (V19 adds the matching unique key); only closed, never rewritten |
| `payment_entry_claims` | A customer's short-lived session on the bound sale | **one open claim per device** (partial unique index); `claim_token_hash` unique; FK to the binding |

Triggers: a device only at an **active branch**, with a cashier who is an **active member assigned to that branch**; a binding only for an
**ACTIVE** device, a sale of the **device's own branch**, the **device's cashier's** sale, and only while the sale's payment request is neither
cancelled nor expired; a claim only on an open binding of its own sale. At commit: the device's current branch and cashier equal its open
assignment; a closed binding has no open claim; a revoked device has no open binding or claim. No row is ever deleted.

## 3. Device lifecycle

| Act | Who | Effect |
| --- | --- | --- |
| Register | owner; manager only at their own branches | New device, fresh token, opening assignment record. Retried safely by `clientRequestId`. |
| Assign (branch/cashier) | owner / manager (own branches) | Closes the old assignment, opens the new one. An open bill that no longer fits (other branch, or another cashier's sale) is closed as `DEVICE_REASSIGNED`. A customer session in progress needs explicit confirmation. |
| Suspend / reactivate | owner / manager | Suspended: the URL answers "not available" and the device cannot be bound or claimed. Reversible. |
| Revoke | owner / manager | Final. The URL stops working at once; the binding and claim are closed; sales and assignment history stay as they were. |

## 4. The permanent entry URL

`https://<customer domain>/e/{opaqueDeviceToken}`: **the same string** in the QR code and on the NFC tag (a test asserts the QR's
`data-qr-value` equals the displayed link). It never changes while the device is registered and is never regenerated per transaction. It contains
no merchant, branch, cashier, sale, amount, bank or secret value. Revocation disables it server side.

## 5. Binding a bill

An authorised person gives a device **one prepared bill** (`POST …/binding`). Rules enforced by the service **and** the database:
the sale must be open (awaiting payment or partly paid), unexpired, of the device's branch and, when the device has a cashier, that cashier's; a
cashier gives a device only their own sales, a manager only at their own branches; **never a random or newest bill**; one open bill per device and
per sale; a new bill replaces the old one only after the old one is closed: by a person (`Stop opening this bill`), or by the system when its
sale is paid, expired or cancelled. Concurrent binds take turns on the device row; the unique indexes back that up across instances. Every bind and
unbind is audited and recorded in the binding history.

## 6. Customer concurrency: the claim

A new table is necessary: a bill-level token cannot express "one customer at a time **per device**" and could not be enforced by the database.

* `GET /api/v1/public/entry/{token}` **reads only**: `UNAVAILABLE`, `IDLE`, `READY` (a bill is ready; *no amount, reference or code*), `BUSY`
  (*no detail at all*), or, for the holder of a claim, `CLAIMED` / `SESSION_ENDED` with their bill.
* `POST …/claim` takes the device for one customer: locks the device row, ends claims that ran out, and inserts a claim; a partial unique index
  guarantees **at most one open claim per device** whatever the number of backend instances. The claim token is 256 random bits; **only its hash is
  stored**. The browser keeps it in `sessionStorage` and sends it in the `X-Entry-Claim` **header**, never in the URL.
* **A lost answer is recoverable.** The browser *proposes* its own token and stores it in the tab **before** sending the claim. If the answer is
  lost, the same request (or a reload) finds the same claim. The server uses a proposal only when no claim anywhere already has that token, never
  sends it back, and otherwise mints its own (shown once). A token can only open its own claim on its own device: presented at another device, or
  after its claim ended, it opens nothing. Recovery therefore weakens no isolation: another customer, with or without a token, still gets "busy".
* A holder keeps seeing **the bill they claimed**, whatever happens to the device afterwards (cashier moves on, claim expires, bank confirms late).
  Another customer never sees it. After a claim runs out the holder, returning, sees `SESSION_ENDED` with their original bill and its real status.
* **A timeout is not a failed payment.** It only frees the doorway; the bill is untouched, still payable, and reconciliation decides.
* `POST …/release` lets the customer give the device back. The cashier cannot silently cut a session off: closing a bill someone is looking at needs
  an explicit confirmation.
* Claim lifetime: `oupay.entry.claim-ttl` (default 5 minutes), renewed by the holder's own repeated claim.
* **Revocation or suspension while a claim is open:** strangers (and a replayed claim POST) get the one identical "not available" answer; a customer who
  already holds a claim keeps seeing **their own bill, read-only** (`SESSION_ENDED`, reason `DEVICE_REVOKED` / `DEVICE_SUSPENDED`), so a lost tag can
  be revoked without hiding a payment someone is making. The claim is not renewed and nothing is re-opened. Reactivating a suspended device resumes
  an unexpired claim.
* **Another tab:** the token lives in `sessionStorage` (per tab, not shared with other sites, not persisted after the tab closes). A tab opened from
  the same link, without that token, sees "Payment in progress" until the claim is released or runs out; a *duplicated* tab shares the session. This
  is deliberate: a persistent or shared store would expose the secret more widely.

## 7. Public API privacy and security

* One identical `UNAVAILABLE` answer for an unknown, malformed, suspended or revoked token (no enumeration signal); `Cache-Control: no-store`; no cookies.
* The bill is the existing public sale view; a paid or finished bill is **never shown to a stranger** (the device is simply idle).
* LIVE sale: the bank code and instructions. **DEMONSTRATION:** no bank code, an explicit "nothing can be paid" notice. The page invents no USSD
  instruction, collects no PIN/OTP, offers no other payment method and has no payment simulator.
* Public routes sit in the existing `public` rate-limit buckets (reads 120/min, writes 20/min per address) and in the explicit anonymous allow-list test.

## 8. QR and NFC content and hardware constraints

* QR: error-correction level M, black on white, quiet zone included (existing `QrCode`). Content = the permanent URL, ~50 characters.
* NFC: **one** NDEF URI record (type `U`) with exactly that URL (~60 bytes with overhead); NTAG213 (144 bytes) is enough. Lock the tag after writing.
  **The tag UID is never trusted as proof of anything.** OuPay does not write tags and does not provision NFC hardware through a bank.
* Anyone can read or copy a tag: that is why the link opens only a read-only page, why a lost or copied device is **revoked and replaced**, and why a
  second tag cannot take a bill that is not bound to its own device.

## 9. Frontend

`Payment points` (`/entry-devices`, permission `entry_devices:view`): register (type, name, branch, cashier), the permanent link with Copy, printable
QR sign (`/entry-devices/:id/print`), NFC writing instructions, assign, suspend/reactivate/revoke (reason required), the current bill with its
bank-verified status and whether a customer is looking at it, give a bill (from the eligible list), stop opening a bill (with confirmation when a
customer is looking), and the assignment and bill history. A cashier sees only their own and shared devices and none of the management actions.
The customer page `/e/:token` is mobile first and accessible, GET-only until "Show my bill". HTTP and mock services implement one contract
(`EntryDeviceService`, `PublicEntryService`).

## 10. Tests

Backend (`PaymentEntryDeviceIT`, `PaymentEntryClaimIT`, real PostgreSQL, real HTTP API): tokens (format, uniqueness, opacity), registration and
authorization, tenancy, wrong branch/cashier, lifecycle, revocation keeping history, identical unavailable answers, reassignment history, explicit
binding with no fallback, no ledger/invoice/request side effects, concurrent binds, concurrent claims (eight customers, one holder), two customers,
returning holder, expiry while claimed, late bank confirmation, demonstration isolation, privacy (no cookies, `no-store`, no internal data), the
claim secret never stored, database constraints, and the unchanged bank reconciliation. Frontend: HTTP contract, mock rules (with a controllable clock),
management UI, QR/URL equality, public states, and accessibility.

## 11. Risks and Equity dependencies

* **Equity has not confirmed** how a payer uses a merchant code or whether a payment can carry the sale reference; until it does, LIVE collection stays
  disabled and a device can only show a demonstration bill outside the test configuration. R8a changes none of that.
* Deleting a device is impossible by design; a lost tag is revoked.
* The claim and device-write endpoints are rate limited per address; behind a shared proxy the public-write bucket is shared by all customers (see the
  operations notes), so raise `OUPAY_RATE_LIMIT_PUBLIC_WRITE` for a busy counter.
* A customer who loses the claim answer (network) must wait for the claim to run out (5 minutes) or ask the cashier to close it with confirmation.
* Open decisions: the claim lifetime, whether a returned `SESSION_ENDED` customer may re-claim the same bill automatically, and per-branch reporting of
  device use.

## 12. Security review notes

**Device token.** 16 bytes from `SecureRandom` (128 bits), base64url (22 characters); a unit test checks length, 5,000 distinct values, use of the whole
alphabet at every position, and that the generator is not `Random`, a UUID or a clock. It is not derived from any merchant, cashier, branch or sale id
and is not sequential. It is stored **as is** because the owner must be able to copy and reprint the same URL. Security implications, accepted on
purpose: the token is a *public identifier* (it is printed on the tag); anyone with database read access could list the doorways, but a doorway opens
only the *currently bound* bill and only to a customer who explicitly takes it; a leaked or copied tag is handled by revoking the device and
registering a new one (there is no token rotation; replacement is a new device and never touches historical sales). A token grants **no** management
or billing permission: every merchant endpoint requires a session and a permission. Tokens appear in no audit message and in no log line, and the
frontend sends them nowhere but the resolver.

**Public answers.** An unknown, malformed, suspended or revoked token gets one identical answer. Before a claim, a valid device reveals at most the
business display name and whether a bill is ready (never an amount, reference, code or the other customer's session). Public answers carry
`Cache-Control: no-store` and `Referrer-Policy: no-referrer` and no cookie; the claim token is never in a URL, a response body, an audit record or
an access log (access lines carry the route pattern only), and the production CSP (`script-src 'self'`) keeps unrelated third-party scripts from
running next to it.

**NFC locking.** Locking a tag after writing is **optional** and, on some hardware, irreversible. OuPay does not require it, because revocation
(server side) disables every copy of a URL whether or not the tag is locked. A locked tag cannot be corrected, so test the written URL first.

**Binding and finished bills.** A paid, expired or cancelled bill cannot be bound (the service refuses and the database refuses cancelled/expired
ones); closing a binding never touches payment evidence (a payment arriving later is still reconciled and shown to the customer who holds the claim).
Concurrent close, claim and rebind take turns on the device row, and PostgreSQL's constraints (one open binding per device and per sale, one open
claim per device, no open claim on a closed binding or of another sale) hold whatever the order or the number of instances; a test races them.
