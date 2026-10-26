# Measurement units and exact quantities (R5a)

Backend package `rw.oupay.measurement`. It is a calculation foundation only: there are no tables, APIs,
catalog or inventory features, and no migration. Invoicing is untouched.

## Model

| Type | Role |
| --- | --- |
| `MeasurementDimension` | COUNT, MASS, VOLUME, LENGTH, AREA. COUNT is whole-units-only. |
| `MeasurementUnit` | piece, g, kg, mL, L, mm, m, mm2, m2. Each has a dimension and an exact integer factor to the canonical unit. |
| `MeasuredQuantity` | Immutable `(BigDecimal amount, unit)`. Exact conversion, numeric comparison, `storageValue()` at scale 6. |
| `QuantityPrecision` | The `NUMERIC(20,6)` contract: scale 6, 14 integral digits, max `99999999999999.999999`. |
| `QuantityPolicy` | Sign rules kept apart from the type: `STOCK_BALANCE` (>= 0), `SALE_QUANTITY` (> 0), `STOCK_DELTA` (signed, non-zero). |
| `PackageConversion` | What one package of a product holds, per product (24 pieces, 25 kg, 750 mL). |
| `MeasurementException` | An `ApiException` (HTTP 422) with a stable reason code. |

Canonical units: piece, gram, milliliter, millimeter, square millimeter. Factors: kg 1000, L 1000, m 1000,
m2 1,000,000. No floating point is used anywhere; parsing accepts only plain decimal text with `.` and never
reads the default locale.

## Rules

* **No silent rounding.** A conversion either is exact or is rejected.
* **Precision is judged on the canonical value only**, never on a display scale. Canonical storage is
  `NUMERIC(20,6)`; a larger display unit may need more decimals and stays exact. 0.000001 g is valid and is
  0.000000001 kg; converting back recovers 0.000001 g exactly. 0.0000001 kg is 0.0001 g and is valid;
  0.0000001 g is not representable and is rejected. Trailing zeros never count as precision.
* **Bounds** apply to the canonical value too: `|value| <= 99999999999999.999999`.
* **Extreme programmatic values** (`1E+2147483647`, `1E-2147483647`, scale overflow while multiplying, a
  non-terminating division) are rejected with a domain error (HTTP 422), never an unhandled
  `ArithmeticException`. Magnitude is checked by comparison before any number is expanded. There is no
  arbitrary digit cap: text input of any length is accepted if its value is valid.
* **Counts** must be whole pieces. Fractional pieces are `invalid_count`.
* **Sign** is not a conversion concern. Policies decide it where a use case needs it.
* **Packages** are not global units. A `PackageConversion` is per product: a dimension and a positive canonical
  factor (within `NUMERIC(20,6)`, whole for COUNT). 1.5 cartons of 24 is 36 pieces; 1.5 boxes of 25 is
  rejected (37.5 pieces); 25 pieces in cartons of 24 is rejected (not a terminating decimal). "Whole packages
  only" is a catalog rule for later, not part of this arithmetic.

### Equality

`MeasuredQuantity` is a record whose amount is normalised on construction (no trailing zeros, scale never
negative). Its `equals`/`hashCode` therefore compare normalised amount and unit: `1 g` equals `1.000000 g`
(safe in sets and map keys) but not `0.001 kg`. To compare equivalent quantities in different units use
`compareValue` / `isNumericallyEqualTo`: they compare by value, reject different dimensions and a null, and
are independent of `equals`. The type is not `Comparable`, because cross-dimension ordering is undefined.

Error codes: `unsupported_unit`, `dimension_mismatch`, `invalid_quantity`, `invalid_count`,
`precision_exceeded`, `quantity_out_of_range`, `invalid_package_conversion`. Messages are user-facing and
never echo the raw input.

## Future invoice and inventory integration

**Today.** Invoice lines hold `quantity_milli bigint`: at most three decimals, `> 0`, at most 1,000,000 units
(`InvoiceService`), with no unit column. `InvoiceCalculator.toMilli` rounds half up and is safe only because the
service rejects more than three decimals before calling it. **Future inventory** holds six decimals in the
canonical unit (`NUMERIC(20,6)`). R5a changes neither.

**What a later milestone must do.**

1. The catalog/POS layer converts every entered quantity with `MeasuredQuantity`, exactly. It never reaches
   `InvoiceCalculator` with a quantity it had to round.
2. A future invoice item snapshots the actual **sale unit and sale quantity** (a new unit column or snapshot),
   so later catalog or package edits cannot change how an issued invoice reads. Issued invoices stay immutable.
3. **Stock deduction uses the exact sold quantity converted to canonical units** (`toCanonical()`), never a
   rounded or re-derived value. What is charged is exactly what leaves stock.
4. A product may have a **pricing unit different from its stock unit** (priced per kg, stocked in g, sold by
   the carton). The conversion between them is exact or rejected.
5. Before the catalog connects to invoicing, a milestone must explicitly define how **prices and quantities are
   represented and rounded** (price per unit scale, the single rounding point, how it interacts with the
   existing half-up per line rule). R5a does not decide this.

**Example.** A merchant sells 1.234567 kg. Inventory represents it exactly as 1234.567 g. The existing invoice
model cannot hold 1.234567 kg: it supports three decimals (1.235 would silently drop 0.433 g of stock). A
future flow must do exactly one of: (a) sell in a smaller unit under a documented pricing policy (1234.567 g
has three decimals, so it is representable in grams), or (b) reject the transaction with a clear validation
error. It must never silently round away stock. If invoices ever need more than three decimals, widening
`quantity_milli` is a separate, deliberate migration.

Nothing in R5a changes invoice arithmetic, immutability, payments or allocations.

## Open questions

* Is a divisible COUNT (for example half a portion) ever required? R5a treats pieces as whole only.
* Where is the sale unit stored on an invoice line: a column, or only the catalog snapshot?
* Which unit does a product's price refer to, and who owns the rounding point (catalog or invoice)?
