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

## Dashboard sources (kept apart)

| Figure | Source |
|---|---|
| Total verified payments | bank-confirmed (sample) transactions |
| Issued invoices | `InvoiceService`: sum of ISSUED invoices (billed, not received) |
| Outstanding invoices | `InvoiceService`: ISSUED and UNPAID/PARTIALLY_PAID, at full total |
| Active cashiers | ACTIVE cashier memberships with ACTIVE user accounts |

Verified payments are never inferred from invoices.
