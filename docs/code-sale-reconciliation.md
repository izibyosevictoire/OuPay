# Evidence-based code sale reconciliation (R6d-B)

A confirmed bank transaction is applied to a **LIVE** code sale **automatically only when every piece of evidence agrees**. Anything less leaves the
money **confirmed but unmatched**, with the missing evidence as the review reason. There is no new ledger: the allocation is the ordinary one
(`payment_allocations`, through `LedgerOperations`), inside the bank-event processor's own database transaction.

Read with [bank-attribution.md](bank-attribution.md) (the evidence), [code-checkout.md](code-checkout.md) (the sales) and
[equity-integration-architecture.md](equity-integration-architecture.md) (sections 6 and 7, the design this implements).

> **Nothing in production can satisfy this evidence yet.** It needs the bank to return the collection code and the sale reference (Equity
> dependencies A4/A6), and live collection is off outside the test profile. Today only the simulated provider can drive it.

## The facts are different facts

| Fact | Meaning | Where it lives |
|---|---|---|
| **CONFIRMED** | the bank verified the money (and it is not reversed) | `bank_transactions.status` |
| **ATTRIBUTED** | the reported code resolves to one of *this* business's codes on *this* account | `bank_transactions.attribution_status = RESOLVED` |
| **MATCHED** | the payment's exact `OP-` reference names a sale, and that sale's request is linked to the transaction | `bank_transactions.payment_request_id` |
| **ALLOCATED** | money has actually been applied to the sale's invoice | `payment_allocations` |
| **PAID** | the invoice has no remaining balance | derived from allocations |

The read API (`GET …/bank-attributions`) exposes them separately: `codeResolved`, `saleReferenceNamed`, `saleReferenceMatched`,
`allocatedToSaleRwf`, `saleFullyPaid`, and a derived `stage`: `NOT_CONFIRMED`, `AWAITING_MATCHING` (verified funds, nothing resolved),
`CODE_RESOLVED`, `SALE_MATCHED`, `ALLOCATED`, `FULLY_PAID`, `CONFLICT`. The stage is computed from those facts; it is never stored or set.

## The matching policy (automatic)

`CodeSaleMatcher.evaluate` decides eligibility only (read-only, enforced by an architecture test). A transaction is eligible when **all** hold:

1. it is confirmed incoming money on the authenticated account of the sale's business (the merchant comes from the account, never from a code);
2. its reference is **exactly** the sale's own unique `OP-` reference (high entropy). An invoice number never matches a code sale;
3. the bank **reported a code** that resolved to the **sale's own code**, and the money reached the **sale's settlement account**, so attribution is
   `RESOLVED` and the agent is `CONFIRMED_FROM_SALE_SNAPSHOT`: no conflict, nothing unresolved;
4. the sale is **LIVE** (a demonstration never is).

Never sufficient: an amount, a time, a payer, an agent, a branch, who holds the code now, a code with no reference, a reference with no code.
**Request expiry is not a condition**: a late payment is real money for a real sale and is applied.

When eligible, the processor links the transaction to the sale's request and runs its **ordinary exact-reference allocation, unchanged**: invoice
must be `ISSUED`, the amount is capped at the remaining balance, the excess stays unapplied and is flagged (overpayment), a payment for an already paid
sale is not applied and is flagged, a partial payment stays partial. Otherwise the money stays confirmed and unmatched and is flagged for review with
the first missing piece of evidence ("the bank reported no collection code", "the reported code does not resolve to the code of this sale", "it is a
demonstration sale"…). Reasons never include another business's data.

## Transactions, locks and concurrency

* One database transaction per event (unchanged). Order inside it: record attribution (R6d-A) → match and allocate → review flags. A later event
  that *completes* evidence (a code not reported before) is recorded before matching, so a payment is matched on the evidence as it stands.
* Lock order is unchanged: the transaction row, then the invoice. Manual reconciliation locks in the same order. The V15 trigger locks the
  transaction row before the generic allocation guard, so a concurrent change of evidence cannot race an allocation.
* Duplicates: the existing unique provider event id and provider transaction id; a repeated or simultaneous event never allocates twice (tested with
  six concurrent deliveries). The ledger's own rules (a transaction is never over-allocated, an invoice is never overpaid) still hold under races
  (tested: two payments and a manual allocation racing for one sale allocate it exactly once).
* A failed allocation rolls the event's transaction back with it: there is never a paid invoice without its allocation.
* Reversal: the existing bank-reversal path reverses the allocation (history kept); the sale is owed again; a late "confirmed" event is stale.

## Database enforcement (V15)

V13's guard refused every automatic allocation and accepted any manual one. V15 **replaces its body** (the trigger stays; V1–V14 are untouched) and keeps
everything it enforced. For an invoice billed through a code:

* a demonstration sale never receives money, by any route; only a LIVE sale can;
* **every origin**: the money must have reached the sale's settlement account; a final attribution `CONFLICT` is never overridden; a reported code must
  have resolved to the sale's own code (an unresolved or different one is never ignored); a reference naming another code sale rules this one out;
* **automatic** additionally needs: attribution `RESOLVED`, agent `CONFIRMED_FROM_SALE_SNAPSHOT`, the sale named by the exact reference, the
  transaction linked to the sale's request, and the transaction's reference equal to the sale's own reference.

So direct SQL can allocate confirmed money to a code sale only as a **manual** allocation, and only with the account right and no contradicting
bank-code evidence; it can never allocate automatically without the code, account and reference evidence. The Java policy
(`CodeSaleAllocationPolicy`) is the same rule set, used by the matcher and by manual reconciliation, so they cannot diverge.

## Manual reconciliation

Unchanged for ordinary invoices (the note stays optional). For a **LIVE code sale** an authorised person (`payments:reconcile`) may apply money
explicitly through the existing audited path. This is the exact list of requirements; every one is enforced by the service (clear error) **and**,
where it concerns the bank evidence, by the V15 trigger:

| Requirement | Enforced by |
|---|---|
| An explicit transaction and target sale (the request names both, with the balances the person saw) | request contract, optimistic checks |
| A written **reason**: at least ten characters and more than a repeated character (`422 reconciliation_reason_required`) | `ReconciliationService` |
| The person's identity and the reason persisted, immutably, in the same transaction as the allocation (no audit, no allocation) | `MANUAL_ALLOCATED` audit entry (actor, transaction, invoice, "Note: …"); `created_by_user_id` required for MANUAL by a CHECK |
| Authenticated, with `payments:reconcile`; another business's transaction or sale is not found | `MerchantAccess`, tenant-scoped keys |
| Verified incoming funds (`CONFIRMED`, not reversed, not pending) | the generic V3 guard |
| The money reached **this sale's settlement account** (a transaction with no recorded account can not be applied by hand) | V15 + policy |
| No final attribution `CONFLICT` | V15 + policy (`409 code_sale_evidence_mismatch`) |
| No contradicting bank-reported code: a reported code must have resolved to the sale's own code | V15 + policy |
| The payment's reference must not name a different code sale | V15 + policy |
| Never a demonstration sale (`409 code_sale_not_payable`) | V15 + policy |

What manual allocation **does not** do: it never writes or invents a reported code, never changes `attribution_status`, `agent_attribution`, the
referenced sale or the payment-request link (tested column by column), so a person's decision can never turn the agent into a *confirmed* collector.
The money is `origin = MANUAL`, and the read model says so: `allocationOrigin` is `MANUAL` (or `AUTO_REFERENCE`, or `MIXED`), `codeResolved` is false,
`saleReferenceMatched` is false, `agentAttribution` stays `SALE_NAMED_UNCONFIRMED` and no agent is named. **A sale can be financially paid while its
code and agent remain unconfirmed**; these are different facts.

Partial payments, excess funds, reversals and concurrency follow the ordinary ledger rules: a partial allocation leaves the sale partly paid and the
transaction with unapplied money; more than the sale owes is refused; an excess stays unapplied; a bank reversal or a manual correction reverses the allocation
and the sale is owed again; five simultaneous manual allocations of one transaction apply it exactly once.

Trade-off: a payment that names the sale but reported **no** code can be applied by a person (they supply and record the evidence); the narrowest policy
that kept manual reconciliation useful. Historical transactions with no recorded account (before V14) can not be applied to a code sale by hand.

## Lock order

The V15 trigger fires before the generic V3 guard (trigger names order them) and locks the **transaction row first**, then reads the sale; the V3 guard
then locks the invoice. That is the application's order everywhere (processor: transaction, then invoice; manual reconciliation: transaction, then
invoices by id). No path locks the invoice before the transaction, so the guards introduce no inversion (the concurrency tests allocate through both
routes at once without a deadlock).

## Not built

* No frontend change beyond the new error code: the attribution/reconciliation facts are API-only (existing screens do not consume attribution, and
  the mock's code sales are all demonstrations, which never receive money).
* No suggestions queue for unmatched code payments; no re-evaluation of old unmatched money when a code is approved later (a person reconciles it).

## Equity dependencies (unchanged, still blocking production use)

A4 (the code returned on confirmed transactions), whether it is on pending events, a free reference carried with the payment (A6), reversal reporting,
and the code's canonical format.
