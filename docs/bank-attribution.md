# Bank transaction attribution (R6d-A)

When an **authenticated** bank event confirms that funds reached a merchant's settlement account, OuPay records *which collection code the bank
reported* and, only when that is unambiguous, *which of the merchant's own codes it is*. It also records an **exact code sale reference** when the
payment carries one, so the agent can be taken from that sale's immutable snapshot. See [equity-integration-architecture.md](equity-integration-architecture.md)
(sections 6.4, 6.5 and 7) for the design this implements and [code-checkout.md](code-checkout.md) for the sales it refers to.

> **Attribution is evidence, not allocation.** R6d-A never allocates money, never links a payment request, never changes a transaction status and
> never touches an invoice. The bank ledger (transactions and allocations) stays the single source of financial truth, and a code sale is still
> **not matched automatically** (V13 guard). Matching and auto-allocation of code sales is R6d-B and needs Equity's answers.

## Trusted evidence available today

Only the **mock provider** (`EQUITY_MOCK`) exists. Its events are authenticated with an HMAC over `timestamp.body` (unchanged). The normalised event
(`NormalizedBankEvent`) carries: provider event id, provider transaction id, status, whole-RWF amount, an exact payment reference, a payer display
name, the provider's occurrence time, the provider **account id** the money reached, and (new, optional) `reportedCode`.

`reportedCode` is **OuPay's normalised shape**, read by the mock from an optional `collectionCode` field of the signed payload. It is **not Equity's
schema**: whether Equity returns the code at all is open question A4. Nothing here guesses a real payload.

## Rules

1. **Merchant and account** come from the authenticated account the money reached (existing). The settlement destination is the one destination of
   that connection.
2. **A reported code resolves** only when it equals (ignoring case) the external code of exactly one registry code, that code belongs to **this**
   merchant, and it settles to **this** account. Unknown, another business's, or on another account are all `UNRESOLVED`: a merchant can never learn
   that a code exists elsewhere. (The architecture draft proposed *rejecting* an event that names another business's code. R6d-A deliberately keeps the
   transaction instead: the money verifiably reached this account, and refusing the event would drop a ledger fact. It is recorded unresolved and flagged.)
3. **Nothing is inferred** from an amount, a time, a payer, a branch, or who holds a code. No code reported means `NOT_REPORTED` / `ACCOUNT_ONLY`.
4. **Agent** (a *conclusion*, kept apart from the *evidence* it rests on). An exact sale reference says the payment **names** a sale; it does
   not by itself say who collected. The agent of that sale's immutable `code_sales` snapshot is the collector only when the evidence agrees:

   | Evidence | `attribution_status` | `agent_attribution` | Agent named in the API |
   |---|---|---|---|
   | exact sale reference + reported code that is the sale's own code + money reached the sale's account | `RESOLVED` | `CONFIRMED_FROM_SALE_SNAPSHOT` | yes (once the money is `CONFIRMED`) |
   | exact sale reference + **no** reported code | `NOT_REPORTED` | `SALE_NAMED_UNCONFIRMED` | **no**: the sale is shown, the agent is not |
   | exact sale reference + a **different** code, or a sale that settles to another account | `CONFLICT` | `UNRESOLVED` | no |
   | reported code, no sale reference | `RESOLVED` | `UNRESOLVED` | no (code attribution only) |
   | unknown / foreign / other-account code | `UNRESOLVED` | `UNRESOLVED` | no |

   The agent is never "whoever held the code when the event arrived": a code may have been reassigned between the sale and the payment (tested).
   Evidence (the reported value, the reference, the account, the original event) is recorded as it arrived and never rewritten; conclusions can
   be completed by later evidence or withdrawn by a conflict, never silently replaced. **Provider occurrence time is not used at all.** A future *suggestion* of an agent from the assignment
   interval containing the occurrence time would be unreliable near boundaries, in gaps, and because the provider's clock is the bank's, not
   OuPay's; the architecture allows it only as a labelled suggestion, and R6d-A does not build it.
5. **Conflicts**: a resolved code that differs from the referenced sale's code, a sale that settles to a different account, or a later event
   reporting a different code than the first, is a `CONFLICT` (final) and is flagged for a person. A confirmed agent is **withdrawn** (back to
   `UNRESOLVED`) when a later event contradicts it. A conflict never changes money: a transaction already allocated to an ordinary invoice keeps its
   allocation and is not re-flagged (tested). Unresolved reported codes and conflicts on money that has not been applied anywhere are flagged
   for review (`NEEDS_REVIEW`); money that an ordinary invoice reference already applied is **not** re-flagged, so existing behaviour is unchanged.
6. **Events**: attribution runs when a transaction is created and when a later event for it is *applied*. Duplicates, stale events and refused
   events never reach it. A later event can *complete* a missing code once (e.g. pending without a code, confirmed with one) or contradict it.
   Reversals keep the attribution.

## Schema (V14, additive, all nullable)

On `bank_transactions`: `settlement_destination_id`, `reported_code`, `collection_code_id`, `attribution_basis` (`CODE_REPORTED`, `ACCOUNT_ONLY`,
`UNATTRIBUTED`), `attribution_status` (`RESOLVED`, `UNRESOLVED`, `CONFLICT`, `NOT_REPORTED`), `attribution_note` (internal), `referenced_code_sale_id`,
`agent_attribution` (`CONFIRMED_FROM_SALE_SNAPSHOT`, `SALE_NAMED_UNCONFIRMED`, `UNRESOLVED`), `origin_provider_event_id` (the event that first created the transaction), `attributed_at`.
A historical transaction has none of them. `code_sales` gains `UNIQUE (payment_request_id, merchant_id)` so it can be referenced with its tenant.

Constraints: tenant-scoped composite foreign keys to `payment_destinations`, `collection_codes` and `code_sales`; all-or-none verdict columns;
verdict-specific checks (written so a NULL cannot pass); `reported_code` trimmed and 1..64. Trigger `guard_bank_transaction_attribution`:
* the settlement destination must belong to the connection the money reached, and a resolved code must be of the transaction's own provider and
  settlement account and equal exactly the reported value;
* an agent can be `CONFIRMED_FROM_SALE_SNAPSHOT` only if the referenced sale's code **and** settlement account equal the transaction's (CHECK and
  trigger), and `SALE_NAMED_UNCONFIRMED` only when a sale is named and no code was reported;
* recorded evidence (reported value, account, original event, resolved code, referenced sale) is **never overwritten**;
* a verdict can only be completed (from `NOT_REPORTED`) or turn into `CONFLICT`, and a `CONFLICT` is final;
* a confirmed agent is only ever withdrawn by a `CONFLICT`.

Every CHECK is written with `IS [NOT] DISTINCT FROM` so a NULL can never make one pass by accident (tested by attempting each bypass).

## API (authenticated, read-only, `Cache-Control: no-store`)

`GET /api/v1/merchants/{merchantId}/bank-attributions?limit&cursor` and `GET …/bank-attributions/{transactionId}` (permission `transactions:view`).

`AttributionView`: `merchantId`, `transactionId`, `providerTransactionId`, `transactionStatus`, `amountRwf`, `occurredAt`, `reportedCode` +
`reportedCodeMasked`, `collectionCode {id, label, branchId}`, `attributionStatus` (`NOT_EVALUATED` for historical rows), `attributionBasis`,
`agentAttribution`, `agentName` (**only** when the agent is `CONFIRMED_FROM_SALE_SNAPSHOT` **and** the money is `CONFIRMED`: never for a merely named
sale, a conflict, or pending, failed or reversed money), `saleReference`, `matchedToSale` (true only when verified money is actually
**allocated** to that sale), `reviewState`, `createdAt`. Nulls are omitted.

| Role | Sees |
|---|---|
| Owner | every incoming transaction, attributed or not; the reported code in full |
| Manager | only attributed transactions whose code **and** sale (each one that is present) belong to branches they are actively assigned to, so a conflict between two branches shows neither branch the other's code or sale; the code in full only when it resolved to one of the business's codes, otherwise masked. Business-wide codes, unresolved codes and unevaluated rows are the owner's |
| Cashier | only **confirmed** money whose agent is `CONFIRMED_FROM_SALE_SNAPSHOT` for **their own** sale; the code always masked (`••••77`). A named-but-unconfirmed sale, a code alone, a conflict, or reversed money is never shown to an agent |
| Another business / suspended member | not found / refused |

Never exposed: banking secrets, approval evidence, bank request references, internal code references, another merchant's code, any person's id.
These restrictions are in the SQL, so lists, pages (cursor) and direct lookups all follow the same scope (tested role by role, one row per page).

## Existing behaviour preserved

Webhook authentication, per-event and per-transaction uniqueness, ordering, reversals, legacy reference and invoice-number matching, the "code
sales are never matched automatically" policy, the demonstration guard, overpayment protection and every ledger trigger are unchanged. Events with
no code behave exactly as before (they gain `NOT_REPORTED` / `ACCOUNT_ONLY` metadata only).

## Remaining Equity dependencies

* **A4**: does Equity return the merchant/collection code on each confirmed transaction, and under what field and format? Until then `reportedCode`
  is a mock-only shape and a real deployment attributes nothing by code.
* Does the code come back on *pending* events as well as confirmed ones, and can it change between events?
* Is a free **reference** carried to OuPay with the payment (needed for agent attribution and for R6d-B matching)?
* How are reversals and corrections reported for a code payment?
* Case sensitivity and canonical format of a code (the registry matches ignoring case).

## Limitations

* Attribution is computed from events as they arrive; it is not recomputed if a code is registered or approved *after* the money arrived
  (the transaction stays `UNRESOLVED` and flagged; a person or R6d-B reconciles it).
* A code that the registry later deactivates still resolves for money that arrived before: attribution describes what the bank reported.
* No frontend yet: attribution is API-only in R6d-A.
