# Goods and services catalog (R5b)

A merchant-scoped catalog of GOODS and SERVICES, managed together by one BUSINESS merchant. It is a master-data
foundation only: **no stock, no stock ledger, no reservations, no POS, no catalog-based invoicing, no RRA EBM.**
Existing invoices, payments and the ledger are untouched, and `InvoiceCalculator` is unchanged.

SIMPLIFIED merchants keep the amount-only checkout and have **no** catalog: every catalog endpoint answers
`409 catalog_unavailable` for them, and the frontend hides the navigation. BUSINESS merchants (and any merchant without a
settings row) have the catalog.

## Model (Flyway V9)

| Table | Purpose |
| --- | --- |
| `catalog_items` | One row per good or service: `item_type` GOODS/SERVICE, name, description, optional `code` (stored UPPERCASE), `active`, `measurement_dimension`, `stock_unit`, `sale_unit`, the current `price_per_sale_unit_rwf` and `current_price_version`, `version` (optimistic lock). |
| `catalog_item_prices` | Immutable price versions (append-only; a trigger refuses UPDATE and DELETE). |
| `catalog_item_packages` | Product-specific packages: label plus an exact `NUMERIC(20,6)` quantity in the item's stock unit. |

Database guarantees (each is a constraint or trigger, so a bug or a lost race cannot break them):

* **Merchant isolation by keys.** Every table carries `merchant_id`; prices and packages reference their item through the
  composite key `(id, merchant_id)`. A package additionally references `(id, merchant_id, item_type, measurement_dimension)`,
  so it can belong only to a GOODS item of the same business and dimension.
* **Unit compatibility** (`ck_catalog_items_units`): a service is `COUNT`/`pc` with no stock unit; goods keep stock in the
  dimension's canonical unit (g, ml, mm, mm2, pc) and may sell in any unit of that dimension (kg, l, m, m2, ...).
* **Item identity is immutable.** A trigger refuses to change `item_type`, `measurement_dimension`, `stock_unit`,
  `merchant_id` or the creator. Future stock will be kept in that unit; to change it, deactivate the item and create a new one.
* **The current price is one of the item's own versions** (deferred composite foreign key on
  `(id, current_price_version, price, sale_unit)`), so the denormalised price can never drift from the history.
* **Unique codes per merchant** (partial unique index, case-insensitive because codes are stored uppercase); items without a
  code never collide; another business may reuse a code.
* **No floating point.** Prices are `bigint` whole RWF (0 to 1,000,000,000, the invoice line ceiling). The only decimal column
  is the package quantity, `NUMERIC(20,6)`, the R5a canonical storage contract.
* **Deactivate, never delete.** There is no DELETE endpoint; `active` toggles availability.

## Units and prices

R5a's `MeasurementUnit` / `PackageConversion` do all unit arithmetic. Each GOODS item has a dimension (COUNT, MASS, VOLUME,
LENGTH, AREA), a canonical **stock unit** and a **sale unit** of the same dimension. Examples: rice stock `g`, sell `kg`; oil
stock `ml`, sell `l`; fabric stock `mm`, sell `m`; tiles stock `mm2`, sell `m2`; phones `pc`/`pc`. A SERVICE is counted per
service unit (`pc`) and has no stock.

**`pricePerSaleUnitRwf` is the price of ONE sale unit** (one kg, one litre, one piece, one service). A package has **no
price of its own**; it is a multiple of the sale unit (`quantityInSaleUnit`). What a package costs is therefore
`price x quantityInSaleUnit`, which can be fractional RWF; **how that is rounded is deliberately not decided here** (see
"Decisions needed before R5c").

Prices must be whole RWF. They are received as exact decimals and a fractional value such as `10.5` is rejected with `400`
(never truncated to 10 by the JSON mapper, which would otherwise coerce a float into a `long`); `10.0` is accepted as 10, and
out-of-range values answer `422`.

A price version is appended whenever the price **or the sale unit** changes, because a price only has meaning per unit.
Renaming, re-coding or describing an item does not create one. An unchanged update is a no-op (no version bump, no audit).

Packages are defined per item ("Carton" = 24 pc for one product, 12 pc for another). The quantity is exact
(`PackageConversion`): a COUNT package must be whole pieces, a result that does not fit `NUMERIC(20,6)` is rejected, and
nothing is rounded. A service cannot have packages. At most 20 packages per item.

## API

Base `/api/v1/merchants/{merchantId}/catalog`. The merchant comes only from the URL. Money is integer RWF; quantities are plain
decimal **strings**. Null fields are omitted (the API uses `non_null` inclusion).

| Method and path | Permission | Notes |
| --- | --- | --- |
| `GET /measurement-units` | `catalog:view` | Dimensions and their units, from the server (the UI does not hard-code them). |
| `GET /items?limit&cursor&q&type&active` | `catalog:view` | Keyset pagination, newest first. `q` matches name or code, case-insensitive, `%` and `_` are literal. |
| `POST /items` | `catalog:manage` | GOODS need `measurementDimension` and `saleUnit`; a SERVICE must omit them. |
| `GET /items/{id}` | `catalog:view` | |
| `PUT /items/{id}` | `catalog:manage` | `expectedVersion` required. Type, dimension and stock unit cannot change. |
| `PUT /items/{id}/status` | `catalog:manage` | `{expectedVersion, active}`. |
| `GET /items/{id}/price-history` | `catalog:view` | Newest first. |
| `POST /items/{id}/packages` | `catalog:manage` | `{label, contentsAmount, contentsUnit}`, e.g. `Bag`, `25`, `kg`. |
| `PUT /items/{id}/packages/{packageId}` | `catalog:manage` | Own `expectedVersion`; deactivate with `active: false`. |

Errors use the existing shape. Catalog codes: `catalog_unavailable` (409), `duplicate_code` (409), `duplicate_label` (409),
`version_conflict` (409), `invalid_unit_configuration` (422), plus R5a's `unsupported_unit`, `dimension_mismatch`,
`invalid_quantity`, `invalid_count`, `precision_exceeded`, `quantity_out_of_range`, `invalid_package_conversion` (all 422).

### Authorisation (RBAC extension)

Two permissions were added, the smallest extension of the existing matrix (backend `Permission`, frontend
`permissionDefinitions.ts`):

| Permission | Owner | Manager | Cashier |
| --- | --- | --- | --- |
| `catalog:view` | yes | yes | **read-only** |
| `catalog:manage` | yes | yes | **no** |

Cashiers can read the catalog (they will sell from it) but never create, edit, reprice, activate or define packages.
A non-member gets 404 and a member without the permission gets 403, as everywhere else.

### Concurrency

A change locks the item row (`SELECT ... FOR UPDATE`), then compares `expectedVersion`: of several simultaneous edits from the
same version exactly one wins and the others get `409 version_conflict`, so nothing is lost silently. Two simultaneous creations
with the same code create exactly one item (the unique index decides; the loser gets `409 duplicate_code`). The `@Version`
column and the constraints are the backstop.

### Audit

`CATALOG_ITEM_CREATED`, `CATALOG_ITEM_UPDATED`, `CATALOG_PRICE_CHANGED` (old and new price and unit, and the version),
`CATALOG_ITEM_ACTIVATED`, `CATALOG_ITEM_DEACTIVATED`, `CATALOG_PACKAGE_CREATED`, `CATALOG_PACKAGE_UPDATED`, written in the
same transaction as the change.

## History and future invoice snapshots

Nothing financial references the catalog (no foreign key from any invoice, payment or ledger table; a test asserts it).
Price versions exist so a sale can say exactly which price it used. **R5c / Business POS must snapshot, into the invoice line
itself**, at the moment of sale: item id and code, the description as sold, **sale unit and sale quantity**, **unit price**,
the tax treatment, and the **price version** (`catalog_item_prices.version`). The line then never depends on the live item:
editing, repricing, deactivating or even later restructuring the catalog cannot change an issued invoice, and the snapshot
is enough to reproduce the stock effect (`MeasuredQuantity.toCanonical()` of the exact sold quantity, see `measurement.md`).

## Decisions needed before R5c

1. **Quantity precision.** An invoice line holds three decimals (`quantity_milli`); a catalog quantity can be exact to six
   decimals in the canonical unit. A sale such as 1.234567 kg must either be sold in a smaller unit under a documented pricing
   policy (1234.567 g) or be rejected; it must never be rounded.
2. **Package pricing.** Price of a package = price per sale unit x quantity in sale unit, possibly fractional RWF: who rounds,
   where, and how that interacts with the invoice's half-up-per-line rule.
3. **Where the sale unit lives on an invoice line** (a new column, or only the snapshot).
4. **Tax treatment source.** Items carry no tax category yet; R5c must decide whether it lives on the item (with its own
   snapshot) or is chosen per sale.
5. **Branch scoping.** The catalog is merchant-wide; per-branch availability and stock arrive with inventory.
