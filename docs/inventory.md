# Branch inventory foundation (R5c)

Physical stock of **GOODS**, per branch, with an append-only movement history. **Services never have stock.** This
milestone records opening stock, receipts and manual adjustments only: **no reservations, no sales or invoice-linked
deduction, no returns, no POS, no purchase orders or suppliers.** Invoices, payments, the ledger and the catalog are untouched.

Like the catalog it is a BUSINESS-mode feature: every endpoint answers `409 inventory_unavailable` for a SIMPLIFIED merchant.

## Model (Flyway V10, additive)

| Table | Purpose |
| --- | --- |
| `inventory_balances` | One row per (business, branch, goods item): `quantity_on_hand` in the item's **canonical stock unit**, `NUMERIC(20,6)`. |
| `stock_movements` | Immutable facts: type, **signed** canonical `quantity_delta`, `balance_after`, `entered_as`, `reason`, `reference`, the durable `operation_id` + `request_sha256`, actor, time. |

Movement types today: `OPENING`, `RECEIVE`, `ADJUST_IN`, `ADJUST_OUT`. `RESERVE`, `RELEASE`, `SALE`, `RETURN` and `CORRECTION`
are designed for later: each needs its own sign rule in the database, so each arrives with a migration that widens
`ck_stock_movements_type` instead of being allowed (and meaningless) now. Mistakes are corrected by a **new** movement, never by
editing history.

What PostgreSQL enforces by itself (constraints and triggers, whatever the application does):

* **Goods only.** The item key `(id, merchant_id, item_type, measurement_dimension)` (V9) is referenced with `item_type = 'GOODS'`,
  so a service cannot have a balance, even disguised.
* **Merchant and branch isolation.** Balances reference branches by `(branch_id, merchant_id)` and items by the four-column key;
  a movement references the balance by `(merchant_id, branch_id, item_id)`. No cross-business association can exist.
* **Never negative, never beyond `NUMERIC(20,6)`**, and COUNT goods hold **whole pieces** (`trunc` check).
* **Movement shape.** Sign matches the type (add types positive, `ADJUST_OUT` negative), no zero movement, adjustments need a
  reason, `balance_after >= 0` and `balance_after - quantity_delta >= 0`.
* **Stock changes only through a movement.** A balance is born empty (trigger) and its quantity can change ONLY inside the
  BEFORE INSERT trigger of a movement (`apply_stock_movement`). That trigger, under the balance row lock, checks that the movement
  continues exactly from the current balance (`balance_after = current + delta`, compared as numbers), that `OPENING` really is the
  first movement, and then moves the balance in the same statement. A direct `UPDATE inventory_balances SET quantity_on_hand = ...`
  is refused, a movement that does not continue from the balance is refused, and a failure anywhere rolls the movement back with
  the balance change. So every committed quantity change has exactly one immutable movement, whatever SQL is run.
* **Immutable history.** A trigger refuses UPDATE and DELETE on movements; a balance's branch/item identity cannot change.
* **Accountability.** A balance with movements cannot be deleted (foreign key), even when its stock is back to zero; an empty
  balance with no history has nothing to account for and may be removed.
* **One operation id per business** (unique index) and **one `OPENING` per branch and item** (partial unique index).

The invariant `balance == sum(deltas) == newest balance_after` is asserted in the tests after sequential, concurrent and SQL-bypass
attempts. Enforcement choice: database triggers plus constraints, not restricted write access (the application uses one database role,
which must be able to write both tables), and not Java-only invariants (a second code path or a manual SQL fix could bypass them). The
trigger is a deliberate, narrow mechanism (one function, no generic ledger framework). As with any trigger-based guarantee, a
database superuser can disable triggers or set the transaction-local flag the balance trigger reads; that is outside the threat
model of the application role.

## Quantities

All arithmetic is R5a: exact `BigDecimal`, canonical quantities fitting `NUMERIC(20,6)`, no rounding, COUNT whole. A stock entry is
either **amount + unit** (any unit of the item's dimension, converted exactly) or **package + count** (a catalog package of that
item, converted with `PackageConversion`; a fractional package count is fine when the result is exact, e.g. 1.5 cartons of 24 =
36 pieces). An invalid conversion fails before any lock and changes nothing. Quantities travel as strings.

## API (base `/api/v1/merchants/{merchantId}/inventory`)

| Method and path | Permission | Notes |
| --- | --- | --- |
| `GET /options` | `inventory:view` | Branches the caller may see and where they may record stock. |
| `GET /balances?limit&cursor&branchId&itemId&q` | `inventory:view` | Keyset page, newest first. |
| `GET /movements?limit&cursor&branchId&itemId&type` | `inventory:view` | Keyset page, newest first. |
| `POST /opening` | `inventory:adjust` | First stock of an item at a branch; once only, before any other movement. |
| `POST /receive` | `inventory:receive` | Stock received. |
| `POST /adjust` | `inventory:adjust` | `direction` `IN` or `OUT` and a **required** reason. |

A write returns `201` with `{movement, balance, replayed:false}`, or `200` with `replayed:true` when the same operation had
already been recorded. Codes: `insufficient_stock`, `opening_already_recorded`, `operation_id_reuse`, `branch_inactive`,
`inventory_unavailable` (409); `invalid_item`, `package_inactive`, `validation` and R5a's measurement codes (422).

### Permissions

| Permission | Owner | Manager | Cashier |
| --- | --- | --- | --- |
| `inventory:view` | all | all | limited: only their assigned ACTIVE branches |
| `inventory:receive` | all | limited: assigned branches | no |
| `inventory:adjust` | all | limited: assigned branches | no |

Viewing is separate from changing stock; cashiers can never receive or adjust. Writes also require an **ACTIVE** branch and, for a
manager, an active assignment to it (`403` otherwise). "Assigned" always means actively assigned AND the branch is active: an
assignment to a deactivated branch grants neither view nor write. A replay is authorised like the original (a cashier is refused
before any lookup) and another actor reusing an operation id gets a bare `409` without the movement or the balance. Opening stock is a reconciliation of what already exists, so it needs
`inventory:adjust`.

## Concurrency, transactions and idempotency

* **History order is the order the balance changed in.** The time of a movement is taken AFTER the balance lock is held, and the V10 trigger keeps `created_at` strictly increasing per balance (it can move a time forward by microseconds when two movements fall in one clock tick, or the clock steps back). A stable secondary key could not do this: movement ids are random, so a `(created_at, id)` tie would show a running balance out of sequence. Across different balances, ties are ordered by id, which is stable and keeps keyset pagination exact.

* **Transaction ownership.** Each write is one `@Transactional` service method: the movement insert (which the database applies to the
  balance in the same statement) and the audit entry commit or roll back together. The application never updates a balance itself; the
  entity is read-only and refreshed after the insert. Nothing external (no e-mail, no HTTP call) happens inside it, so the whole transaction is safe to
  retry. A failed operation leaves no balance row, no movement and no audit entry (an empty balance created for it rolls back too).
* **Lock order**, always the same: (1) the transaction-scoped advisory lock of `(business, operation id)`, then (2) the row lock of the
  balance (`SELECT ... FOR UPDATE`). One operation touches exactly one balance, so there is no second row lock to order against and
  no deadlock cycle. Authorisation, conversion and fingerprinting happen before either lock.
* **No lost updates, no negative stock.** The balance row lock serialises every change of one balance; the new quantity is checked
  after acquiring it (`insufficient_stock`), and the CHECK constraints are the backstop.
* **Durable idempotency.** Each write carries a client-generated `clientOperationId` (one per submission attempt, kept across retries).
  At most one movement can ever exist per `(business, id)`. The server stores R2's canonical fingerprint of the operation (business, actor,
  type, branch, item, the exact **canonical** quantity, reason, reference). A repeat with an identical fingerprint returns the recorded
  movement (the **current** balance) and never adds stock again; any other request under the same id is `409 operation_id_reuse`.
  The same quantity written another way (1 kg or 1000 g) is the same operation. This does **not** use the 30-day HTTP
  `Idempotency-Key` records, so it holds after they are pruned.
* **First stock of an item.** The empty balance is created with `INSERT ... ON CONFLICT DO NOTHING`, so simultaneous first operations never
  fail on a duplicate key.

## Opening stock (decision)

* One `OPENING` per branch and item, and only before any other movement; an identical replay of the same operation is safe
  (`200`, `replayed: true`), another opening, even with a new operation id, is `409 opening_already_recorded`.
* **Opening stock must be greater than zero.** A zero opening is refused with a clear message (`422`). Trade-off: a zero opening is an
  initialisation, not a stock change, and every movement in this design changes stock (the database refuses a zero movement). To
  support it honestly we would need either to relax that rule for `OPENING` only, which weakens the invariant for little value, or a
  second event stream (a new table or event type) with its own triggers and tests. A branch with no stock needs no entry: the first
  receipt creates the balance. Reported for review rather than built; say if you want a zero-opening initialisation record.

## Inactive catalog products

Stock history stays when a product is deactivated, and authorised users may still **receive, adjust and record opening stock** for an
inactive goods item (the physical stock is real and must stay accountable). Recording stock never reactivates a product or changes
the catalog row, version or price history. Having stock does not make a product sellable: a future POS must check `catalog_items.active`
itself and must not sell an inactive item because it has stock. The UI offers only active goods when recording new stock.

## Integration notes (R5a, R5b, later milestones)

* Stock is kept in the item's canonical stock unit (V9: `g`, `ml`, `mm`, `mm2`, `pc`); the balance DTO also shows the same exact
  quantity in the item's current sale unit. Changing a sale unit or price in the catalog never touches stock. An item's type, dimension and
  stock unit are immutable (V9 trigger), so a balance can never disagree with its item.
* A deactivated catalog item keeps its stock and can still be received or adjusted (stock physically exists); the UI offers active goods.
* **R5d / Business POS** will add `RESERVE`/`RELEASE`/`SALE`/`RETURN`/`CORRECTION` with their own sign rules and `available = on_hand -
  reserved`. A sale will snapshot item, unit, quantity and price version into the invoice line (see `catalog.md`) and deduct
  `MeasuredQuantity.toCanonical()` of exactly what was sold, using the same lock order (operation, then balance), with the sale's
  durable client request id as the operation identity.
* The 3-decimal invoice quantity versus 6-decimal stock quantity decision documented in `measurement.md` and `catalog.md` is still open.

## Known limits

* One movement per operation (no multi-line receipts); no valuation or cost; no stock-take workflow; no per-branch reorder levels.
* Search on balances is a name/code `LIKE` scoped to the business.

> **R7c:** the `SALE` movement now exists. It is posted by the system (no actor) only for a LIVE POS sale paid in full through reconciled bank money, once per reservation line. See `docs/pos-billing.md`.
