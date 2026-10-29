# Business POS billing foundation (R7a)

A BUSINESS merchant builds a **cart of goods and services** from the unified catalog, at **current merchant-defined prices**, in
**exact quantities**, and saves it as an auditable **POS draft**: a checkout _intent_.

**A POS draft is not a sale.** It issues no invoice, consumes no invoice number, creates no payment request, and does **not**
reserve, deduct or move stock. Billing (reserving the goods and atomically issuing the invoice and its payment request) is **R7b**.

## What was reviewed first, and what does not fit

| Existing piece | Finding |
| --- | --- |
| R5a measurement | `MeasuredQuantity` / `QuantityPolicy.SALE_QUANTITY` / `PackageConversion` are reused as they are: exact `BigDecimal`, whole COUNT, `NUMERIC(20,6)`. |
| R5b catalog | Items carry the selling unit and an immutable, versioned price per ONE selling unit. A cart line is priced from the item's **current** version. The catalog has **no tax category**. |
| R5c inventory | Balances are in the canonical unit at `NUMERIC(20,6)`; there are no reservations. Stock is read, never written, by R7a. |
| Invoice model | Quantities are **thousandths** (3 decimals), unit prices whole RWF, half-up rounding once per line. Invoice lines have **no** catalog item, unit, package, price version or six-decimal quantity. |
| R3 provenance / R2 idempotency | The durable client-request identity pattern (unique per business + advisory lock) and `IdempotencyService.executeOnce` are reused for saving. |
| R6c code checkout / R6d allocation | Not involved: R7a creates nothing a bank event could match. |
| Permissions / branch assignment | `invoices:create`, plus the same "actively assigned to an active branch" rule as every checkout (`invoices.formOptions`). |

**Incompatibilities, and the decision for each**

1. _Six-decimal stock vs three-decimal invoices._ A quantity is converted exactly to the selling unit and must be a whole number of
   thousandths of it. Anything finer (for example 0.5 g of a good sold per kg) is **refused** with `quantity_not_representable`; it
   is never rounded.
2. _Invoice lines cannot hold what a POS line must remember._ POS drafts are therefore **not** invoice drafts (see below).
3. _No tax category on catalog items._ A POS line is priced with tax category `NOT_APPLICABLE`, rate 0, EXCLUSIVE, so the line total
   is the plain rounded price. **R7b must decide where the tax category comes from before it issues an invoice**; nothing about
   tax is promised by a draft.

## Architecture decisions

* **A separate, narrowly scoped, additive V16** instead of reusing invoice drafts. Invoice drafts would need a catalog link, unit,
  package, price version and six-decimal quantity on `invoice_items`, which are issued-invoice-immutable financial records; widening
  them risks historic values and the immutability triggers. V1–V15 are untouched.
* **The server prices; the browser never does.** A line names an item, a quantity (decimal **string**), a unit _or_ a package, and
  the price **version the cashier saw**. A different current version is refused with the new version and price (`price_changed`);
  the cashier accepts it explicitly. Any `unitPriceRwf`/`lineTotalRwf` a client sends is ignored.
* **Draft creation is durable and idempotent.** `clientRequestId` is the draft's permanent identity (unique per business); the
  `Idempotency-Key` header is the HTTP retry key. Eight concurrent identical requests make one draft.
* **No new financial path.** The `pos` package never touches `invoices`, `payment_requests`, `stock_movements` or `inventory_balances`
  (only reads balances).

## Schema (V16)

* `pos_drafts`: business, branch (composite FK), creator, `status` (`DRAFT` | `DISCARDED`), `client_request_id` (unique per business),
  `request_sha256`, note, `total_rwf`, `line_count` (1..100), timestamps, `version`.
* `pos_draft_lines`: `line_no` 1..100, item (composite FK to the item and business), **snapshot** of name, code, type, dimension; the
  quantity as entered (`entered_quantity` text + `entered_unit` _or_ `package_id`/`package_label`), `sale_unit`, `quantity_milli`
  (exact thousandths), `canonical_quantity NUMERIC(20,6)`, `price_version`, `unit_price_rwf`, `line_total_rwf`.
* The line's `(item, price_version, unit_price_rwf, sale_unit)` has a **composite FK to `catalog_item_prices`**: a price that was never
  a real price version of that item cannot be stored.
* Triggers: lines are never updated; lines can only be inserted/deleted while the draft is `DRAFT`; a draft is never deleted; its
  identity columns never change; `DISCARDED` is final; a **deferred constraint trigger** checks that the stored total and line count
  equal the lines at commit.

## API (`/api/v1/merchants/{merchantId}/pos`, all `no-store`)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/options` | `READY` / `NOT_BUSINESS` / `NO_BRANCH`, the caller's eligible branches, limits, the stock note |
| GET | `/items?branchId&q&limit` | Active goods and services: current price + version, units, packages, informational stock |
| POST | `/quote` | Prices a cart; each line priced or explained in `problems`; nothing saved |
| POST | `/drafts` | Saves a draft (`Idempotency-Key` header, `clientRequestId` body). 201 created, 200 repeat |
| GET | `/drafts`, `/drafts/{id}` | A cashier sees their own, a manager those of their branches, an owner all |
| PUT | `/drafts/{id}` | Replaces the whole cart (re-priced at the catalog as it is now); `expectedVersion` |
| DELETE | `/drafts/{id}?expectedVersion` | Discards (final, kept on record) |

## Pricing and quantity rules

1. The item must exist for the business (`item_not_found`) and be active (`item_inactive`).
2. `expectedPriceVersion` must equal the current version (`price_changed`).
3. The quantity is plain decimal text (`invalid_quantity`); exactly one of unit / package (`unit_or_package_required`).
4. A unit must measure the item's dimension (`dimension_mismatch`, `unsupported_unit`). COUNT is whole (`invalid_count`); zero or
   out-of-range is `quantity_out_of_range`; more than six canonical decimals is `precision_exceeded`.
5. A package count must be whole (`invalid_package_count`) and the package must be an active package of **that** item.
6. The converted quantity must be a whole number of thousandths of the selling unit (`quantity_not_representable`).
7. Money: `InvoiceCalculator.line` (half-up, **once per line**); overflow is `line_total_too_large`. No floating point anywhere.
8. A line with a positive price that rounds to RWF 0 is refused (`line_total_zero`): rounding never gives goods away. A free item
   (price 0) is allowed.
9. Packages carry **no price** in the catalog. A package is only a whole-number multiple of the item's stock quantity; the item's
   per-selling-unit price is applied **once** to the converted quantity (two 25 kg bags of rice at RWF 1,500/kg = 50 kg = RWF 75,000).
   If package-specific prices are ever added, they need their own explicit, versioned model: nothing is guessed here.
10. Saving refuses the whole cart (`422 invalid_cart`) if any line has a problem; nothing is stored.

## When a price becomes authoritative

A POS price is **never** the price of a bill. Exactly one moment makes a price final: **R7b, inside the transaction that issues the
invoice**, reading the catalog's current price version at that moment.

| Moment | What the price means |
| --- | --- |
| Quote (`/quote`) | The current catalog price, for display. Nothing is stored. |
| Draft saved or updated | A **snapshot**: item, entered quantity and unit, price version, unit price and line total as quoted then. Kept as history, never rewritten (lines are insert/delete only, and a composite foreign key ties each to a real price version). |
| Catalog price changes later | The draft's history does not change. A fresh quote uses the new price; saving or updating a cart that still carries the old version is refused (`price_changed`), so a stale price can not be saved as if it were current. |
| Reopening a draft | The cart is re-priced at today's catalog prices (the cashier is told) before anything can be saved again. |
| **Bill (R7b)** | **Authoritative.** R7b must re-read the current price version and the branch stock inside its own transaction, reject (or ask the cashier to accept) any difference from the draft, and only then issue the invoice and the payment request. The draft snapshot is evidence of what was quoted, never the amount to bill. |

## Tax treatment (provisional)

The catalog has **no tax category**, while invoices do (`NOT_APPLICABLE`, `EXEMPT`, `ZERO_RATED`, `STANDARD` with a rate). R7a does
not assume goods or services are exempt and does not introduce a tax engine: it prices lines with the invoice calculator's
arithmetic and no tax, so every quote and draft total is **provisional** and says so (`taxNote`, and "Provisional total" in the UI).
Invoice tax behaviour is untouched.

**R7b prerequisites:** a configured and validated tax treatment per item (or per business) before any payable invoice is issued; the
authoritative price and stock recheck above; the invoice-line snapshot of catalog item, unit and price version; and the draft-to-invoice
link.

## Stock awareness (informational)

Per goods line: `SUFFICIENT`, `INSUFFICIENT`, `NO_STOCK_RECORD` or (services) `NOT_TRACKED`, computed from the branch balance and the
**total requested for that item across the whole cart** (two lines of one good draw on the same stock). Insufficient stock is a
**warning**, not an error: the cart still prices and saves. Nothing is reserved or deducted, and every response says stock is
checked again when billing.

## Authorization

`invoices:create`; BUSINESS operating mode (`409 pos_unavailable` for SIMPLIFIED, which keeps amount-only checkout); the draft's
branch must be one the caller is actively assigned to (`no_eligible_branch`, `branch_not_eligible`). Only the creator updates or
discards a draft; others get `404`. Cross-business items, prices, stock and drafts are never visible.

## Frontend

`/pos` ("POS billing", BUSINESS mode, `invoices:create`): branch selector when needed, search, add-to-cart, quantity + unit/package
per line, price and version, server-priced line totals and total, stock indicators in words, note, **Save draft / Save changes**,
saved-drafts list with **Open draft** (re-prices at today's prices and says which lines could not be reopened) and **Discard**. The
HTTP and mock services make the same decisions. There is no payment, QR or "billed" state anywhere.

## Known limits and R7b dependencies

* Reopening a draft finds each item again by a catalog search, so an item that is no longer for sale is dropped (and reported).
* No tax category on the catalog: R7b must define it before issuing invoices.
* No reservation: concurrent carts can ask for the same stock. R7b must reserve atomically on "Bill" and recheck.
* The draft keeps no link to the invoice it may become; R7b adds that link (and the invoice-line snapshot of catalog item, unit and
  price version) in its own migration.
* Drafts are not expired or cleaned up; discarding is manual.


---

# R7b: atomic POS billing and stock reservations

R7b turns a reviewed POS draft into **one issued invoice, one fixed-amount payment request through the cashier's collection code, immutable
catalog/price/tax snapshots and a branch-scoped stock reservation**, in ONE transaction. It reuses the invoice engine, R2 idempotency, R3
durable sale identity, the R6c code sale and the R6d ledger: **there is no second ledger**, nothing is marked paid, and **physical stock is never
changed** (fulfilment, the SALE movement, is R7c).

## Architecture assessment: what was inspected and what fits

| Area | Finding | Decision |
| --- | --- | --- |
| Invoice engine | `createDraftFor` + `issue` are public, transactional (join the caller), and carry the R3 durable identity (unique per business). Invoice lines hold description, **thousandths** quantity, price, tax category and rate. Max 50 lines. Price must be above zero. | The POS bill uses them as they are. The draft's own `client_request_id` is the invoice identity. POS carts are now limited to **50 lines** (the invoice ceiling), so a cart that was saved can always be billed. |
| `quantity_milli` | 3 decimals. | Unchanged. R7a already refuses any quantity that is not a whole number of thousandths of the selling unit, so nothing is rounded between the cart, the invoice and the reservation (the reservation keeps the exact canonical `NUMERIC(20,6)` quantity). |
| Tax | The catalog has no tax classification; invoices have `NOT_APPLICABLE / EXEMPT / ZERO_RATED / STANDARD (+ rate)` and EXCLUSIVE/INCLUSIVE arithmetic. | A new explicit, nullable classification per catalog item (V17) plus a configuration-controlled approval list. See "Tax". |
| Code sale (R6c) | `code_sales` has one immutable row per payment request/invoice, with the code, assignment, agent and branch snapshots; it is the only way a code sale exists. Its amount is `> 0`; its description is 120 characters. | **Reused, not extended.** `CodeCheckoutService` was split into `prepareSale` / `draftSale` / `finishSale` (the code-sale path now calls the same three steps), and POS billing calls them inside its own transaction. `pos_sales` links the draft to the code sale; POS provenance needs no change to `code_sales`, so the R3/R6c immutability is intact. |
| Reconciliation (R6d) | Allocation rules for CODE invoices (evidence required, demonstrations never take bank money) are database triggers on `payment_allocations`. | Untouched. A POS sale is a CODE invoice, so every R6d-B rule applies to it unchanged. |
| Inventory (R5c) | `apply_stock_movement` locks the balance row `FOR UPDATE` and is the only way `quantity_on_hand` changes. | Reservations take **the same lock**, so a reservation and a stock movement serialise. The ledger is not touched. |
| Idempotency | `executeOnce` owns the transaction and refuses to run inside one. | `bill` is a non-transactional wrapper like R6c/R7a. |

## Tax: the smallest explicit configuration, and what is still undecided

* `catalog_items.tax_category` / `tax_rate_bp` (+ who and when): `NULL` means **not configured**, which **blocks billing**. Nothing is defaulted,
  inferred from a name, or set to "not applicable". `PUT/GET /catalog/items/{id}/tax` (`catalog:manage` / `catalog:view`, audited, optimistic on the
  item's version). The catalog item dialog has a "Tax treatment" section.
* **Approval is separate from configuration**: `oupay.pos.approved-tax-treatments` (for example `EXEMPT:0,ZERO_RATED:0,STANDARD:1800`) lists the
  treatments a business has approved for **payable POS invoices**. **The default is empty, so no POS invoice can be issued until someone approves
  treatments.** A configured item whose treatment is not on the list is refused (`tax_not_approved`).
* Tax is computed by the server with the invoice calculator (EXCLUSIVE, half up, once per line) and **snapshotted** on the invoice line and in
  `pos_sale_lines`. The browser never sends a rate or an amount.
* OuPay does not claim tax compliance or RRA EBM certification.

**Outstanding decisions (not made here):** which treatments the business approves (`oupay.pos.approved-tax-treatments`), whether prices in the
catalog are tax-exclusive (R7b bills EXCLUSIVE: tax is added to the catalog price), and the correct treatment of each real item. Until then production
POS billing stays disabled by configuration.

## Database (V17, additive)

| Table / change | Purpose |
| --- | --- |
| `catalog_items` + tax columns | The explicit classification (nullable = not configured). |
| `pos_drafts.status` `BILLED` | A billed draft is final and can no longer be edited or discarded. |
| `pos_sales` | Draft → invoice → payment request (the code sale). **Unique draft** (the durable identity), unique invoice. Insert-only; a trigger checks it describes its own CODE invoice (same total, mode and request identity). A draft is `BILLED` exactly when its sale exists (deferred check). |
| `pos_sale_lines` | The immutable snapshot of every invoice line: catalog item (id, type, name, code), entered quantity and unit or package, exact selling-unit quantity (thousandths), exact canonical quantity, price version (foreign key to `catalog_item_prices`), unit price, tax category, rate and amounts. Must equal its invoice line; never changed or deleted. |
| `stock_reservations` | One per invoice (unique), branch-scoped. `ACTIVE → FULFILLED | RELEASED` (final), with `expiry_review_at`, release time, who and why. Never deleted. |
| `stock_reservation_lines` | One per goods invoice line: item, canonical `NUMERIC(20,6)` quantity, what was entered. Insert-only. A trigger locks the balance row and refuses a line beyond the **available** stock. |
| `guard_balance_not_below_reserved` | A trigger on `inventory_balances`: physical stock can never fall below the active reservations. |

V1 to V16 are untouched; no historical invoice, payment or stock value changes.

## Stock model

```
physical  = inventory_balances.quantity_on_hand    (only R5c movements change it)
reserved  = sum of lines of ACTIVE reservations
available = physical - reserved
```

Billing **never** subtracts physical stock and posts no movement. The inventory API now reports `quantityReserved` and `quantityAvailable`; the cart,
review and sale views show physical, reserved and available apart. A stock adjustment OUT is refused with `stock_reserved` when it would take
physical stock below what is reserved (and the database refuses it too). Receipts only add stock. **Services never reserve.** A DEMONSTRATION sale
reserves **nothing** (it can never be paid or fulfilled, so holding stock for it could never end) and says so.

## The bill, step by step (`POST /pos/drafts/{id}/bill`)

One transaction (owned by `IdempotencyService.executeOnce`), in this lock order:

1. the idempotency claim; 2. the **POS draft row** `FOR UPDATE` (only its creator may bill); 3. the **stock balance rows of the cart's goods, in
ascending item id** `FOR UPDATE` (the same lock every stock movement takes); 4. the invoice sequence and the new invoice (existing engine); then the
invoice lock the payment request and bank paths already use.

Bank-event and reconciliation transactions never touch inventory or reservations, and stock movements never touch drafts or invoices, so no lock
cycle exists. Steps: re-check branch and cashier; re-read **current catalog prices and tax**; re-validate every quantity and unit; read availability
under the locks; refuse unless the server's total **equals the total the cashier reviewed** (`review_changed` otherwise, with the new figure);
create the invoice under the draft's durable identity; verify the invoice engine computed exactly the reviewed money; insert the snapshots;
issue; open the fixed-amount payment request through the cashier's eligible code; record the code sale (assignment snapshot); reserve the goods
(LIVE only); mark the draft `BILLED` and write `pos_sales`. **Any failure rolls back everything; the draft stays editable.**

Review before billing: `GET /pos/drafts/{id}/billing-review` returns the same computation with every problem explained (no tax classification,
unapproved treatment, price changed since the draft, insufficient stock, no code...). `billable` is true only when there is none.

## Idempotency and replay

* Same HTTP key and bill: the stored answer (R2). Same draft, new key, same total/code: the **same sale** (the durable `pos_sales` row), even after
  every `idempotency_keys` row is deleted. Another total or code for an already-billed draft: `409 bill_conflict`. A stale draft version:
  `409 version_conflict`.
* Concurrent bills of one draft make one invoice, one payment request and one reservation (draft row lock + unique draft/invoice/reservation).
* Every replay re-checks the caller (membership, permission, creator) before answering.
* A replay never creates a reservation: it only reads.

## Reservation lifetime and release

* The code payment request lives **30 minutes**. The reservation is **not** tied to that timer: it starts `ACTIVE` and records
  `expiry_review_at = request expiry + oupay.pos.reservation-review-grace` (default 24 h). That time only says when a release **may be considered**.
* **There is no automatic release and no worker.** An expired request does not prove that no bank payment occurred: R6d-B still applies a late
  confirmation to the sale. Frontend timers never release anything.
* `POST /pos/sales/{id}/release-reservation` (owner, `invoices:void`, with a written reason) is allowed only when: the reservation is `ACTIVE` and its
  review time has passed; the payment request is **EXPIRED or CANCELLED**; **no** payment is applied to the invoice; and **no** non-failed bank
  transaction references the sale (a verified but unmatched payment is evidence for reconciliation and keeps the reservation). Anything uncertain
  refuses (`release_blocked_payment_evidence`, `release_too_early`, `payment_request_still_open`). The invoice itself is not voided.
* A late payment after a release (or after nothing happens) cannot make stock negative: physical stock only changes through R5c movements, which
  refuse to go below zero or below active reservations. **R7c must define fulfilment of a paid sale whose reservation was released** (re-reserve or
  flag for review): that rule is deferred, not invented here.

## Demonstration isolation

A simulated code makes a DEMONSTRATION sale: a real internal invoice flagged `is_demonstration` (numbered `DEMO-`, excluded from every list, total and
report), no bank money can ever be applied to it (R6c/R6d triggers), no reservation, and everything shown says DEMONSTRATION ONLY. Live collection
stays disabled by `oupay.code-checkout.live-enabled` (and cannot be enabled outside the test profile).

## Frontend

The POS page now has **Review and bill** (offered only for the saved, unchanged draft): the server's final lines (current price and version, whether the
price changed since the draft, tax treatment and amounts, physical/reserved/available stock), the subtotal, tax and total, the DEMONSTRATION/LIVE
banner, the code choice when several are usable, and **Bill RWF x**. The retry key is remembered per bill, so "Try again" after a lost answer finds
the same sale. After billing: the lines and tax, the reservation outcome ("Goods reserved (not sold)", "No stock reserved"), the link to the
invoice, and the existing code-sale receipt (reference, code or demonstration notice, live status). **Paid appears only when verified money was
applied.** The mock service bills through the mock code checkout (a demonstration only) and reserves nothing.

## Not in R7b

Physical fulfilment / SALE movements and the paid-after-release rule (R7c), refunds, RRA EBM, a real Equity integration, barcode scanning,
purchasing, reporting changes, an automatic release worker.


## R7b review addendum

**Mock and server parity.** The frontend mock bills a POS cart as the cart: one invoice line per cart line (name, selling unit, quantity, price, tax category and
rate, line total), priced by the existing invoice calculation (`calculateLine`; there is no second engine) and billed through the mock code checkout with a
`DEMO-` number, flagged as a demonstration and excluded from invoice lists. It reserves nothing and changes no stock. A retry returns the same sale (the
draft's own identity is the sale's `clientRequestId`). The mock-only `billCart` extension does not change the `CodeCheckoutService` interface the server
implements. Known differences: the mock only ever bills demonstrations, and its tax classifications and approvals are fixed sample data.

**Demonstration presentation.** Everywhere a demonstration bill is shown (the final review, the POS sale, the agent's receipt and the customer's page) it
says: this is a demonstration bill; it is not payable through a real Equity code; no real bank payment has been made; and (for the business) physical stock has
not been reserved or deducted. A demonstration never shows "Reserved", "Fulfilled" or "Released": its stock block reads "Stock not reserved or deducted
(demonstration)".

**Release is one atomic decision.** The release holds the invoice row lock (the lock every allocation takes), reads the evidence in the same transaction and
updates the reservation with `WHERE status = 'ACTIVE'`: of any number of concurrent releases exactly one succeeds (`reservation_not_active` for the rest).
Bank-event and ledger transactions never touch inventory or reservations (they lock the bank transaction, then the invoices), and a release never locks
bank rows, so there is no lock cycle. **One residual window is deliberate and visible:** a bank transaction that is committed after the release read its
evidence is not seen by that release. R6d-B then applies it to the sale as it does to any late payment, stock stays non-negative (physical stock only moves
through R5c movements), and the sale shows up in `pos_sale_fulfilment_exceptions` (a V17 view: a sale with money applied and a RELEASED reservation).
**R7c must treat every row of that view as a fulfilment exception** (re-check availability, re-reserve or refund), never fulfil it as usual. An expired
payment request alone proves nothing: a pending or confirmed bank transaction naming the sale keeps the stock reserved.

**Tax and invoice snapshots.** No item is billed without an explicit classification that is also on the approved list; the server calculates and snapshots tax,
re-reads the catalog price at Bill, and refuses a total that differs from the reviewed one. The invoice's lines, quantities, prices, tax and total are tested
line by line against the review and `pos_sale_lines`, and each reservation line equals the canonical quantity of its snapshot. **Tax-exclusive pricing
(tax added on top of the catalog price) still needs the business's approval**, as do the approved treatments and each item's classification: until then
production POS billing stays disabled.
