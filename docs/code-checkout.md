# Agent code checkout (R6c)

An authorised agent enters an RWF amount, bills it through the **collection code assigned to them**, and shows the customer the merchant's code and a
unique **sale reference**. The sale waits for the bank. There is no second ledger: a code sale is an ordinary issued invoice with an ordinary
payment request (R2 to R4), plus an immutable `code_sales` snapshot. See [collection-codes.md](collection-codes.md) for the registry and
[simplified-checkout.md](simplified-checkout.md) for the pattern this follows.

> **Status: development only.** OuPay has no Equity integration and Equity has not confirmed how a merchant code takes a payment, whether a payment
> can carry a sale reference, or whether the code or reference comes back in a notification. Until then **no deployment presents a bank code as a way to
> pay.** A simulated or unapproved code makes a clearly labelled **demonstration**. Live collection is off by default and refused at startup outside the
> `test` profile.

## What a sale is

| Layer | Row | Notes |
|---|---|---|
| Commercial | `invoices` | `sale_channel = 'CODE'`, one line, quantity 1, walk-in customer, no tax, issued. Idempotency uses the R3 durable `client_request_id` + server fingerprint. |
| Collection | `payment_requests` | `source = 'CODE'`, exact integer RWF, server-controlled 30-minute expiry, a public reference (`OP-…`) that is the **sale reference**. |
| Provenance | `code_sales` (V13) | Immutable snapshot, one row per request. Update and delete are refused by a trigger. |

`code_sales` stores: merchant, branch (and name/code snapshot), agent (user id and name), invoice, payment request, `sale_reference`, `amount_rwf`,
`description`, `presentation_mode` (`DEMONSTRATION` or `LIVE`), the code (id, provider, internal reference, label, status, `is_simulated`, the bank code
**only for a LIVE sale**), the assignment (id, kind, membership, name, role, valid-from) and the settlement account (destination id, masked account).
All foreign keys are composite and tenant-scoped, so another business's code, invoice or request cannot be referenced. Constraints refuse a
demonstration with a real code, a LIVE sale without a bank code, and a mismatched request, invoice, amount or reference.

Because the code and the assignment are **copied**, reassigning or suspending the code later never changes history, and the original agent can always
retrieve their own sale.

## API

Trusted, authenticated, tenant-scoped. All responses are `Cache-Control: no-store`.

| Endpoint | Purpose |
|---|---|
| `POST /api/v1/merchants/{merchantId}/checkout/code-sale` | Bill. Requires `Idempotency-Key`. Body: `amountRwf` (a number: a fraction is refused, never truncated), `clientRequestId`, optional `description` (max 120, one line), optional `collectionCodeId` (required when the caller holds several), optional `branchId`. `201` when created, `200` for a repeat of the same sale. |
| `GET …/checkout/code-sale/options` | The caller's own codes, each `DEMONSTRATION`, `LIVE` or `UNAVAILABLE` with the reason, and a readiness (`READY`, `NO_ASSIGNED_CODE`, `CODE_NOT_AVAILABLE`, `NO_PAYMENT_LINK`). |
| `GET …/checkout/code-sale/{saleId}` | The same sale again (refresh, lost response) with its current status. |
| `GET /api/v1/public/code-sales/{reference}` | Anonymous customer page data. |

The body can never carry a bank code, a status, a confirmation, an assignment, an agent, a presentation mode or a sale channel. Unknown fields are
ignored, not trusted (tested). Permission: `invoices:create`, plus **holding a code** (below).

### Error codes

`no_assigned_code`, `code_not_assigned`, `code_required` (422), `code_not_available`, `live_collection_unavailable`, `no_eligible_branch`,
`branch_required`, `branch_not_eligible`, `no_active_profile`, `client_request_id_reuse`, `idempotency_key_reuse`, `request_in_progress`, `validation`.

## Who may bill, and with which code

1. The caller must be an **active member** with `invoices:create` (`MerchantAccess`, at the service boundary, also on replay).
2. They must **currently hold** the code (an open `MEMBER` assignment to their membership). Owners and managers hold codes only if one is assigned to
   them; having the permission is not enough. A collection-point assignment names no person, so nobody can bill with it.
3. The code is evaluated fresh (`eligibilityIssues`):
   * `LIVE`: no issues at all (bank-approved, **not** simulated, assigned, settlement account connected, branch active, assignee active and at the
     branch) **and** `oupay.code-checkout.live-enabled=true` (test profile only).
   * `DEMONSTRATION`: a **simulated** code in `REQUESTED`, `REQUEST_DECLARED` or `ACTIVE` whose only issues are `SIMULATED` / `NOT_BANK_APPROVED`.
   * Otherwise refused: `live_collection_unavailable` (an eligible real code while live is off) or `code_not_available`. Nothing is created.
4. **Settlement-account association.** The request rides on an active payment link on **the code's own settlement account**
   (`PaymentProfileService.createCodeSaleRequest`). No link on that account means `no_active_profile` and nothing is created, so a sale can never be
   collected to a different account than its code.

## The creation transaction

`CodeCheckoutService.bill` is deliberately **not transactional**: `IdempotencyService.executeOnce` owns the transaction (R2) and refuses to run
inside one. Inside it, in order: authorise, repeat check by `clientRequestId`, choose and evaluate the code, resolve the branch, create the draft
(`InvoiceService.createDraftFor`), issue it, create the request (`createCodeSaleRequest`), insert the `code_sales` snapshot, write the audit event
`CODE_SALE_BILLED`. Any failure rolls back **all** of it (tested with an injected failure in the snapshot insert and in the audit insert): there is
never an issued invoice without a request, a request without a snapshot, or a consumed invoice number.

## Idempotency

* Same key and same sale: `200` with the original sale. Same key, different content: `409`.
* Same `clientRequestId` under a new key: the original sale if the content is identical, else `409 client_request_id_reuse`. Another agent reusing
  someone's `clientRequestId` is a conflict, never a hijack.
* Ten concurrent identical requests, with the same key or with ten different keys, create **one** sale.
* After the R2 key record is pruned, a replay is answered from the sale's own durable record (`client_request_id`), not from the cache.
* A replay is authorised again before anything is returned; a suspended member gets nothing.
* A replay returns the stored sale whatever the code's eligibility is today.

## Bank money and code sales: the R6c / R6d boundary

**R6c creates sales. It does not attribute bank money to them.** Matching a bank transaction to a code sale needs evidence Equity has not confirmed
(whether a payment carries the sale reference or the merchant code, and whether notifications return either). So, until R6d:

| Case | What happens | Enforced by |
|---|---|---|
| Real money names a **DEMONSTRATION** sale (its reference, or its invoice number) | Never applied. The transaction stays **CONFIRMED (verified) and unmatched**, flagged for review. The sale keeps showing "Awaiting payment" and "not payable". | `BankEventProcessor` (no link, no allocation); `CodeSaleAllocationPolicy` in `LedgerOperations.allocate` (every route); **trigger `guard_code_sale_allocation` (V13)** |
| Manual reconciliation to a DEMONSTRATION sale | `409 code_sale_not_payable`; the sale is not offered in the payable-invoices picker; a multi-line request that includes it applies nothing. | `ReconciliationService`, the policy, and the same trigger |
| Real money names a **LIVE** code sale | Never applied automatically (not by sale reference, not by invoice number, never by amount, time, merchant or agent). Verified and unmatched, flagged for review; the customer sees "Requires reconciliation". | processor + policy + trigger (`origin = AUTO_REFERENCE` refused) |
| An authorised person applies money to a **LIVE** code sale by hand | Allowed through the existing audited manual path (`origin = MANUAL`); the sale then shows Partially paid / Paid. | unchanged manual rules |
| Duplicate, late, pending-then-confirmed, or reversed events | The existing idempotency, ordering and reversal rules are unchanged; none of them can create an allocation to a code sale. | processor + trigger |
| Traditional invoices and simplified checkout | Unchanged: exact reference or invoice-number auto-allocation as before. | not touched |

The effect on existing financial code is narrow: one early return in `BankEventProcessor.reconcileConfirmed` (code sales only), one call to
`CodeSaleAllocationPolicy.requireAllowed` in `LedgerOperations.allocate` and the manual validation loop, one filter on the payable-invoices list,
and one additive trigger. No existing ledger constraint, trigger or invariant is weakened.

R6d-B replaced the "never automatic" rule for LIVE sales with matching on authenticated bank evidence (see [code-sale-reconciliation.md](code-sale-reconciliation.md));
the policy and the V15 trigger are the single place that rule lives. A DEMONSTRATION sale still never receives money, by any route.

## Demonstration sales and the business's financial records

A demonstration sale needs a real issued invoice and payment request to exercise the checkout, but it must never look like business activity.

**Where a demonstration would have leaked (investigated, not assumed).**

| Consumer | Leaked? | Now |
|---|---|---|
| `GET /invoices` (lists, counts, the cashier's assigned list) and so every figure the frontend derives from it: receivables, issued total, overdue count and total, dashboard invoice KPIs | yes | excluded in the repository queries |
| `GET /reports/summary` (issued count, issued total, outstanding) | yes | excluded in the SQL (`NOT i.is_demonstration`) |
| Manual-reconciliation picker (`/payable-invoices`) | yes (R6c round 2 filtered it) | excluded centrally |
| Invoice numbering (`INV-0001...`, a per-business sequence) | yes: each demo consumed a real number and left a gap | demonstrations use their own series `DEMO-0001...` |
| Dashboard transaction figures (verified incoming, allocated, unmatched, daily, providers) | no: derived from bank transactions and allocations only, and a demo can have neither | unchanged |
| Notifications | no: raised only on allocation, which a demo cannot receive | unchanged |
| Exports, fiscal (RRA EBM/EIS) submission, customer reminders | **do not exist in OuPay today** | nothing to change; see "Future consumers" |

**Chosen strategy: keep the row, mark it once, exclude it centrally (approach A).** `invoices.is_demonstration` (V13) is set by trusted code when the
invoice is created, is immutable (the provenance trigger refuses any change), is only allowed on the `CODE` channel (check constraint) and is kept
equal to the code sale's mode by the database (`guard_code_sale`). The allocation guard reads the same flag. Every list, page and count in
`InvoiceRepository`, the reports SQL and the payable picker test it, so a consumer has one thing to check, in the backend, not a frontend filter.

**Rejected: a separate store for demonstration sales (approach B).** It would need its own invoice, line-item, payment-request and public-page
paths (a second, parallel engine), or a rewrite of `InvoiceService` and the payment-request resolver to accept two stores, and the demo would no
longer prove the real checkout path. The cost of A is that a consumer that forgets the flag would count a demo; that is why the flag is one
column, the existing queries state it, the database refuses to change it, and the reports and list tests fail if a filter is removed.

**What stays available.** The checkout demonstration itself (sale, receipt, customer page, sale record, `GET /invoices/{id}` by its id with
`demonstration: true`, a "DEMONSTRATION ONLY" banner on the invoice page and print view). Demonstrations are numbered `DEMO-nnnn` so they are
recognisable forever in history, and a LIVE code sale is an ordinary counted invoice (`INV-` series).

**Future consumers (not built).** Any future export, fiscal submission (EBM/EIS), customer reminder, receivables or revenue report, or accounting
integration must filter `is_demonstration = false` at its source query and must never read `code_sales` to decide this. A test per consumer
should assert that a demonstration contributes zero, as `DemoFinancialIsolationIT` does for the existing ones.

## Payment status

Status is read from the existing bank transaction and allocation infrastructure; nothing in this module can set it. What is *shown* is stricter
than the generic request state:

| Customer status | When |
|---|---|
| Awaiting payment | nothing applied to the sale (pending bank money is still "awaiting"). **A demonstration is always here** (or Expired / Cancelled), whatever the bank reported. |
| Partially paid | verified money **applied** to a LIVE sale, remainder due |
| Paid | verified money fully **applied to the sale** |
| Expired / Cancelled | the request expired or was cancelled |
| Requires reconciliation | LIVE sale: the bank reported confirmed money naming it that is not applied, or the money was reversed |

Confirmed money that has not been applied is never shown as partly paid or paid (`CodeCheckoutService.effectiveState`). Money the bank reports
without the sale reference is not attributed to the sale at all.

## Customer page (`/code-sale/:reference`)

The sale reference is the only key: `OP-` plus 12 characters of a 30-symbol alphabet (about 59 bits, from `SecureRandom`), validated strictly. The page is
rate limited like every public route, `Cache-Control: no-store`, GET-only, ignores query parameters, and answers every unknown, malformed or
foreign (non-code) reference with the same 404.

Anonymous, mobile-first, read-only. It shows the business, the amount, the sale reference, the status with an honest note and the expiry. It shows the
bank code and instructions **only for a LIVE sale**. For a demonstration it shows a prominent "DEMONSTRATION ONLY. This is a simulated code: no real
bank payment can be made with it." statement and "Not payable". It never shows the agent, the settlement
account, approval evidence, OuPay's internal code reference or any identifier (tested: the page carries no UUID), offers no other way to pay, and never asks for a PIN, password or OTP. Code sales do not appear on the ordinary
public payment pages, and ordinary requests do not appear here.

The **instructions** are configuration (`oupay.code-checkout.instructions`, separated by `|`) because the wording must come from what Equity has
confirmed. Until it is configured the page shows none and invents none.

## Frontend

`/code-checkout` ("Code checkout", permission `invoices:create`, both operating modes): amount, optional description, code selector (codes that
cannot bill are listed with the reason), Bill, then a receipt with the sale reference (copyable), the code or the demonstration statement, an
"Open customer page" link, share where the browser supports it, live status read from the server (never set by the screen or a timer) and "New
sale" (with a confirmation while a sale is still open). A refresh recovers the same sale: only its id and reference are kept in `sessionStorage`
(scoped to business and person, shape-validated) and the sale is read again from the server. A retry after a lost answer reuses the same
`clientRequestId` and `Idempotency-Key`; changing the sale gets new ones. The mock service makes the same decisions as the server (demonstration
only, live off) so demo mode and HTTP mode behave alike.

## Configuration

| Property | Default | Notes |
|---|---|---|
| `oupay.code-checkout.live-enabled` | `false` | `CodeCheckoutStartupGuard` refuses `true` unless profile `test` and not `prod`. |
| `oupay.code-checkout.instructions` | empty | `\|`-separated customer instructions, shown only for LIVE sales. |

## Limitations and Equity dependencies

* **No real Equity adapter, no code attribution (R6d).** Nothing links a bank event to a code sale automatically; see the boundary above.
* A demonstration sale is a real issued invoice, numbered `DEMO-nnnn`, and is excluded from every list, total and report (see above); it exists only on simulated accounts.
* **Live collection is unavailable** until Equity confirms: how a payer uses a merchant code, whether a payment can carry a free reference,
  whether the code and reference return in notifications, and the exact customer wording (technical questions 1.6, 2.x).
* Collection-point assignments cannot bill (they name no person). Multi-code agents choose a code; there is no default code.
* A sale needs a payment link on the code's settlement account (an internal OuPay object); creating one is unchanged and manual.
* No refunds, receipts, SMS/WhatsApp sharing, or branch-level reporting of code sales yet.
* The mock treats a sample code's fictitious settlement account as satisfied by any active link (it has no ledger record).

## Open questions

1. Does Equity require the sale reference in a payer-entered field, or only the merchant code? (blocks LIVE and R6d)
2. May an agent hold more than one code at once, or should the assignment rule become one open code per person?
3. Should code sales be reportable per agent and per code (dashboard), and should owners be able to cancel an open code sale?
4. Should the 30-minute expiry be configurable per business for code sales?
