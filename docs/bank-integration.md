# Bank integration, reconciliation and customer payment links

Status: **frontend with typed mock services only.** No bank, webhook, email or NFC hardware is
connected. Everything labelled "simulated" in the app is exactly that.

## 1. Domain model: three independent things

| Concept | What it is | Who may change it |
| --- | --- | --- |
| `BankTransaction` | What the **bank** reported (PENDING, CONFIRMED, FAILED, REVERSED) | Only the trusted bank-event processor |
| `PaymentAllocation` | Confirmed money applied to an invoice (ACTIVE or REVERSED) | The processor (exact reference) or an authorised person (manual) |
| Invoice lifecycle | DRAFT, ISSUED, CANCELLED, VOIDED | Invoice rules (Task 5) |

Invoice `payment` and `paymentStatus` (UNPAID, PARTIALLY_PAID, PAID, OVERPAID) are **derived on
every read** from ACTIVE allocations (`src/lib/ledger.ts`); a stored value is ignored. There is no
"mark as paid". A bank reversal reverses the allocations, so the balance reappears. A **refund**
is a separate record (`RefundRecord`), never confused with a bank reversal.

Payment-request status (CREATED, AWAITING_PAYMENT, PARTIALLY_SETTLED, SETTLED, EXPIRED, CANCELLED)
is derived from the linked bank transactions the same way.

## 2. Reconciliation rules

1. **Exact reference only.** A confirmed transaction is matched to an invoice (or payment request)
   only when its reference equals the invoice number or the request reference character for
   character. Never by amount, time, payer name or branch. A near miss ("inv-1" vs "INV-1") stays
   unmatched.
2. Unreferenced or unknown-reference confirmed money stays **unmatched** and is flagged for
   review; it is never guessed onto an invoice.
3. **One transaction per `(provider, providerTransactionId)`.** Replays and re-deliveries (same or
   different event ID) never create a second transaction or count money twice. Duplicate provider
   events are recorded and ignored.
4. **Out-of-order events:** a status change applies only if it is newer than the applied one and is
   a legal transition (PENDING to CONFIRMED/FAILED/REVERSED, CONFIRMED to REVERSED; FAILED and
   REVERSED are final). A late older event is recorded as STALE.
5. **Overpayment protection:** at most the remaining balance is applied; the excess stays
   unapplied and is flagged. Paying an already-settled, voided or cancelled invoice applies
   nothing and flags the transaction.
6. **Partial and multiple payments** accumulate; one transaction can be split across invoices
   manually.
7. **Manual allocation** needs `payments:reconcile` (owner, manager), the transaction `version` and
   each invoice's `expectedRemainingBalance` (optimistic locking). A stale view is rejected with
   `allocation_conflict`. Every rule is validated **before** anything is applied, so a failing line
   never leaves a half-applied split.
8. Bank confirmation comes only from the processor. No service method lets a user or cashier create
   a transaction, confirm a payment or mark an invoice paid.
9. Cashiers see only transactions applied to invoices assigned to them (including their reversed
   history), with no unapplied or unmatched figures.

## 3. Banking provider architecture

`BankingProviderAdapter` (`src/services/banking/bankingProviderAdapter.ts`):

- `getProviderCapabilities()`: tri-state per capability (SUPPORTED, NOT_SUPPORTED, UNCONFIRMED).
- `normalizeTransactionEvent(raw)`: required; pure; throws `InvalidProviderEventError` on anything
  untrustworthy.
- `validateAccountLink?`, `verifyIncomingEvent?`: **optional**. Callers must check the method and
  the capability before use.

Only a simulated adapter exists (`equityMockAdapter`). Its event format (`SimulatedEquityEventV0`)
is **invented**, carries a `__simulated: true` marker and is refused otherwise. It contains no real
Equity endpoint, payload, field name or credential.

### Real Equity Bank Rwanda: not integrated

The app shows every Equity capability as **"Not confirmed"**. Nothing is assumed about: webhooks or
real-time notifications, signature/authentication method, merchant verification, account-linking
APIs, payment initiation, USSD merchant resolution, or whether the bank echoes OuPay's reference.

### Open questions for the bank

1. Does Equity push transaction notifications (webhook, ISO 20022, file, polling)? Delivery
   guarantees, retries and ordering?
2. How is an event authenticated (signature, mTLS, IP allow-list, shared secret rotation)?
3. Is there a unique, stable transaction ID and event ID, and are reversals separate events?
4. Can a payer reference (OuPay's `OP-...`) be passed through and returned? Maximum length and
   character set? If not, what identifies the merchant and the payment?
5. How is a merchant account linked and verified (who consents, what proof)?
6. Is there a payment-initiation API, a merchant code, or USSD? OuPay will not invent any.
7. Settlement timing, fees, currencies, sandbox availability, SLAs, data-protection terms.

## 4. Trusted event boundary (what the real backend must do)

The frontend simulator calls `normalizeTransactionEvent` then `processEvent` in-process. In
production the same boundary is **server-side only**:

- **Authentication:** verify the provider's signature or approved scheme before parsing; reject
  otherwise. Credentials live in a secrets manager, never in browser code or logs.
- **Immutable raw events:** persist the exact payload with receipt time before any processing.
- **Deduplication:** unique constraint on `(providerId, providerEventId)` and on
  `(providerId, providerTransactionId)`; make processing idempotent.
- **Ordering and retries:** apply by provider time with the legal-transition table; park or ignore
  stale events; acknowledge quickly and retry safely.
- **Database transactions:** transaction upsert, allocation, audit entry and notification in one
  transaction; lock the invoice row (or use a serialised queue per invoice) so concurrent
  same-reference payments cannot over-allocate. Enforce
  `sum(active allocations) <= invoice total` and `<= transaction amount` with constraints.
- **Uniqueness and concurrency:** the mock detects conflicts with `version` and expected balances;
  the real system needs row locks or compare-and-swap plus a unique key on public references.
- **Audit:** append-only entries for every state change; actor is the system or a user ID.
- **No sensitive logging:** never log full payloads, account numbers, names or tokens; log IDs and
  outcomes.
- **Never trust the client:** the UI, the cashier and the customer cannot confirm a payment.

## 5. QR and NFC

- A **payment profile** has an opaque public token (12 base62 characters, about 71 bits), never
  derived from an internal ID. The token is public, not a credential: anyone holding the URL can
  open the page, so the page shows only the merchant display name, optional branch, cashier first
  name and initial, the amount, the reference and the status of that one request.
- Public URL: `<base>/p/<token>` and `<base>/p/<token>/r/<reference>`. The base is configurable
  with `VITE_PUBLIC_PAYMENT_BASE_URL`. The default `https://pay.oupay.rw` is **illustrative**, not a
  confirmed domain.
- Links can be switched off or on, and replaced. Replacing revokes the old token for good.
- The QR code is drawn from the `qrcode` library's matrix and encodes exactly the URL; tests decode
  the rendered SVG with `jsqr` and compare.
- **NFC-ready, not NFC-enabled:** the app prepares the NDEF URI record, the copyable URL and tag
  requirements. It does not read or write tags, and a tag's hardware UID is never trusted.
  `deviceAssignments` (cards, bracelets) exists in the model for later.
- Payment requests use a high-entropy reference (`OP-` plus 12 Crockford characters, about 59
  bits). Open requests last 30 minutes, invoice requests 7 days. Invoice requests ask for the
  actual remaining balance and are blocked for draft, cancelled, voided or paid invoices.
- The customer page separates four facts: instructions opened, "I have started my payment" (a
  claim only), bank confirmation, and OuPay reconciliation. It never says "paid" before the bank
  confirms.

## 6. Demo tooling

The bank simulator page (`/demo/bank-simulator`) and the "simulate the bank" buttons on the public
page exist only when `import.meta.env.DEV` or `VITE_ENABLE_DEMO_TOOLS=true`. A normal production
build has no route, no singleton and no method that can create a bank event: `DEMO_TOOLS_BUILD` is a build-time constant, and the production bundle was checked to contain none of the simulator page, scenarios or buttons. (The simulated Equity *adapter* is still bundled because the demo account-link flow uses it; it is labelled simulated everywhere.) Everything it creates
is marked simulated.

## 7. Known production limits of this frontend

- All data is in browser storage. There is no server-side authorisation, rate limiting,
  concurrency control or encryption at rest.
- The public pages have no bot protection or per-token rate limiting; a real deployment needs both,
  and monitoring for token enumeration.
- Expiry is evaluated on read; a real system also needs a job and bank-side handling of late
  payments to expired requests (the mock keeps late confirmed money counted).
- Notifications are in-app only and polled every 15 seconds. No email, SMS or push.
- Refund recording has a model but no UI.
- Timestamps compare as ISO strings; the real system should store UTC instants.
- Capabilities of the real Equity integration, and every statement about the bank above, are open.

## 8. Remaining work for a real Equity integration

1. Obtain Equity's integration documentation, sandbox and approval; answer section 3.
2. Build a server-side adapter and the trusted ingestion endpoint (section 4).
3. A real persistence layer with the constraints above, and server-side authorisation.
4. Merchant account linking and verification flows approved by the bank.
5. Real notification channels, token rate limiting, observability and reconciliation reports.
6. Refunds, credit notes, settlement reports, and an operations dashboard for stuck events.
