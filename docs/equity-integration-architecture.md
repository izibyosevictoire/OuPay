# Equity merchant-code collection: integration architecture

Status: **architecture only, approved in principle. Nothing in this document is implemented, and no part of it has been agreed
with Equity Bank Rwanda.** It separates what OuPay does today (confirmed by reading the code) from what we *assume* about
Equity (not yet confirmed) and from what we *propose* to build.

Companion documents: [`equity-technical-questions.md`](equity-technical-questions.md) (questions for Equity's technical team) and
[`oupay-delivery-roadmap.md`](oupay-delivery-roadmap.md) (milestones and their verification status).

## 1. Product requirements being served

1. OuPay supports Equity-linked merchant payment codes.
2. Codes are the only customer-facing payment method in the initial product.
3. One merchant's Equity account may be associated with many agent collection codes, subject to Equity's approval.
4. Merchant onboarding collects preliminary Equity KYC information.

The real bank account belongs to the **merchant**, never to a sales agent. OuPay does **not** introduce a second financial ledger.

## 2. Three identifiers that must never be confused

| Identifier | What it identifies | Issued by | Lifetime | Where it lives |
| --- | --- | --- | --- | --- |
| **Collection code** | A merchant's collection point or agent (the thing a customer pays *to*) | The **bank** (assumption, see 5) | Long-lived, reassignable between agents over time | New registry (proposed) |
| **Sale reference** | One individual sale: an invoice or payment request | **OuPay** | One sale, never reused | Existing: `payment_requests.public_reference` (`OP-` + 12 chars), invoice number |
| **Bank transaction reference** | One actual bank-confirmed payment | The **bank** | One payment | Existing: `bank_transactions.provider_transaction_id` |

Rules that follow:

* A value OuPay generates itself (for example the random `payment_profiles.public_token`) is **never** presented as, or treated as,
  a bank code.
* A collection code is **not** evidence that a particular sale was paid. Only authenticated bank evidence that identifies the sale
  is (section 7).

## 2a. Sale creation, bank-confirmed funds and allocation are three different facts

A sale being created, money being confirmed by the bank, and that money being applied to **this** sale are separate events. None
implies the next, and only the last makes a sale paid.

| Step | Fact established | What it does **not** establish | Where it lives (today) |
| --- | --- | --- | --- |
| 1. **Sale created** | The merchant asked the customer for an amount: an invoice and/or a payment request with its sale reference exist (and, in future, the code the customer was told to pay) | That anyone has paid. A created, issued or "awaiting payment" sale is **unpaid** | `invoices`, `payment_requests` |
| 2. **Bank-confirmed funds** | An **authenticated** bank event reported a `CONFIRMED` transaction on the merchant's settlement account (and, when the bank supplies it, a code of that merchant). The money is real and verified | That it belongs to any particular sale. A confirmed transaction with no unambiguous sale evidence is **verified but unmatched** and needs reconciliation; matching amount, time, payer or code alone is not evidence | `bank_events`, `bank_transactions` |
| 3. **Allocation to a sale** | Confirmed money was applied to one specific sale, either automatically on authenticated and unambiguous sale evidence (section 7) or manually by an authorised person | That the sale is **fully** paid: an allocation may cover only part of the amount (partial payment), or only the part up to the remaining balance (overpayment is flagged) | `payment_allocations` (`AUTO_REFERENCE` or manual) |

**A sale is fully paid only when** the sum of its **active** allocations reaches its total, and every one of those allocations rests on
a transaction that is authenticated and `CONFIRMED`, and on a match that is unambiguous (authenticated bank evidence, or an authorised
manual decision recorded with the person who made it). Consequently:

* A created sale, a customer's claim ("I have paid"), a payment page being opened, a payment instruction having been shown, a code
  having been used, or a matching amount are **never** payment.
* Confirmed but unmatched or ambiguous money does **not** make any sale paid; it stays on the transaction until reconciled.
* A partial allocation gives a partially paid sale. The remainder stays unpaid.
* A bank reversal reverses its allocations, so the sale's paid status falls back. Paid status is **derived** from active allocations on
  every read; it is never stored and there is no "mark as paid" (this is existing behaviour, section 3.4).
* OuPay never fabricates a paid status to compensate for missing bank evidence.

## 3. Confirmed existing OuPay behaviour

Everything in this section was verified by reading the repository (migrations `V1`, `V3`, `V8`, and the banking, ledger, payment,
merchant, membership, invoice and checkout modules). It is current behaviour, not a design.

### 3.1 Merchant, bank connection and settlement account

* A merchant is registered with legal name, business type, TIN, registration number, address and contact. Its status is **always**
  `pending_verification`; nothing in the code moves it to `active`. There is no representative or ID capture, no document upload,
  no consent record and no bank-specific requirement set. There is no file or object storage in the backend.
* `bank_connections`: per merchant and provider; at most one live (`PENDING`/`CONNECTED`) connection per `(merchant, provider)`, and a
  provider account id can belong to **one** live connection. Account identifiers are opaque, never real account numbers.
* `payment_destinations`: merchant-owned accounts under a connection, with composite `(id, merchant_id)` keys.
* `ProviderId` is `EQUITY_MOCK`, `MTN_MOMO`, `AIRTEL_MONEY`. `EQUITY_MOCK` is a **simulation**. No real Equity adapter exists.
  Provider capabilities are tri-state (`SUPPORTED`, `NOT_SUPPORTED`, `UNCONFIRMED`) and Equity's are shown as unconfirmed.

### 3.2 Payment profiles, payment requests and customer pages

* `payment_profiles`: a public opaque token (62^12), a label, an optional branch, an optional assigned cashier, and a destination.
  The assigned cashier is a single mutable column; there is no assignment history.
* `payment_requests`: a unique high-entropy `public_reference`, an optional invoice link, an amount and an expiry (30 minutes open,
  7 days invoice). V8 adds provenance (`source`, branch, creator) enforced by triggers.
* Public pages show only the merchant display name, optional branch, cashier first name and initial, amount, reference and status.
  They never say "paid" before bank confirmation.

### 3.3 Sales, idempotency and provenance

* Invoices carry `sale_channel` (`INVOICE`, `POS`, `SIMPLIFIED`) and a durable `client_request_id` with a server-computed request
  fingerprint (unique per business). A repeat with the same fingerprint returns the same sale; a different payload under the same id is
  a 409. R2 HTTP idempotency keys are a separate 30-day replay cache.
* Simplified checkout creates an invoice, issues it and creates a payment request in one atomic operation.

### 3.4 Bank events, transactions and allocations (the only ledger)

* The webhook boundary `POST /api/v1/integrations/{provider}/events` is the only way a bank transaction can come to exist. A provider
  with no adapter answers 501. An adapter that cannot authenticate events cannot be exposed. Events are authenticated **before**
  parsing, then stored immutably (redacted) before processing.
* `bank_events` are unique per `(provider, event id)`; `bank_transactions` are unique per `(provider, provider transaction id)`.
  Status changes follow a legal-transition table, and stale events are recorded and ignored.
* The merchant is resolved **only** from the provider account id of a `CONNECTED` connection. A normalized event carries one optional
  `paymentReference`, a payer display name and the provider account id. It carries **no** collection code or till identifier.
* On a `CONFIRMED` transaction, reconciliation matches the reference **exactly** against a payment request's `public_reference`, and
  failing that against an exact **invoice number**. It never matches by amount, time, payer name or branch. The allocation is
  `min(amount, remaining)`, the excess is flagged as overpayment, a non-issued or already-paid invoice is flagged, and an unreferenced or
  unknown-reference transaction stays unmatched and flagged for review.
* `payment_allocations` (origin `AUTO_REFERENCE` or manual) are the sole source of an invoice's paid status, which is derived on every
  read. There is no "mark as paid" and no user or cashier can create or confirm a transaction.
* Manual allocation needs `payments:reconcile` (owner, manager) with optimistic checks.

### 3.5 Staff

* Memberships have roles (`OWNER`, `MANAGER`, `CASHIER`) and statuses (`INVITED`, `ACTIVE`, `SUSPENDED`, `REVOKED`). Branch
  assignments are ACTIVE or ENDED rows. Invoices snapshot creator and assignee display names.
* `banking:manage` is owner-only.

## 4. Gaps against the new requirements

| # | Gap | Today |
| --- | --- | --- |
| G1 | No registry of bank-recognised codes | Only OuPay-generated profile tokens |
| G2 | No link from a settlement account to many codes | One account, profiles are QR/link presenters |
| G3 | Transactions do not record which code received the money | Account-level only |
| G4 | No dated assignment history for agents or collection points | One mutable cashier column |
| G5 | Sales are not tied to the code the customer was told to pay | Not recorded |
| G6 | No Equity KYC collection, document handling or PII controls | Basic registration only |
| G7 | No real Equity adapter or confirmed capability | Simulation and 501 |

## 5. Assumptions that require Equity approval

Nothing below may be treated as true, built against, or shown to a customer as fact until Equity confirms it in writing. Questions are
in [`equity-technical-questions.md`](equity-technical-questions.md).

| # | Assumption | Why it matters | If it is false |
| --- | --- | --- | --- |
| A1 | One Equity business account can have **many** collection/till codes | The whole "many codes per settlement account" model | Per-agent codes are impossible; agents are distinguished only by sale reference and assignment, with account-level attribution |
| A2 | A distinct code can be provisioned **per agent or collection point** | Per-agent attribution | Same as A1 |
| A3 | Codes are **issued by Equity** (OuPay cannot register its own) | Activation rule | If OuPay may register codes, a registration API contract is needed |
| A4 | Equity returns the **original code** on each confirmed transaction | Code-level attribution and code validation | No code-level attribution; sales matched only by reference |
| A5 | A payment can carry **our sale reference**, and Equity returns it | Automatic allocation | Nearly all payments need manual reconciliation |
| A6 | A bill-validation or dynamic-reference mechanism exists | Unambiguous sale binding without payer typing | Rule B (section 7) is unavailable |
| A7 | Authenticated transaction notifications, reconciliation statements and settlement reports exist | The trusted boundary and independent reconciliation | Polling or manual statement import; weaker guarantees |
| A8 | The authentication scheme is one we can verify server-side (signature, mTLS, allow-list) | Webhook is refused without it | Integration cannot be enabled |
| A9 | Equity offers an onboarding/KYC submission channel | Honest KYC statuses | Manual hand-off with operator-recorded evidence |
| A10 | The above hold for **Equity Rwanda** specifically | Everything | Re-plan |

OuPay does **not** invent USSD syntax, reference parameters, dynamic till provisioning, or bank callback fields. The customer journey
describes only what A1 to A10 confirm.

## 6. Proposed domain model (not implemented)

All proposed tables are additive, carry `merchant_id`, and reference each other through composite `(id, merchant_id)` keys. Existing
tables are reused, not replaced. Names are provisional.

### 6.1 Settlement account (reuse)

A `payment_destination` under a `CONNECTED` `bank_connection` **is** the merchant settlement account. No new account table. The real
account number is never stored; only the opaque provider id and a masked form, as today.

### 6.2 Collection codes

`collection_codes`:

* internal id (opaque OuPay label for staff, never shown as a bank code);
* `provider_id`, the settlement `payment_destination`, optional `branch_id`, a collection-point label;
* `external_code`: the bank-issued identifier, **null until Equity issues it**;
* provisioning state: `REQUESTED`, `SUBMITTED` (only if a real submission path exists), `PENDING_BANK`, `ACTIVE`, `SUSPENDED`,
  `DEACTIVATED`, `REJECTED`;
* request, approval and deactivation metadata, and an evidence reference for activation.

Constraints:

* `ACTIVE` requires `external_code` **and** an evidence reference (CHECK). A code generated by OuPay can never become `ACTIVE` on its
  own.
* `(provider_id, external_code)` is unique across **all non-rejected rows**, including deactivated ones: a bank-recognised code can
  never be ambiguous between two merchants, and a retired code stays reserved until a reviewed release.
* Activation happens only through (a) a verified bank event or API response, or (b) an authorised operator recording Equity's written
  confirmation with an evidence reference, under maker-checker (two different people).

### 6.3 Assignment history (append-only)

`collection_code_assignments`: code, `membership_id` or collection-point label, branch, `valid_from`, `valid_to`, who assigned/ended,
end reason, and a **snapshot** of the person's display name.

* A partial unique index allows at most **one open assignment per code**, so a code cannot have two active agents.
* Rows are never edited or deleted (trigger). Reassignment ends the open row and inserts a new one in one transaction.
* Suspending, reassigning or revoking a staff member ends their assignment and flags the code for attention. The code stays
  bank-active (money may still arrive). History is never rewritten.

### 6.4 Sale and transaction links (additive nullable columns)

* `payment_requests`: `collection_code_id` and `assignment_id`, **snapshotted at sale time**.
* `bank_transactions`: `reported_code` (exactly as the bank gave it), `collection_code_id`, and `attribution_basis`
  (`CODE_REPORTED`, `ACCOUNT_ONLY`, `UNATTRIBUTED`).

### 6.5 Agent attribution is never inferred from time alone

Agent attribution comes from the **sale's snapshot**, not from timestamps. For a transaction:

* matched to a sale: the sale's snapshotted code and assignment are the attribution;
* with a bank-reported code but **no** matched sale: it is attributed to the **code** only. A suggested agent (the assignment interval
  containing the provider's occurred time) may be shown to a reviewer, labelled as a suggestion, and is **never applied
  automatically**, especially near an interval boundary, in a gap, or when intervals overlap in any source data;
* with no code: unattributed.

## 7. Bank confirmation and matching

### 7.1 Evidence levels

| Level | Evidence | Outcome |
| --- | --- | --- |
| E0 | Anything not authenticated | Refused (existing behaviour) |
| E1 | Authenticated, confirmed transaction; no usable reference | **Verified, unmatched**; reconciliation required |
| E2 | E1 plus an exact high-entropy sale reference that names exactly one sale, the account matches the sale's merchant and destination, and, **when the bank supplies a code**, it equals the sale's code | **Auto-allocation** (capped at the remaining balance, excess flagged) |
| E3 | Bank binding of the payment to the sale through a bill-validation/dynamic-reference mechanism (only if A6 holds) | Auto-allocation |

Never sufficient on their own: amount, time, payer name, branch, or a code alone. A code supplied by the bank that conflicts with the
sale's code **blocks** auto-allocation and flags the transaction.

### 7.2 Sequence for a code-based payment (proposed)

1. The authenticated event arrives; the raw payload is stored immutably; the adapter normalises it, including `reportedCode` only if A4
   is confirmed.
2. The provider account id resolves the merchant and settlement account (existing).
3. A reported code must resolve to exactly one code of that merchant and settlement account; an unknown code stays unattributed and a
   code of another merchant rejects the event.
4. One transaction per `(provider, provider transaction id)` is upserted (existing ordering and reversal rules).
5. On `CONFIRMED`, evaluate E2/E3. Otherwise the transaction stays verified and unmatched.
6. Reconciliation shows **suggestions** (open sales on the same code and amount), labelled "suggested, not matched". A person confirms
   through the existing manual allocation.
7. Paid status is derived only from active allocations. It is never fabricated.

### 7.3 Legacy matching is preserved

The behaviour in 3.4, including matching by an exact **invoice number**, **stays exactly as it is** for existing flows. We note,
for a separate review, that invoice numbers are sequential and payer-typed, so they are weaker evidence than a high-entropy sale
reference. For code-based sales the proposal is to require the `OP-` reference (E2). Changing historical matching needs its own
reviewed change.

## 8. Equity KYC onboarding (proposed)

Separate from ordinary merchant registration, which stays as it is.

* **Requirement sets** are configurable data per provider and version (fields, document types, validation, help text, effective dates).
  Equity can add fields or documents later by publishing a new version; no registration or migration rewrite.
* **First set:** legal business name; business registration information; business address and contact; authorised representative and ID
  type; existing Equity account status; required supporting documents; consent and submission status.
* **Entities:** applications, answers, documents, consents, information requests from the bank, and an append-only event history.
* **Honest states:** `DRAFT`, `COLLECTED` (the merchant consented and submitted to OuPay), `HANDED_OFF` (only when a real submission
  channel exists, or an authorised operator records an actual manual hand-off with evidence), `MORE_INFO_REQUESTED`, `APPROVED`,
  `REJECTED`. The last three are recorded **only from bank-originated evidence**. OuPay never states that data was sent to Equity, or
  that an account is approved, without that evidence or a real authorised integration.
* **PII and documents:** a dedicated KYC permission (owner by default); field-level encryption for ID numbers; documents in private
  object storage (new infrastructure) with content hash, size and type limits, malware scanning, short-lived signed access, no public
  URLs; an audit entry on every read; retention and deletion dates; no PII in URLs, logs, events or notifications; export only by an
  authorised action. Retention periods and lawful basis must be confirmed with legal counsel and with Equity. Rwandan data-protection
  requirements are to be confirmed, not assumed here.
* The OuPay merchant `status` is **not** changed by KYC; bank approval is a separate, explicit state.

## 9. Customer journey and QR

The single initial method is **"Pay using Equity merchant code"**. The sale page shows the code, the amount and the sale reference, and
the honest status ("waiting for bank confirmation"). The exact instructions are written **only** from capabilities Equity confirms.
QR codes may present these same instructions; a QR is not a separate payment rail. Existing payment-profile/QR infrastructure is kept
only as a delivery channel for this page.

## 10. Proposed internal API contracts (illustrative, not final)

Base `/api/v1/merchants/{merchantId}`. All writes authorise, check the business, and audit.

* Codes: `GET/POST /collection-codes`; `PUT /collection-codes/{id}/external-code` (operator, evidence required);
  `POST .../activate`, `.../suspend`, `.../deactivate`; `POST .../assignments`, `POST .../assignments/{id}/end`;
  `GET .../history`; `GET /me/collection-code`.
* Sale: `POST /checkout/code-sale` (client request id, Idempotency-Key); public `GET /public/sales/{reference}`.
* Reconciliation: `GET /reconciliation/unmatched?codeId=`, `GET /transactions/{id}/suggestions`, existing allocation endpoints.
* KYC: `GET /kyc/requirements`, `POST /kyc/applications`, `PUT .../answers`, `POST .../documents`, `POST .../consent`,
  `POST .../submit`, `GET .../status`; operator endpoints record bank decisions with evidence.
* Provider boundary: optional capability interfaces (`CodeProvisioning`, `KycSubmission`, `BillValidation`) implemented only for
  what Equity confirms. The existing event route and adapter capability pattern stay.

## 11. Migration and scope impact

* Additive migrations (`V11`+): new tables and nullable columns on `payment_requests` and `bank_transactions`.
* One widening: the provider CHECK constraints (for example on `bank_connections`) must accept a real Equity provider id.
* Unchanged: invoices, allocations, derived paid status, the event processor's existing matching, simplified checkout, R5a to R5c.
* Frontend: Equity activation wizard, codes and assignment screens, a code-based checkout and customer page, reconciliation
  suggestions, banking page approval state.
* Not touched by this work: the uncommitted R5c implementation, deployment configuration, existing migrations.

## 12. Risks

* An unconfirmed Equity capability can invalidate an assumption (section 5). Each milestone is gated on the answers it needs.
* KYC document storage is a new infrastructure and compliance decision.
* R5a to R5c are not yet verified against real Maven and PostgreSQL, and new work builds on them.
* Reconciliation load rises sharply if A5 is false (manual matching).
