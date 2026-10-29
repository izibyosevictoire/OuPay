# OuPay: end-to-end demonstration and release readiness (R1 to R7c)

> **Everything below is synthetic.** No Equity Bank system, no real merchant, customer, bank account or money is involved anywhere in this document.
> A "bank payment" in this demonstration is **an event produced by OuPay's own authenticated simulator**. It proves OuPay's behaviour when a bank
> event arrives; it does **not** prove that Equity can send such an event. Do not present it to anyone as a real bank transaction.

## 1. Three ways to run it, and what each can honestly show

| Tier | How | Backend / data | Can show | Cannot show |
| --- | --- | --- | --- | --- |
| **A. Real local stack** | `mvn spring-boot:run -Dspring-boot.run.profiles=dev` against a disposable PostgreSQL 18, plus `VITE_API_MODE=http npm run dev` | Real backend, real database, synthetic seed through the real API | Register a BUSINESS, invite two agents, catalog (goods and a service), receive stock, mixed POS cart, **final price and tax review**, role gating, mobile layout, honest gates | A LIVE sale (see "Safety gates") |
| **B. Approved test configuration** | Backend integration tests, profile `test`: `EndToEndDemoScenarioIT` | Real backend and PostgreSQL through the real HTTP API (MockMvc), authenticated simulated bank events | The **whole chain**: code association, billing and reservation, bank event, exact reconciliation, fulfilment worker, final stock | A browser (the test world cannot be kept running) |
| **C. In-browser mock** | `VITE_API_MODE=mock npm run dev` | Mock services with sample data | Every screen with sample data, the demonstration sale flow (`DEMO-nnnn`), "Payment and stock" for a demonstration | Anything real, and any LIVE sale |

### Safety gates (not bypassed, by design)

| Gate | Where | Effect on a local demonstration |
| --- | --- | --- |
| Collection-code approval is **test profile only** and has **no controller** | `CollectionCodeApprovalStartupGuard` | No owner, manager or agent can make a code bank-approved from the app. Only tier B's test hook does. |
| Live collection is **test profile only** | `CodeCheckoutStartupGuard` | `dev` can never bill a LIVE sale. |
| Tax treatments must be **approved** before billing | `oupay.pos.approved-tax-treatments` (empty by default) | The real review prices the cart and then refuses to bill: "tax treatment has not been approved for billing". Which treatments the business approves is an open business decision. |
| An agent needs an **assigned approved code** | POS billing review | "You are not assigned a collection code". |

In tier A these gates were observed live, in the real app, and **left in place**.

## 2. What was run (this review)

* **Tier A (real stack, dev profile, disposable PostgreSQL 18, Flyway V1 to V18):** a BUSINESS "DEMO Synthetic Traders Ltd", two invited agents (Aline and
  Eric) who accepted real invitation links from the dev mail sink, three catalog items (rice by kg and soda by piece with approved-style tax settings, and a
  service), opening stock at one branch, and a mixed cart (2 kg rice, 3 soda, 1 repair) saved as a draft and reviewed in the browser. The review showed
  **subtotal RWF 9,200 + tax RWF 1,224 = total RWF 10,424** (rice exempt; soda and repair 18%), the per-line physical, reserved and available stock, and the two
  refusals above.
* **Tier B transcript** (`EndToEndDemoScenarioIT`, passes):

```text
Business: Sample Shop Ltd (BUSINESS, synthetic). Agents: Aline Cashier and Eric Cashier, both assigned to branch RM01.
Stock: rice 10 kg opening + 20 kg received (delivery note DN-DEMO-0001) = 30 kg; soda 100 pc.
Collection codes: EQ-LIVE-77 -> Aline, EQ-LIVE-88 -> Eric (approval through the TEST-ONLY hook).
Aline's cart: 2 kg rice (18% VAT), 3 soda (zero-rated), 1 repair (exempt). Reviewed total RWF 9740.
Billed LIVE sale on code EQ-LIVE-77. Reservation ACTIVE; payment not yet received.      UNPAID / NOT_POSTED   rice physical 30 kg, reserved 2 kg
SIMULATED bank event: transaction CONFIRMED, attribution RESOLVED to Aline from the sale snapshot, no review needed.
Reconciled: PAID, but stock is NOT deducted yet.                                        PAID / NOT_POSTED
Worker posted fulfilment: 2 SALE movements (rice -2 kg, soda -3 pc), reservation FULFILLED.   PAID / POSTED   handover NOT_TRACKED
Worker re-run: nothing posted again.
Eric's services-only sale: PAID / NOT_REQUIRED (no goods, no movement, no failed work).
Eric's goods sale paid RWF 3,999 of 4,000: PARTIAL / NOT_POSTED (nothing deducted; 10 soda stay reserved).
FINAL: rice on hand 28,000 g, soda on hand 97 pc, soda reserved 10. No fulfilment exceptions.
```

* **Tier C:** the owner reassigned the simulated "Demo stall" code to the cashier in the Collection codes screen; the cashier built a cart, reviewed it
  ("This is a demonstration bill... No real bank payment has been made") and billed `DEMO-0001`; "Payment and stock" read **DEMONSTRATION: no real payment,
  stock reservation, stock deduction or fulfilment exists for this bill**.

## 3. Stakeholder demonstration script

Say first: *"The bank here is OuPay's simulator. We are showing how OuPay behaves when a bank event arrives, not a real Equity transaction."*

| # | Step | Screen | What the audience should see | Status after |
| --- | --- | --- | --- | --- |
| 1 | Register the business; invite two agents; they accept | Sign-up, Cashiers & staff | Agents appear as ACTIVE cashiers at the branch; owner is **not** a seller until assigned to a branch | Business and staff exist |
| 2 | Build the catalog: rice (kg), soda (pc), repair (service); set tax | Catalog | Goods have a unit and stock; a service says "no stock needed"; tax is per item | Catalog ready |
| 3 | Receive stock at the branch | Inventory > Receive stock | Movement RECEIVE with reference; physical stock rises | Rice 30 kg |
| 4 | Give each agent a collection code | Collection codes | "OuPay never creates a bank code"; the code has an Equity-issued value and a holder | Code held by Aline |
| 5 | Agent builds a mixed cart and saves a draft | POS billing | "A draft is not a sale": nothing reserved or deducted | Draft |
| 6 | Review and bill | POS billing > Review | Per-line price, tax, net, and physical / reserved / available stock; total to bill; blockers listed if any | Reservation ACTIVE; payment UNPAID; inventory NOT_POSTED |
| 7 | Customer pays (SIMULATED bank event) | (tier B) / Payments | Transaction CONFIRMED, attributed to the agent from the sale snapshot, no review | Payment PAID |
| 8 | Look at the sale before the worker runs | POS > Payment and stock | **Paid is not deducted**: "Stock not deducted yet"; handover "Not recorded" | PAID / NOT_POSTED |
| 9 | Fulfilment worker runs (every 15 s) | POS > Payment and stock, Inventory > Movements | "Stock deducted ... the stock ledger was updated"; SALE movements "Sold (paid sale)" by "OuPay (verified payment)" | PAID / POSTED, reservation FULFILLED |
| 10 | Edge cases | POS | Partial payment: nothing deducted. Services only: "No goods in this sale". Demonstration: "no real payment, stock reservation..." | PARTIAL, NOT_REQUIRED, NOT_APPLICABLE |
| 11 | Reversal and late payment (tests) | Owner's "Paid sales that need attention" | A reversal after posting or a payment after a release opens ONE read-only exception; stock is never restored automatically | Exception OPEN |

Expected status vocabulary: payment `UNPAID | PARTIAL | PAID | REVERSED | NOT_APPLICABLE`; reservation `ACTIVE | RELEASED | FULFILLED`; inventory
`NOT_POSTED | POSTED | EXCEPTION | NOT_REQUIRED | NOT_APPLICABLE`; handover **always `NOT_TRACKED`** (a posted sale never claims goods were handed over).

## 4. Simulated versus real banking

| | Simulated (this demonstration) | Real (not available) |
| --- | --- | --- |
| Bank event | Signed with a development-only shared secret, invented JSON marked `simulated: true` | Equity's real notification format, authentication and delivery: **unknown** |
| Collection code | Approved through a test-only hook | Issued and provisioned by Equity |
| Money | None | Customer funds in a merchant settlement account |
| Reference and code on the payment | Carried because the simulator was written to | Unconfirmed whether Equity carries a free reference or the code |

## 5. Blockers for live Equity integration

1. Equity has not confirmed how a payer uses a merchant code, whether a payment can carry a reference, and whether the code and reference come back in notifications
   (`docs/equity-technical-questions.md`). Exact reconciliation depends on the answer.
2. No real Equity adapter, credentials, signature scheme, replay window or sandbox exist (`docs/equity-integration-architecture.md`).
3. Collection-code approval has no authenticated operator process; "approved" can only be set in tests. A reviewed operator workflow (or the verified bank feed) is required.
4. Live collection and code approval are deliberately test-profile-only; a production enablement plan and review are needed.
5. The business has not approved tax treatments (`oupay.pos.approved-tax-treatments` is empty); the tax and receipt rules are a legal and business decision.
6. No exception-resolution workflow (re-reserve, supply anyway, refund, write off), no refund or return workflow, no handover confirmation.
7. KYC evidence handling and bank activation depend on Equity's requirements.

## 6. Release-readiness checklist

| Area | Status |
| --- | --- |
| Backend `mvn -B clean verify` against PostgreSQL 18, SpotBugs 0 | See the run recorded with the review report |
| Flyway V1 to V18 forward-only on a clean database | Verified (disposable databases) |
| Frontend typecheck, lint, build, full Vitest | See the run recorded with the review report |
| Responsive (375, 768, 1280) with real and mock data | Verified; one defect fixed (section 7) |
| Money paths idempotent, concurrent-safe, ledger untouched by inventory | Verified by integration and race tests |
| Real bank adapter, credentials, signature | **Not done: blocked on Equity** |
| Operator approval of collection codes | **Not done** |
| Production secrets, TLS, backups, monitoring, rate limits | Not part of this review; see `docs/operations.md` and `docs/staging-deployment.md` |
| Tax approval, legal receipts, privacy review | **Open business decisions** |
| Data protection, retention, disaster recovery | Not reviewed here |

## 7. Defects found and fixed in this review

* **POS page overflowed on a 375 px phone** once a cart existed: the two-column grid had no base column definition, so its single implicit column grew to its
  widest child (416 px), clipping the search box and "Add" buttons. Fixed with `grid-cols-1` (and the same latent pattern in the invoice form and the code-payment row).
* **Four stale frontend tests** (not product bugs): `deployConfig` asserted the committed `vercel.json` still held the Render placeholder, which was replaced by the real host
  (the test now builds the placeholder itself); three invoice/dashboard tests judged overdue and "due date in the past" against the real clock while their seeds use fixed
  October 2026 dates (they now pin only `Date` through `src/test/seedClock.ts`).
