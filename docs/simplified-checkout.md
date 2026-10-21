# Simplified checkout (R4)

Amount-only billing for a business in **SIMPLIFIED** operating mode: type an amount, press **Bill**, show the QR code or send the
link. No catalog, no inventory, no new tables and no new migration: it composes the invoice, payment-request, idempotency and
ledger machinery of R1–R3.

## What one sale is

One `POST /merchants/{m}/checkout/simple` creates, in ONE database transaction:

1. an **invoice** of channel `SIMPLIFIED` (R3 trusted path), customer "Walk-in customer" (never an invented person), one line of
   quantity 1 for the amount, no tax, due the day of sale, assigned to and created by the person billing;
2. the invoice **issued**;
3. a **fixed-amount payment request** (the invoice total) through the existing payment-link infrastructure, open for the server
   policy of **30 minutes** (`SimplifiedCheckoutService.PAYMENT_LIFETIME`, via R3's `PaymentRequestOptions`; traditional invoices
   keep their seven days);
4. the durable **client request identity** (R3) and the R2 **idempotency record**;
5. audit entries (`INVOICE_DRAFT_CREATED (SIMPLIFIED)`, `INVOICE_ISSUED`, `PAYMENT_REQUEST_CREATED`, `SIMPLE_CHECKOUT_BILLED`).

If any step fails (no payment link, no connected destination, ineligible branch) the whole transaction rolls back, including the
idempotency claim and the invoice number: nothing is left behind, and the same request can be retried once the setup is fixed.

## API

`GET /merchants/{m}/checkout/simple/options` (permission `invoices:create`; 200 even when the business is not simplified):

```json
{ "operatingMode": "SIMPLIFIED", "readiness": "READY",
  "branches": [{ "id": "…", "name": "Remera Main", "code": "RM01", "paymentReady": true }],
  "minAmountRwf": 100, "maxAmountRwf": 10000000, "paymentLifetimeMinutes": 30, "defaultDescription": "Payment" }
```

`readiness` is `READY`, `NOT_SIMPLIFIED`, `NO_BRANCH` or `NO_PAYMENT_LINK` (the first thing that must be set up).

`POST /merchants/{m}/checkout/simple` with header `Idempotency-Key` (8–80 characters):

```json
{ "amountRwf": 25000, "description": "Moto ride", "branchId": "…", "clientRequestId": "<uuid>" }
```

`description` and `branchId` are optional. The amount is read as a decimal NUMBER so a fractional value is refused rather than
truncated. Unknown fields (sale channel, status, tax, expiry, creator) are ignored: none exists on the request.

Response `201` (created now) or `200` (a repeat; same body):

```json
{ "invoiceId": "…", "invoiceNumber": "INV-0007", "paymentRequestId": "…", "publicReference": "OP-…",
  "amountRwf": 25000, "currency": "RWF", "description": "Moto ride", "status": "CREATED",
  "expiresAt": "…", "createdAt": "…", "merchantDisplayName": "…", "branchId": "…", "branchName": "…",
  "profileToken": "…", "paymentPath": "/p/<token>/r/<reference>" }
```

`paymentPath` is the customer page relative to the public payment site; the frontend prefixes the configured base URL.

| Status / code | Meaning |
| --- | --- |
| 401 / 404 | not signed in / not a member (a business you do not belong to does not exist) |
| 403 `forbidden` | no `invoices:create` |
| 409 `checkout_not_available` | the business is not in SIMPLIFIED mode |
| 409 `no_eligible_branch` | the person is not assigned to an active branch (nothing is created or assigned for them) |
| 422 `branch_required` / `branch_not_eligible` | several branches and none chosen / a branch that is not theirs |
| 409 `no_active_profile` | no active payment link on a connected destination can collect |
| 422 `validation` | amount outside 100–10,000,000, not whole, or a bad description (max 120 characters, one line) |
| 409 `idempotency_key_reuse` | R2: this key was used for another request or by another person |
| 409 `client_request_id_reuse` | R3: this sale identifier belongs to a different sale |
| 409 `request_in_progress` | R2: the first attempt is still running |

## Transaction and idempotency design

`SimplifiedCheckoutService` is deliberately **not** transactional. `IdempotencyService.executeOnce` owns the transaction (it
refuses to run inside one) and the whole sale runs inside its action; the invoice and payment services join that transaction.
There is no external side effect inside it.

| Case | Protection |
| --- | --- |
| Same key, same sale | R2 replays: the response is rebuilt from CURRENT data (so it shows the live status), after re-checking membership and `invoices:create` |
| Same key, different sale / other person | `409 idempotency_key_reuse` (R2) |
| Lost response | retry with the same ids: the sale already exists and is returned (200) |
| R2 records pruned (30 days) or never stored | the durable `(merchant, client_request_id)` unique index and stored fingerprint (R3): the same sale returns the existing invoice, a different one is `409 client_request_id_reuse` |
| Ten identical concurrent requests | the idempotency claim (same key) or the advisory lock on the client request id (different keys): exactly one invoice, one `201`, nine `200` |

A repeat of an existing sale returns its **newest payment request as it is now**: it never creates a second request for it, never
changes a lifetime and never hides a payment that arrived. The sale's fingerprint covers the amount, note, branch, assignee,
channel and creator but **not the due date**: a checkout sale is due on the day it is made, derived from the server clock, so a
retry on another day still finds its sale (manual invoices keep the due date in their fingerprint).

## Branch and cashier rules

The assignee is always the person billing, who must hold an ACTIVE assignment to an ACTIVE branch (the existing invoice rules
re-check it). One eligible branch is chosen automatically; several require a valid choice; none gives `no_eligible_branch` with
guidance. A business owner is not assigned to any branch by default and must assign themselves (Branches, Cashiers): the checkout
never creates or assigns a branch silently. Cashiers only ever see and bill their own.

## Payment status

The page never decides an outcome. It reads, from the authenticated API, the invoice (with its bank-reconciled payment status) and
its payment request, every four seconds while the sale is still collecting, and on **Check now**. "Payment confirmed" requires both
the request to be settled and the invoice to be reconciled as paid. Other states are shown plainly: awaiting payment, partly paid,
expired, cancelled and "needs attention" (overpaid, refunded, or a mismatch between request and invoice). A customer's own claim
that they paid changes nothing. Bank verification and allocation are untouched.

## Frontend

* Route `/collect` (permission `invoices:create`), navigation entry **Collect Payment** only when the business is SIMPLIFIED. In
  another mode the page explains that payments are collected through invoices; nothing existing is hidden.
* `src/features/checkout`: the form (`CollectForm`), the receipt with QR, copy, share and live status (`SaleReceipt`), pure rules
  (`checkoutRules.ts`) and the per-tab memory of the sale being billed and the sale on screen (`checkoutSession.ts`).
* The same sale keeps the same `clientRequestId` and `Idempotency-Key` across retries, refreshes and lost answers; changing the
  amount, note or branch starts a new sale; a completed sale is forgotten so the next identical amount is a new sale.
* Services: `checkoutService` (contract), `createHttpCheckoutService` and `createMockCheckoutService`. The mock goes through the same
  mock invoice service and ledger, makes the same decisions, and is labelled **Demo mode**: a payment only shows as confirmed after
  a simulated bank event. OuPay never collects a PIN or OTP.

## Limits (for review)

* A person billing for the first time who retries after a business setup change (a second branch added) while the first attempt's
  answer was lost, without `branchId`, is asked to choose a branch; within 30 days the same `Idempotency-Key` still replays.
* A repeat after the payment request expired returns the expired request (the sale is the same sale); a new sale is a new sale.
* The 30-minute lifetime is a code constant, not yet a business setting.
* Merchant status (for example pending verification) is not checked, matching the existing invoice flow.
