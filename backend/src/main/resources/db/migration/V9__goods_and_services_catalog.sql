-- R5b: the merchant catalog of GOODS and SERVICES, with immutable price versions and product-specific packages.
--
-- Purely ADDITIVE: three new tables, one function and two triggers. No existing table, row or constraint is touched, so the
-- previous application version keeps working against this schema and rolling back needs no schema change. Invoices,
-- payments and the ledger do not reference the catalog and never will through a live foreign key: a future invoice line
-- SNAPSHOTS what it sold (item, description, unit, quantity, unit price, price version), so editing or deactivating a
-- catalog item can never change a financial record.
--
-- Conventions (see V1): every table carries merchant_id and references stay inside one business through COMPOSITE foreign
-- keys (id, merchant_id). Money is whole RWF in bigint (*_rwf). Quantities use NUMERIC(20,6), the canonical storage
-- contract of the R5a measurement module (14 integral digits, 6 fractional). No floating point anywhere.

-- ---------------------------------------------------------------------------------------------
-- Catalog items (one table, GOODS or SERVICE)
-- ---------------------------------------------------------------------------------------------

CREATE TABLE catalog_items (
    id                      uuid PRIMARY KEY,
    merchant_id             uuid         NOT NULL REFERENCES merchants (id),
    item_type               varchar(8)   NOT NULL,
    name                    varchar(120) NOT NULL,
    description             varchar(500),
    -- Merchant-defined code (SKU), stored UPPERCASE so uniqueness is case-insensitive. Optional.
    code                    varchar(40),
    -- Items are deactivated, never deleted, so future records can always refer to them.
    active                  boolean      NOT NULL DEFAULT true,
    -- What the item is measured in. A service has no stock: it is counted per service unit ('pc').
    measurement_dimension   varchar(8)   NOT NULL,
    -- The canonical unit future stock will be kept in (always the dimension's canonical unit). NULL for a service.
    stock_unit              varchar(4),
    -- The unit the price applies to: ONE of this unit (one kg, one litre, one piece, one service).
    sale_unit               varchar(4)   NOT NULL,
    -- The CURRENT price, copied from the current immutable price version (enforced by fk_catalog_items_current_price).
    price_per_sale_unit_rwf bigint       NOT NULL,
    current_price_version   integer      NOT NULL,
    created_by_user_id      uuid         NOT NULL REFERENCES users (id),
    created_at              timestamptz  NOT NULL,
    updated_at              timestamptz  NOT NULL,
    version                 bigint       NOT NULL DEFAULT 0,
    CONSTRAINT ck_catalog_items_type CHECK (item_type IN ('GOODS', 'SERVICE')),
    CONSTRAINT ck_catalog_items_name CHECK (length(btrim(name)) > 0),
    CONSTRAINT ck_catalog_items_code CHECK (code IS NULL OR code ~ '^[A-Z0-9][A-Z0-9._-]{0,39}$'),
    CONSTRAINT ck_catalog_items_dimension CHECK (measurement_dimension IN ('COUNT', 'MASS', 'VOLUME', 'LENGTH', 'AREA')),
    -- Compatible unit configurations only. A sale unit must belong to the item's dimension, and stock is always kept in the
    -- dimension's canonical unit (matching the R5a measurement module).
    CONSTRAINT ck_catalog_items_units CHECK (
        (item_type = 'SERVICE' AND measurement_dimension = 'COUNT' AND stock_unit IS NULL AND sale_unit = 'pc')
        OR (item_type = 'GOODS' AND stock_unit IS NOT NULL AND (
               (measurement_dimension = 'COUNT'  AND stock_unit = 'pc'  AND sale_unit = 'pc')
            OR (measurement_dimension = 'MASS'   AND stock_unit = 'g'   AND sale_unit IN ('g', 'kg'))
            OR (measurement_dimension = 'VOLUME' AND stock_unit = 'ml'  AND sale_unit IN ('ml', 'l'))
            OR (measurement_dimension = 'LENGTH' AND stock_unit = 'mm'  AND sale_unit IN ('mm', 'm'))
            OR (measurement_dimension = 'AREA'   AND stock_unit = 'mm2' AND sale_unit IN ('mm2', 'm2'))))),
    -- Same ceiling as an invoice line's unit price.
    CONSTRAINT ck_catalog_items_price CHECK (price_per_sale_unit_rwf BETWEEN 0 AND 1000000000),
    CONSTRAINT ck_catalog_items_price_version CHECK (current_price_version >= 1),
    CONSTRAINT ux_catalog_items_id_merchant UNIQUE (id, merchant_id),
    -- The key a package references, so a package can only belong to a GOODS item of the same business and dimension.
    CONSTRAINT ux_catalog_items_package_key UNIQUE (id, merchant_id, item_type, measurement_dimension)
);

-- One code per business (case-insensitive because it is stored uppercase). A different business may reuse it.
CREATE UNIQUE INDEX ux_catalog_items_code ON catalog_items (merchant_id, code) WHERE code IS NOT NULL;
-- The keyset list: newest first, total order (created_at, id).
CREATE INDEX ix_catalog_items_merchant_created ON catalog_items (merchant_id, created_at DESC, id DESC);

-- ---------------------------------------------------------------------------------------------
-- Price versions: append-only history
-- ---------------------------------------------------------------------------------------------

CREATE TABLE catalog_item_prices (
    id                      uuid PRIMARY KEY,
    item_id                 uuid         NOT NULL,
    merchant_id             uuid         NOT NULL,
    -- 1, 2, 3 ... per item. A version is created when the price OR the sale unit changes (a price is per sale unit).
    version                 integer      NOT NULL,
    price_per_sale_unit_rwf bigint       NOT NULL,
    sale_unit               varchar(4)   NOT NULL,
    reason                  varchar(200),
    created_by_user_id      uuid         NOT NULL REFERENCES users (id),
    effective_at            timestamptz  NOT NULL,
    CONSTRAINT fk_catalog_item_prices_item FOREIGN KEY (item_id, merchant_id) REFERENCES catalog_items (id, merchant_id),
    CONSTRAINT ck_catalog_item_prices_version CHECK (version >= 1),
    CONSTRAINT ck_catalog_item_prices_price CHECK (price_per_sale_unit_rwf BETWEEN 0 AND 1000000000),
    CONSTRAINT ck_catalog_item_prices_unit CHECK (sale_unit IN ('pc', 'g', 'kg', 'ml', 'l', 'mm', 'm', 'mm2', 'm2')),
    CONSTRAINT ck_catalog_item_prices_reason CHECK (reason IS NULL OR length(btrim(reason)) > 0),
    CONSTRAINT ux_catalog_item_prices_version UNIQUE (item_id, version),
    -- The key the item's denormalised current price references.
    CONSTRAINT ux_catalog_item_prices_snapshot UNIQUE (item_id, version, price_per_sale_unit_rwf, sale_unit)
);

-- The item's current price, version and unit must be exactly one of its own price versions. Deferred, because the item
-- and its first version are inserted in the same transaction.
ALTER TABLE catalog_items
    ADD CONSTRAINT fk_catalog_items_current_price FOREIGN KEY (id, current_price_version, price_per_sale_unit_rwf, sale_unit)
        REFERENCES catalog_item_prices (item_id, version, price_per_sale_unit_rwf, sale_unit) DEFERRABLE INITIALLY DEFERRED;

CREATE FUNCTION forbid_catalog_price_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'catalog price versions are immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_catalog_item_prices_immutable BEFORE UPDATE OR DELETE ON catalog_item_prices
    FOR EACH ROW EXECUTE FUNCTION forbid_catalog_price_change();

-- What an item IS (its type, measurement dimension and stock unit) can never change once created: future stock will be
-- kept in that unit. Only name, description, code, active, sale unit and price are editable.
CREATE FUNCTION forbid_catalog_item_identity_change() RETURNS trigger AS $$
BEGIN
    IF NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
       OR NEW.item_type IS DISTINCT FROM OLD.item_type
       OR NEW.measurement_dimension IS DISTINCT FROM OLD.measurement_dimension
       OR NEW.stock_unit IS DISTINCT FROM OLD.stock_unit
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'the type, measurement and stock unit of a catalog item cannot change';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_catalog_items_identity BEFORE UPDATE ON catalog_items
    FOR EACH ROW EXECUTE FUNCTION forbid_catalog_item_identity_change();

-- ---------------------------------------------------------------------------------------------
-- Product-specific packages (carton of 24, bag of 25 kg, bottle of 750 mL)
-- ---------------------------------------------------------------------------------------------

-- A package is defined PER ITEM; "carton" is not a global unit. It holds an exact canonical quantity (in the item's stock
-- unit). It has no price of its own: the item's price is per sale unit, a package is just a multiple of it.
CREATE TABLE catalog_item_packages (
    id                    uuid PRIMARY KEY,
    item_id               uuid          NOT NULL,
    merchant_id           uuid          NOT NULL,
    item_type             varchar(8)    NOT NULL DEFAULT 'GOODS',
    measurement_dimension varchar(8)    NOT NULL,
    label                 varchar(60)   NOT NULL,
    quantity_per_package  numeric(20,6) NOT NULL,
    active                boolean       NOT NULL DEFAULT true,
    created_at            timestamptz   NOT NULL,
    updated_at            timestamptz   NOT NULL,
    version               bigint        NOT NULL DEFAULT 0,
    -- Only a GOODS item of the same business, with the same dimension, can own a package.
    CONSTRAINT fk_catalog_item_packages_item FOREIGN KEY (item_id, merchant_id, item_type, measurement_dimension)
        REFERENCES catalog_items (id, merchant_id, item_type, measurement_dimension),
    CONSTRAINT ck_catalog_item_packages_goods CHECK (item_type = 'GOODS'),
    CONSTRAINT ck_catalog_item_packages_label CHECK (length(btrim(label)) > 0),
    CONSTRAINT ck_catalog_item_packages_quantity CHECK (quantity_per_package > 0 AND quantity_per_package <= 99999999999999.999999),
    -- A package of discrete things never contains a fraction of a piece.
    CONSTRAINT ck_catalog_item_packages_whole_pieces CHECK (measurement_dimension <> 'COUNT' OR quantity_per_package = trunc(quantity_per_package))
);
CREATE UNIQUE INDEX ux_catalog_item_packages_label ON catalog_item_packages (item_id, lower(label));
CREATE INDEX ix_catalog_item_packages_item ON catalog_item_packages (item_id);
