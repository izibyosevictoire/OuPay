-- R7a: POS drafts. A POS draft is a CHECKOUT INTENT: a priced cart a cashier prepares from the unified catalog. It is NOT a sale.
-- It is not an invoice (it consumes no invoice number and is never payable), it has no payment request, and it never touches stock: no
-- reservation, no deduction, no SALE movement. R7b turns a draft into an issued invoice, reserves goods and opens the payment request
-- atomically; until then the stock figures shown while building a cart are informational and are rechecked at billing time.
--
-- Why a new table and not an invoice draft: an invoice line is a description, a quantity in thousandths and a unit price. It carries no
-- catalog item, no selling unit, no package, no price version and no six-decimal canonical quantity, so it can not hold the immutable
-- snapshots a POS line needs. Invoice drafts, invoice numbering and issued-invoice immutability are untouched.
--
-- Every line is a snapshot of what was true when the cart was priced: the item (name, code, type, dimension), the quantity as it was
-- entered (text and unit, or package and count), the quantity in the item's selling unit (exact thousandths, never rounded) and in its
-- canonical stock unit (exact NUMERIC(20,6)), the price VERSION and the price of one selling unit. The price comes from the catalog's
-- current price version, never from the client, and a composite foreign key makes the database refuse a line whose price version, price
-- and selling unit are not an actual immutable catalog price version of that item.

CREATE TABLE pos_drafts (
    id                  uuid PRIMARY KEY,
    merchant_id         uuid         NOT NULL REFERENCES merchants (id),
    branch_id           uuid         NOT NULL,
    created_by_user_id  uuid         NOT NULL REFERENCES users (id),
    status              varchar(12)  NOT NULL,
    -- The durable identity of the creating request (R3 pattern): unique per business, so a repeat can never create a second draft.
    client_request_id   uuid         NOT NULL,
    request_sha256      char(64)     NOT NULL,
    note                varchar(200),
    total_rwf           bigint       NOT NULL,
    line_count          integer      NOT NULL,
    created_at          timestamptz  NOT NULL,
    updated_at          timestamptz  NOT NULL,
    version             bigint       NOT NULL DEFAULT 0,
    CONSTRAINT ck_pos_drafts_status CHECK (status IN ('DRAFT', 'DISCARDED')),
    CONSTRAINT ck_pos_drafts_total CHECK (total_rwf >= 0),
    CONSTRAINT ck_pos_drafts_lines CHECK (line_count BETWEEN 1 AND 100),
    CONSTRAINT ck_pos_drafts_sha CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ux_pos_drafts_id_merchant UNIQUE (id, merchant_id),
    CONSTRAINT ux_pos_drafts_client_request UNIQUE (merchant_id, client_request_id),
    CONSTRAINT fk_pos_drafts_branch FOREIGN KEY (branch_id, merchant_id) REFERENCES branches (id, merchant_id)
);
CREATE INDEX ix_pos_drafts_mine ON pos_drafts (merchant_id, created_by_user_id, created_at DESC, id DESC);
CREATE INDEX ix_pos_drafts_branch ON pos_drafts (merchant_id, branch_id, created_at DESC, id DESC);

CREATE TABLE pos_draft_lines (
    id                       uuid PRIMARY KEY,
    draft_id                 uuid         NOT NULL,
    merchant_id              uuid         NOT NULL,
    line_no                  integer      NOT NULL,
    item_id                  uuid         NOT NULL,
    item_type                varchar(8)   NOT NULL,
    item_name                varchar(120) NOT NULL,
    item_code                varchar(40),
    measurement_dimension    varchar(8)   NOT NULL,
    -- What the cashier entered: a plain decimal text and EITHER a unit OR a package and its count.
    entered_quantity         varchar(60)  NOT NULL,
    entered_unit             varchar(8),
    package_id               uuid,
    package_label            varchar(60),
    -- The quantity in the item's selling unit, in exact thousandths (the invoice model's precision). Never rounded: a quantity that is
    -- not a whole number of thousandths of the selling unit is refused before it reaches this table.
    sale_unit                varchar(8)   NOT NULL,
    quantity_milli           bigint       NOT NULL,
    -- The same quantity in the canonical stock unit, exact (what a later stock check and reservation will use).
    canonical_quantity       numeric(20,6) NOT NULL,
    price_version            integer      NOT NULL,
    unit_price_rwf           bigint       NOT NULL,
    line_total_rwf           bigint       NOT NULL,
    CONSTRAINT ck_pos_lines_item_type CHECK (item_type IN ('GOODS', 'SERVICE')),
    CONSTRAINT ck_pos_lines_line_no CHECK (line_no BETWEEN 1 AND 100),
    CONSTRAINT ck_pos_lines_quantity CHECK (quantity_milli > 0 AND canonical_quantity > 0),
    CONSTRAINT ck_pos_lines_money CHECK (unit_price_rwf >= 0 AND line_total_rwf >= 0),
    -- Exactly one of: a unit, or a package. (Written so a NULL can never make it pass.)
    CONSTRAINT ck_pos_lines_entry CHECK ((entered_unit IS NOT NULL AND package_id IS NULL AND package_label IS NULL)
                                         OR (entered_unit IS NULL AND package_id IS NOT NULL AND package_label IS NOT NULL)),
    CONSTRAINT ux_pos_lines_draft_line UNIQUE (draft_id, line_no),
    CONSTRAINT fk_pos_lines_draft FOREIGN KEY (draft_id, merchant_id) REFERENCES pos_drafts (id, merchant_id),
    CONSTRAINT fk_pos_lines_item FOREIGN KEY (item_id, merchant_id) REFERENCES catalog_items (id, merchant_id),
    -- The line's price is an ACTUAL immutable price version of this item, with this price and this selling unit.
    CONSTRAINT fk_pos_lines_price FOREIGN KEY (item_id, price_version, unit_price_rwf, sale_unit)
        REFERENCES catalog_item_prices (item_id, version, price_per_sale_unit_rwf, sale_unit),
    CONSTRAINT fk_pos_lines_package FOREIGN KEY (package_id) REFERENCES catalog_item_packages (id)
);
CREATE INDEX ix_pos_lines_item ON pos_draft_lines (item_id);

-- Lines are evidence of what was priced: never edited. They can be replaced (deleted and inserted) ONLY while their draft is a DRAFT.
CREATE FUNCTION guard_pos_draft_line() RETURNS trigger AS $$
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
        RAISE EXCEPTION 'the lines of a discarded POS draft can not change';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_pos_draft_lines_guard BEFORE INSERT OR UPDATE OR DELETE ON pos_draft_lines
    FOR EACH ROW EXECUTE FUNCTION guard_pos_draft_line();

-- A draft keeps its identity, and its only legal status change is DRAFT -> DISCARDED (R7b will add BILLED, in its own migration).
CREATE FUNCTION guard_pos_draft() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a POS draft is never deleted; it is discarded';
    END IF;
    IF OLD.merchant_id <> NEW.merchant_id OR OLD.branch_id <> NEW.branch_id OR OLD.created_by_user_id <> NEW.created_by_user_id
       OR OLD.client_request_id <> NEW.client_request_id OR OLD.request_sha256 <> NEW.request_sha256 OR OLD.created_at <> NEW.created_at THEN
        RAISE EXCEPTION 'the identity of a POS draft never changes';
    END IF;
    IF OLD.status = 'DISCARDED' AND (NEW.status <> 'DISCARDED' OR NEW.total_rwf <> OLD.total_rwf OR NEW.line_count <> OLD.line_count
                                     OR NEW.note IS DISTINCT FROM OLD.note) THEN
        RAISE EXCEPTION 'a discarded POS draft is final';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_pos_drafts_guard BEFORE UPDATE OR DELETE ON pos_drafts
    FOR EACH ROW EXECUTE FUNCTION guard_pos_draft();

-- At commit, a DRAFT's stored total and line count are exactly what its lines say (so a total can never drift from its lines).
CREATE FUNCTION check_pos_draft_totals() RETURNS trigger AS $$
DECLARE
    target uuid;
    draft pos_drafts%ROWTYPE;
    line_sum bigint;
    line_n integer;
BEGIN
    IF TG_TABLE_NAME = 'pos_drafts' THEN
        target := NEW.id;
    ELSIF TG_OP = 'DELETE' THEN
        target := OLD.draft_id;
    ELSE
        target := NEW.draft_id;
    END IF;
    SELECT * INTO draft FROM pos_drafts WHERE id = target;
    IF draft.id IS NULL OR draft.status <> 'DRAFT' THEN
        RETURN NULL;
    END IF;
    SELECT coalesce(sum(line_total_rwf), 0), count(*) INTO line_sum, line_n FROM pos_draft_lines WHERE draft_id = target;
    IF line_sum <> draft.total_rwf OR line_n <> draft.line_count THEN
        RAISE EXCEPTION 'a POS draft total and line count must equal its lines';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER trg_pos_drafts_totals AFTER INSERT OR UPDATE ON pos_drafts
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_pos_draft_totals();
CREATE CONSTRAINT TRIGGER trg_pos_lines_totals AFTER INSERT OR DELETE ON pos_draft_lines
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_pos_draft_totals();
