-- R7b: atomic POS billing and stock reservations. ADDITIVE: V1 to V16 are untouched, no historical invoice, payment, ledger or stock
-- value is rewritten, and the previous application version keeps working (it never reads or writes anything below).
--
--   1. A TAX CLASSIFICATION per catalog item (nullable: "not configured yet" is a real state that BLOCKS billing, never an implicit exempt).
--   2. POS draft status BILLED (final), and pos_sales: the durable link draft -> invoice -> payment request (the code sale).
--   3. pos_sale_lines: the IMMUTABLE catalog snapshot of every invoice line of a POS sale (the invoice itself is untouched).
--   4. stock_reservations / stock_reservation_lines: branch-scoped reservations in canonical NUMERIC units. Physical stock stays in
--      inventory_balances and its append-only movement ledger and is NEVER changed by a reservation.
--          available = physical (inventory_balances.quantity_on_hand) - reserved (lines of ACTIVE reservations)
--      The database refuses an over-reservation and refuses any stock change that would take physical stock below what is reserved.

-- ---------------------------------------------------------------------------------------------
-- 1. Tax classification of a catalog item
-- ---------------------------------------------------------------------------------------------
-- The categories are exactly the invoice model's (V2): NOT_APPLICABLE, EXEMPT, ZERO_RATED (rate 0) and STANDARD (rate in basis points).
-- NULL means NOT CONFIGURED. Nothing is ever defaulted or guessed from a name. WHICH treatments may be billed is a separate,
-- configuration-controlled decision (oupay.pos.approved-tax-treatments): OuPay does not claim any tax compliance.
ALTER TABLE catalog_items
    ADD COLUMN tax_category              varchar(16),
    ADD COLUMN tax_rate_bp               integer,
    ADD COLUMN tax_configured_by_user_id uuid REFERENCES users (id),
    ADD COLUMN tax_configured_at         timestamptz,
    ADD CONSTRAINT ck_catalog_items_tax CHECK (
        (tax_category IS NULL AND tax_rate_bp IS NULL)
        OR (tax_category IN ('NOT_APPLICABLE', 'EXEMPT', 'ZERO_RATED') AND tax_rate_bp = 0)
        OR (tax_category = 'STANDARD' AND tax_rate_bp BETWEEN 1 AND 10000)),
    ADD CONSTRAINT ck_catalog_items_tax_audit CHECK (
        (tax_category IS NULL) = (tax_configured_at IS NULL) AND (tax_category IS NULL) = (tax_configured_by_user_id IS NULL));

-- ---------------------------------------------------------------------------------------------
-- 2. A billed draft, and the sale it became
-- ---------------------------------------------------------------------------------------------
ALTER TABLE pos_drafts DROP CONSTRAINT ck_pos_drafts_status;
ALTER TABLE pos_drafts ADD CONSTRAINT ck_pos_drafts_status CHECK (status IN ('DRAFT', 'DISCARDED', 'BILLED'));

CREATE OR REPLACE FUNCTION guard_pos_draft_line() RETURNS trigger AS $$
DECLARE
    draft_status varchar;
    draft_id_value uuid;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        RAISE EXCEPTION 'a POS draft line is never edited; the lines of a draft are replaced as a whole';
    END IF;
    draft_id_value := CASE WHEN TG_OP = 'DELETE' THEN OLD.draft_id ELSE NEW.draft_id END;
    SELECT status INTO draft_status FROM pos_drafts WHERE id = draft_id_value;
    IF draft_status IS DISTINCT FROM 'DRAFT' THEN
        RAISE EXCEPTION 'the lines of a discarded or billed POS draft can not change';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;

-- DRAFT -> DISCARDED or DRAFT -> BILLED are the only status changes; both are final.
CREATE OR REPLACE FUNCTION guard_pos_draft() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a POS draft is never deleted; it is discarded or billed';
    END IF;
    IF OLD.merchant_id <> NEW.merchant_id OR OLD.branch_id <> NEW.branch_id OR OLD.created_by_user_id <> NEW.created_by_user_id
       OR OLD.client_request_id <> NEW.client_request_id OR OLD.request_sha256 <> NEW.request_sha256 OR OLD.created_at <> NEW.created_at THEN
        RAISE EXCEPTION 'the identity of a POS draft never changes';
    END IF;
    IF OLD.status IN ('DISCARDED', 'BILLED') AND (NEW.status <> OLD.status OR NEW.total_rwf <> OLD.total_rwf OR NEW.line_count <> OLD.line_count
                                                  OR NEW.note IS DISTINCT FROM OLD.note) THEN
        RAISE EXCEPTION 'a discarded or billed POS draft is final';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- The sale a draft became: ONE per draft (the durable identity that makes a Bill retry, however late, return the same sale), tied to the
-- code sale (which is its payment request) and so to the ordinary invoice, payment request and ledger. There is no second ledger.
CREATE TABLE pos_sales (
    payment_request_id  uuid PRIMARY KEY,
    merchant_id         uuid         NOT NULL REFERENCES merchants (id),
    draft_id            uuid         NOT NULL,
    invoice_id          uuid         NOT NULL,
    branch_id           uuid         NOT NULL,
    billed_by_user_id   uuid         NOT NULL REFERENCES users (id),
    -- As the code sale: LIVE or DEMONSTRATION. A demonstration reserves no stock (nothing can ever pay or fulfil it).
    presentation_mode   varchar(14)  NOT NULL,
    -- What the cashier REVIEWED (price, tax and total) and what was billed: the bill is refused unless they are equal.
    reviewed_total_rwf  bigint       NOT NULL,
    subtotal_rwf        bigint       NOT NULL,
    tax_total_rwf       bigint       NOT NULL,
    total_rwf           bigint       NOT NULL,
    line_count          integer      NOT NULL,
    created_at          timestamptz  NOT NULL,
    CONSTRAINT ux_pos_sales_draft UNIQUE (draft_id),
    CONSTRAINT ux_pos_sales_invoice UNIQUE (invoice_id),
    CONSTRAINT ux_pos_sales_id_merchant UNIQUE (payment_request_id, merchant_id),
    CONSTRAINT fk_pos_sales_draft FOREIGN KEY (draft_id, merchant_id) REFERENCES pos_drafts (id, merchant_id),
    CONSTRAINT fk_pos_sales_code_sale FOREIGN KEY (payment_request_id, merchant_id) REFERENCES code_sales (payment_request_id, merchant_id),
    CONSTRAINT fk_pos_sales_invoice FOREIGN KEY (invoice_id, merchant_id, branch_id) REFERENCES invoices (id, merchant_id, branch_id),
    CONSTRAINT ck_pos_sales_mode CHECK (presentation_mode IN ('DEMONSTRATION', 'LIVE')),
    CONSTRAINT ck_pos_sales_money CHECK (subtotal_rwf >= 0 AND tax_total_rwf >= 0 AND total_rwf = subtotal_rwf + tax_total_rwf
                                         AND reviewed_total_rwf = total_rwf),
    CONSTRAINT ck_pos_sales_lines CHECK (line_count BETWEEN 1 AND 50)
);
CREATE INDEX ix_pos_sales_branch ON pos_sales (merchant_id, branch_id, created_at DESC);

CREATE FUNCTION guard_pos_sale() RETURNS trigger AS $$
DECLARE
    draft_row pos_drafts%ROWTYPE;
    invoice_row invoices%ROWTYPE;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'a POS sale is never changed or deleted';
    END IF;
    SELECT * INTO draft_row FROM pos_drafts WHERE id = NEW.draft_id AND merchant_id = NEW.merchant_id;
    SELECT * INTO invoice_row FROM invoices WHERE id = NEW.invoice_id AND merchant_id = NEW.merchant_id;
    IF draft_row.id IS NULL OR draft_row.branch_id <> NEW.branch_id OR draft_row.created_by_user_id <> NEW.billed_by_user_id THEN
        RAISE EXCEPTION 'a POS sale must describe a draft of its own branch, billed by the person who prepared it';
    END IF;
    IF invoice_row.id IS NULL OR coalesce(invoice_row.sale_channel, 'INVOICE') <> 'CODE' OR invoice_row.grand_total_rwf <> NEW.total_rwf
       OR invoice_row.is_demonstration IS DISTINCT FROM (NEW.presentation_mode = 'DEMONSTRATION')
       OR invoice_row.client_request_id IS DISTINCT FROM draft_row.client_request_id THEN
        RAISE EXCEPTION 'a POS sale must describe its own CODE invoice: the same total, mode and durable request identity as its draft';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_pos_sales_guard BEFORE INSERT OR UPDATE OR DELETE ON pos_sales
    FOR EACH ROW EXECUTE FUNCTION guard_pos_sale();

-- A draft is BILLED exactly when its sale exists (checked at commit, so the two are written together or not at all).
CREATE FUNCTION check_pos_draft_billed() RETURNS trigger AS $$
DECLARE
    draft_status varchar;
    draft_id_value uuid;
BEGIN
    IF TG_TABLE_NAME = 'pos_drafts' THEN
        draft_id_value := NEW.id;
    ELSE
        draft_id_value := NEW.draft_id;
    END IF;
    SELECT status INTO draft_status FROM pos_drafts WHERE id = draft_id_value;
    IF (draft_status = 'BILLED') IS DISTINCT FROM EXISTS (SELECT 1 FROM pos_sales WHERE draft_id = draft_id_value) THEN
        RAISE EXCEPTION 'a POS draft is billed exactly when its sale exists';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER trg_pos_drafts_billed AFTER INSERT OR UPDATE ON pos_drafts
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_pos_draft_billed();
CREATE CONSTRAINT TRIGGER trg_pos_sales_billed AFTER INSERT ON pos_sales
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_pos_draft_billed();

-- ---------------------------------------------------------------------------------------------
-- 3. The immutable catalog snapshot of each invoice line of a POS sale
-- ---------------------------------------------------------------------------------------------
-- An invoice line is a description, a quantity in thousandths, a price and a tax. THIS row keeps everything the invoice line can not:
-- the catalog item (identity, type, name, code), the quantity as entered (text and unit or package), the exact selling-unit quantity and
-- the exact canonical quantity, the catalog price VERSION, and the tax classification and amounts. A historical sale never needs a
-- catalog lookup. It must equal the invoice line it describes (checked at insert), and is never changed or deleted.
CREATE TABLE pos_sale_lines (
    invoice_item_id        uuid PRIMARY KEY REFERENCES invoice_items (id),
    invoice_id             uuid         NOT NULL,
    merchant_id            uuid         NOT NULL,
    line_no                integer      NOT NULL,
    catalog_item_id        uuid         NOT NULL,
    item_type              varchar(8)   NOT NULL,
    item_name              varchar(120) NOT NULL,
    item_code              varchar(40),
    measurement_dimension  varchar(8)   NOT NULL,
    entered_quantity       varchar(60)  NOT NULL,
    entered_unit           varchar(8),
    package_id             uuid,
    package_label          varchar(60),
    sale_unit              varchar(8)   NOT NULL,
    quantity_milli         bigint       NOT NULL,
    canonical_quantity     numeric(20,6) NOT NULL,
    price_version          integer      NOT NULL,
    unit_price_rwf         bigint       NOT NULL,
    tax_category           varchar(16)  NOT NULL,
    tax_rate_bp            integer      NOT NULL,
    net_rwf                bigint       NOT NULL,
    tax_rwf                bigint       NOT NULL,
    line_total_rwf         bigint       NOT NULL,
    CONSTRAINT fk_pos_sale_lines_invoice FOREIGN KEY (invoice_id, merchant_id) REFERENCES invoices (id, merchant_id),
    CONSTRAINT fk_pos_sale_lines_item FOREIGN KEY (catalog_item_id, merchant_id) REFERENCES catalog_items (id, merchant_id),
    CONSTRAINT fk_pos_sale_lines_price FOREIGN KEY (catalog_item_id, price_version, unit_price_rwf, sale_unit)
        REFERENCES catalog_item_prices (item_id, version, price_per_sale_unit_rwf, sale_unit),
    CONSTRAINT fk_pos_sale_lines_package FOREIGN KEY (package_id) REFERENCES catalog_item_packages (id),
    CONSTRAINT ck_pos_sale_lines_quantity CHECK (quantity_milli > 0 AND canonical_quantity > 0
                                                 AND (measurement_dimension <> 'COUNT' OR canonical_quantity = trunc(canonical_quantity))),
    CONSTRAINT ck_pos_sale_lines_entry CHECK ((entered_unit IS NOT NULL AND package_id IS NULL AND package_label IS NULL)
                                              OR (entered_unit IS NULL AND package_id IS NOT NULL AND package_label IS NOT NULL)),
    CONSTRAINT ck_pos_sale_lines_tax CHECK (tax_category IN ('NOT_APPLICABLE', 'EXEMPT', 'ZERO_RATED', 'STANDARD') AND tax_rate_bp BETWEEN 0 AND 10000
                                            AND (tax_category = 'STANDARD' OR tax_rate_bp = 0)),
    CONSTRAINT ck_pos_sale_lines_money CHECK (unit_price_rwf > 0 AND net_rwf >= 0 AND tax_rwf >= 0 AND line_total_rwf = net_rwf + tax_rwf),
    CONSTRAINT ux_pos_sale_lines_line UNIQUE (invoice_id, line_no)
);

CREATE FUNCTION guard_pos_sale_line() RETURNS trigger AS $$
DECLARE
    line invoice_items%ROWTYPE;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'the catalog snapshot of a POS sale line is never changed or deleted';
    END IF;
    SELECT * INTO line FROM invoice_items WHERE id = NEW.invoice_item_id AND invoice_id = NEW.invoice_id;
    IF line.id IS NULL OR line.line_no <> NEW.line_no OR line.quantity_milli <> NEW.quantity_milli OR line.unit_price_rwf <> NEW.unit_price_rwf
       OR line.tax_category <> NEW.tax_category OR line.tax_rate_bp <> NEW.tax_rate_bp OR line.net_amount_rwf <> NEW.net_rwf
       OR line.tax_amount_rwf <> NEW.tax_rwf OR line.line_total_rwf <> NEW.line_total_rwf THEN
        RAISE EXCEPTION 'a POS sale line snapshot must equal the invoice line it describes';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM invoices WHERE id = NEW.invoice_id AND merchant_id = NEW.merchant_id AND sale_channel = 'CODE') THEN
        RAISE EXCEPTION 'a POS sale line belongs to a CODE invoice';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_pos_sale_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON pos_sale_lines
    FOR EACH ROW EXECUTE FUNCTION guard_pos_sale_line();

-- ---------------------------------------------------------------------------------------------
-- 4. Stock reservations
-- ---------------------------------------------------------------------------------------------
-- ACTIVE -> FULFILLED (R7c, after verified payment, together with the SALE movement) or ACTIVE -> RELEASED (a documented, guarded
-- manual release; there is NO automatic release). Both are final. A reservation is for ONE invoice at ONE branch.
CREATE TABLE stock_reservations (
    id                   uuid PRIMARY KEY,
    merchant_id          uuid         NOT NULL REFERENCES merchants (id),
    branch_id            uuid         NOT NULL,
    invoice_id           uuid         NOT NULL,
    status               varchar(10)  NOT NULL,
    created_by_user_id   uuid         NOT NULL REFERENCES users (id),
    created_at           timestamptz  NOT NULL,
    -- When the reservation first becomes ELIGIBLE FOR EXPIRY REVIEW: the payment request's expiry plus a configured grace. Metadata only:
    -- nothing happens at this time. An expired request does not prove that no bank payment occurred.
    expiry_review_at     timestamptz  NOT NULL,
    fulfilled_at         timestamptz,
    released_at          timestamptz,
    released_by_user_id  uuid REFERENCES users (id),
    release_reason       varchar(300),
    version              bigint       NOT NULL DEFAULT 0,
    CONSTRAINT ck_stock_reservations_status CHECK (status IN ('ACTIVE', 'FULFILLED', 'RELEASED')),
    CONSTRAINT ck_stock_reservations_state CHECK (
        (status = 'ACTIVE' AND fulfilled_at IS NULL AND released_at IS NULL AND released_by_user_id IS NULL AND release_reason IS NULL)
        OR (status = 'FULFILLED' AND fulfilled_at IS NOT NULL AND released_at IS NULL AND released_by_user_id IS NULL AND release_reason IS NULL)
        OR (status = 'RELEASED' AND released_at IS NOT NULL AND fulfilled_at IS NULL AND released_by_user_id IS NOT NULL
            AND length(btrim(release_reason)) >= 10)),
    CONSTRAINT ck_stock_reservations_review CHECK (expiry_review_at >= created_at),
    -- One reservation per sale: a retry can never reserve twice.
    CONSTRAINT ux_stock_reservations_invoice UNIQUE (invoice_id),
    CONSTRAINT ux_stock_reservations_key UNIQUE (id, merchant_id, branch_id),
    CONSTRAINT fk_stock_reservations_invoice FOREIGN KEY (invoice_id, merchant_id, branch_id) REFERENCES invoices (id, merchant_id, branch_id),
    CONSTRAINT fk_stock_reservations_branch FOREIGN KEY (branch_id, merchant_id) REFERENCES branches (id, merchant_id)
);
CREATE INDEX ix_stock_reservations_review ON stock_reservations (merchant_id, branch_id, expiry_review_at) WHERE status = 'ACTIVE';

CREATE TABLE stock_reservation_lines (
    id                     uuid PRIMARY KEY,
    reservation_id         uuid          NOT NULL,
    merchant_id            uuid          NOT NULL,
    branch_id              uuid          NOT NULL,
    invoice_item_id        uuid          NOT NULL REFERENCES invoice_items (id),
    item_id                uuid          NOT NULL,
    item_type              varchar(8)    NOT NULL DEFAULT 'GOODS',
    measurement_dimension  varchar(8)    NOT NULL,
    -- The quantity reserved, in the item's CANONICAL stock unit, exactly (no rounding anywhere), and what was entered.
    quantity               numeric(20,6) NOT NULL,
    entered_quantity       varchar(60)   NOT NULL,
    entered_unit           varchar(8),
    package_label          varchar(60),
    created_at             timestamptz   NOT NULL,
    CONSTRAINT fk_stock_reservation_lines_reservation FOREIGN KEY (reservation_id, merchant_id, branch_id)
        REFERENCES stock_reservations (id, merchant_id, branch_id),
    -- Only GOODS that have a stock record at THIS branch can be reserved.
    CONSTRAINT fk_stock_reservation_lines_balance FOREIGN KEY (merchant_id, branch_id, item_id)
        REFERENCES inventory_balances (merchant_id, branch_id, item_id),
    CONSTRAINT fk_stock_reservation_lines_item FOREIGN KEY (item_id, merchant_id, item_type, measurement_dimension)
        REFERENCES catalog_items (id, merchant_id, item_type, measurement_dimension),
    CONSTRAINT ck_stock_reservation_lines_goods CHECK (item_type = 'GOODS'),
    CONSTRAINT ck_stock_reservation_lines_quantity CHECK (quantity > 0 AND quantity <= 99999999999999.999999
                                                          AND (measurement_dimension <> 'COUNT' OR quantity = trunc(quantity))),
    CONSTRAINT ux_stock_reservation_lines_item UNIQUE (invoice_item_id)
);
CREATE INDEX ix_stock_reservation_lines_stock ON stock_reservation_lines (merchant_id, branch_id, item_id);

-- Reserved stock of a branch and item: the lines of ACTIVE reservations.
CREATE FUNCTION active_reserved_quantity(p_merchant uuid, p_branch uuid, p_item uuid) RETURNS numeric AS $$
    SELECT coalesce(sum(l.quantity), 0)
      FROM stock_reservation_lines l JOIN stock_reservations r ON r.id = l.reservation_id
     WHERE l.merchant_id = p_merchant AND l.branch_id = p_branch AND l.item_id = p_item AND r.status = 'ACTIVE';
$$ LANGUAGE sql STABLE;

-- THE AUTHORITATIVE AVAILABILITY CHECK. A line is inserted only while the reservation is ACTIVE, and only if the item's AVAILABLE stock covers it.
-- The balance row lock taken here is the same lock every stock movement takes (V10 apply_stock_movement), so a reservation and a stock
-- change to one branch and item are serialised: two cashiers can not reserve the same remaining stock, and an adjustment can not remove it.
CREATE FUNCTION guard_stock_reservation_line() RETURNS trigger AS $$
DECLARE
    on_hand numeric(20,6);
    reservation_status varchar;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'a stock reservation line is never changed or deleted';
    END IF;
    SELECT quantity_on_hand INTO on_hand FROM inventory_balances
        WHERE merchant_id = NEW.merchant_id AND branch_id = NEW.branch_id AND item_id = NEW.item_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'stock can only be reserved where it is recorded';
    END IF;
    SELECT status INTO reservation_status FROM stock_reservations WHERE id = NEW.reservation_id;
    IF reservation_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'lines can only be added to an active reservation';
    END IF;
    IF active_reserved_quantity(NEW.merchant_id, NEW.branch_id, NEW.item_id) + NEW.quantity > on_hand THEN
        RAISE EXCEPTION 'not enough available stock to reserve (available stock is physical stock minus active reservations)';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_stock_reservation_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON stock_reservation_lines
    FOR EACH ROW EXECUTE FUNCTION guard_stock_reservation_line();

-- A reservation has a fixed identity and one legal change: ACTIVE -> FULFILLED or ACTIVE -> RELEASED. Never deleted.
CREATE FUNCTION guard_stock_reservation() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a stock reservation is never deleted';
    END IF;
    IF OLD.merchant_id <> NEW.merchant_id OR OLD.branch_id <> NEW.branch_id OR OLD.invoice_id <> NEW.invoice_id
       OR OLD.created_by_user_id <> NEW.created_by_user_id OR OLD.created_at <> NEW.created_at OR OLD.expiry_review_at <> NEW.expiry_review_at THEN
        RAISE EXCEPTION 'the identity of a stock reservation never changes';
    END IF;
    IF OLD.status <> NEW.status AND OLD.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'a fulfilled or released reservation is final';
    END IF;
    IF OLD.status <> 'ACTIVE' AND (NEW.fulfilled_at IS DISTINCT FROM OLD.fulfilled_at OR NEW.released_at IS DISTINCT FROM OLD.released_at
                                   OR NEW.release_reason IS DISTINCT FROM OLD.release_reason) THEN
        RAISE EXCEPTION 'a fulfilled or released reservation is final';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_stock_reservations_guard BEFORE UPDATE OR DELETE ON stock_reservations
    FOR EACH ROW EXECUTE FUNCTION guard_stock_reservation();

-- Physical stock can never fall below what is reserved. This runs on the balance update the V10 movement trigger performs, so
-- a stock-adjustment OUT (or any future movement) that would strand an active reservation is refused by the database itself.
CREATE FUNCTION guard_balance_not_below_reserved() RETURNS trigger AS $$
BEGIN
    IF NEW.quantity_on_hand < OLD.quantity_on_hand
       AND NEW.quantity_on_hand < active_reserved_quantity(NEW.merchant_id, NEW.branch_id, NEW.item_id) THEN
        RAISE EXCEPTION 'physical stock cannot fall below the quantity reserved for sales';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_inventory_balances_reserved BEFORE UPDATE ON inventory_balances
    FOR EACH ROW EXECUTE FUNCTION guard_balance_not_below_reserved();

-- ---------------------------------------------------------------------------------------------
-- 5. What R7c must handle: a sale that was PAID after its reservation was RELEASED
-- ---------------------------------------------------------------------------------------------
-- A release needs a documented policy but cannot see the future: a bank confirmation can still arrive, and R6d-B applies it to the sale. Stock never
-- goes negative (physical stock moves only through R5c movements), but that sale then has money applied and NO reservation. Fulfilment (R7c) must
-- treat every row of this view as a fulfilment exception (re-check availability, re-reserve or refund), never as an ordinary fulfilment.
CREATE VIEW pos_sale_fulfilment_exceptions AS
SELECT s.payment_request_id AS sale_id, s.merchant_id, s.invoice_id, s.branch_id, r.id AS reservation_id, r.status AS reservation_status,
       s.total_rwf, coalesce(a.applied, 0)::bigint AS applied_rwf
  FROM pos_sales s
  JOIN stock_reservations r ON r.invoice_id = s.invoice_id
  LEFT JOIN LATERAL (SELECT sum(pa.amount_rwf) AS applied FROM payment_allocations pa WHERE pa.invoice_id = s.invoice_id AND pa.status = 'ACTIVE') a ON true
 WHERE r.status = 'RELEASED' AND coalesce(a.applied, 0) > 0;
