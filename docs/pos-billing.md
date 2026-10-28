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
