# Digital invoicing

Frontend design notes for the invoice module. Everything is enforced by **mock services** so
the demo behaves realistically; a real backend must enforce the same rules independently.

## Commercial invoices are not fiscal documents

An OuPay invoice is a commercial record. It is **not** an RRA EBM/EIS tax invoice and carries
no fiscal signature, QR code, SDC identifier or receipt number. The printable view says so.
Future EBM/VSDC fiscal documents will be separate records that reference `Invoice.id`; each
line already stores an explicit tax category and rate so they can be mapped later without
restructuring invoices.

## Money

All amounts are **integers in the currency's minor unit**. For RWF the exponent is 0, so
1 unit = 1 franc and nothing is ever a fraction. Quantity has up to 3 decimals and is handled
as thousandths; tax rates are basis points (1800 = 18%). Products and divisions use `BigInt`,
so there is no floating-point error or overflow (`lib/invoiceCalculations.ts`).

Rounding: every division rounds **half up**, **once per line**. Invoice totals are plain sums
of the already-rounded line values, so printed lines always add up exactly.

```
gross = round(unitPrice x quantity)        base = gross - discount
EXCLUSIVE (prices exclude tax): tax = round(base x rate / 10000)          total = base + tax
INCLUSIVE (prices include tax): tax = round(base x rate / (10000 + rate)) total = base
```

Stored identities: EXCLUSIVE `grandTotal = subtotal - discountTotal + taxTotal`;
INCLUSIVE `grandTotal = subtotal - discountTotal` (tax is the part already inside).
The service recomputes everything and ignores totals sent by a client.

## Tax

- Per line: `NOT_APPLICABLE`, `EXEMPT`, `ZERO_RATED`, or `STANDARD` with a rate (18% preset or custom).
- **Nothing is taxed by default.** 18% is Rwanda's standard VAT rate, offered as a choice, never
  assumed for a merchant or an item.
- Non-taxable categories always compute with rate 0, whatever rate is stored.
- Net, tax and total are stored on each line, so issued invoices keep their exact historical tax.

## Lifecycle

```
DRAFT --issue--> ISSUED --void--> VOIDED
DRAFT --cancel-> CANCELLED
```

- `CANCELLED` and `VOIDED` are final. Nothing is deleted, numbers are never reused.
- `ISSUED -> CANCELLED` deliberately does not exist: an issued invoice is voided.
- **Void policy:** owners only, a reason is mandatory, and only while payment status is `UNPAID`.
  Anything with payment activity needs a future credit-note/refund flow.
- Only drafts can be edited. Issued invoices keep their amounts and customer details.
- Writes quote the version they read; a stale write fails with `version_conflict`.

## Payment status is separate and read-only

`UNPAID | PARTIALLY_PAID | PAID | OVERPAID | REFUNDED`. Only bank-confirmed reconciliation (a
future integration) may change it. There is no "mark as paid" action; issuing, cancelling and
voiding never touch it. Seed values such as `PAID` are mock data.

## Ownership, scoping and history

- Every call takes a `merchantId` and checks the signed-in user's ACTIVE membership.
- Owners and managers see every invoice of the business; cashiers see only invoices assigned
  to them. Records a cashier may not see answer "not found".
- New invoices need an **ACTIVE branch** and an assignee who is an ACTIVE member **actively
  assigned to that branch**. Cashiers can only assign themselves. Eligibility is checked again
  at issue time.
- Invoices store `createdBy`/`assignedTo` ids and names plus merchant and branch snapshots, so
  deactivating a branch or changing/revoking staff never rewrites history.

## Provenance and durable request identity

Every invoice records, once and for good, where it came from (`invoices.sale_channel`) and, for checkout flows, the identity of the
request that created it (`invoices.client_request_id`). Added in V8; nothing existing was rewritten.

| `sale_channel` | Meaning |
|---|---|
| `INVOICE` | a traditional manual invoice (what the existing endpoints create) |
| `POS` | point-of-sale billing (future) |
| `SIMPLIFIED` | amount-only billing (future) |
| *(empty)* | an invoice created before V8: **read as `INVOICE`** (`Invoice.getSaleChannel()`). There is no backfill. |

* **Only trusted server code chooses a channel.** The existing `POST /invoices` body has no such field, and any extra field in it is
  ignored, so a client cannot impersonate a checkout flow. The trusted entry point is `InvoiceService.createDraftFor(merchant, draft,
  InvoiceCreation)`: no controller reaches it (an architecture test enforces it) and the checkout services of later milestones call it.
* **Fixed at creation.** A trigger (`trg_invoices_provenance_guard`) refuses any change to either column, including giving a legacy
  invoice a request id afterwards. It is separate from, and does not alter, `guard_invoice_update`.
* **The durable guard against a duplicate sale.** `(merchant_id, client_request_id)` is unique where not null, and a POS or simplified
  invoice must carry one (`ck_invoices_checkout_request_id`). R2's HTTP idempotency records are only a 30-day replay cache and are not
  used for this. Creators of the same id take turns on a transaction-scoped advisory lock, so a concurrent or repeated call finds the
  committed invoice and gets it back (`created = false`) instead of failing on the index.
* **Permanent request fingerprint.** The server computes `invoices.client_request_sha256` with R2's canonical fingerprint
  (`IdempotencyService.fingerprintOf`: key order and number formatting such as `1` vs `1.0` do not matter, line order does) over the
  business, the channel, the creating member and the whole draft (branch, assignee, customer, every line, tax mode, notes, and for manual invoices the
  due date; a checkout sale is due the day it is made and that server-derived date is left out, see
  [simplified-checkout.md](simplified-checkout.md)), and stores it with the request id. It is never read from a request: any such field is ignored. A repeat whose fingerprint is
  identical returns the existing invoice (`created = false`); any other payload, member or channel under the same id is
  `409 client_request_id_reuse`. This holds whether or not an R2 idempotency record still exists (those are pruned after 30 days).
  The id and its fingerprint exist together (`ck_invoices_request_identity`), the fingerprint is a 64-character hex digest
  (`ck_invoices_request_sha256`), and neither can change afterwards (`trg_invoices_provenance_guard`).
* **Attribution is database-enforced** (`trg_invoices_attribution_guard`): the creator of an invoice never changes; the branch and the
  assigned cashier are editable while it is a draft and fixed from the moment it is not one (including the update that issues it).
* `invoices` also gained `ux_invoices_id_merchant_branch` `(id, merchant_id, branch_id)`, so later tables (payment requests now, stock
  reservations later) can reference an invoice together with its business and branch.
* The invoice response gains an additive `saleChannel` field (never null).

### Payment requests

`payment_requests` records `source`, `branch_id` and `created_by_user_id`, set only by trusted server code and never changed
(`trg_payment_requests_provenance`):

* `source` is `OPEN` (no invoice) or the invoice's own sale channel. The database enforces both rules: `OPEN` exactly when there is no
  invoice, and an invoice request's source equals its invoice's channel. It is the same classification kept on the request for
  filtering, not a second one that can drift.
* `branch_id` is the invoice's branch for an invoice request (composite foreign key to the invoice's tenant-and-branch key), and for an
  open request only its own payment link's branch (trigger) or none. `source` and `branch_id` are derivable from the invoice or link;
  they are kept on the row so that filtering and reporting need no join, and the database guarantees they can never disagree with it.
* `created_by_user_id` is the member who created the request. The foreign key includes the business, so the creator must belong to the
  same business as the request. Anonymous open requests have none (`ck_payment_requests_open_anonymous`).
* Completeness: provenance is all-or-nothing (`ck_payment_requests_provenance_whole`), an invoice request names its branch and creator
  (`ck_payment_requests_invoice_attribution`), and a request for a POS or simplified invoice must record its source, so NULL cannot be
  used to bypass the checks. An older application instance can therefore not open requests for checkout invoices; those flows only
  exist in versions that record provenance.
* Requests that predate V8 read as `OPEN` (no invoice) or `INVOICE`.

**Lifetime.** Invoice payment requests stay open for seven days, as always. A trusted caller can pass `PaymentRequestOptions` to
`PaymentProfileService.createInvoiceRequest(merchant, invoice, options)` for a shorter one (1 minute to 7 days, validated). The expiry is
`now + lifetime` on the server's clock; nothing a client sends can set it, and the public open-amount page keeps its fixed 30 minutes.
Expiry means "no longer collecting", never "nothing was paid": a confirmed bank payment is still reconciled after a request expires.

An existing live request is never silently overwritten or replaced. With options: the same lifetime returns it (a harmless retry); a
different one fails `409 payment_request_lifetime_conflict` and changes nothing. Replacing is a deliberate step: cancel the request,
then create the new one. The merchant API (no options) keeps returning whatever live request exists, one reference per invoice.

### Rolling deployment and rollback

V8 was revised during R3 review before it was merged or applied anywhere; once applied it is never edited again. It is additive and
forward-only. Every new column is nullable, so the previous application version keeps working against the new schema
(the rows it writes simply leave them empty). If a defect is found in V8 the fix is a later migration, never an edit of the file, and
rolling the application back needs no schema change.

## Dashboard sources (kept apart)

| Figure | Source |
|---|---|
| Total verified payments | bank-confirmed (sample) transactions |
| Issued invoices | `InvoiceService`: sum of ISSUED invoices (billed, not received) |
| Outstanding invoices | `InvoiceService`: ISSUED and UNPAID/PARTIALLY_PAID, at full total |
| Active cashiers | ACTIVE cashier memberships with ACTIVE user accounts |

Verified payments are never inferred from invoices.
