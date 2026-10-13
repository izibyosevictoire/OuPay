-- Invoicing. Amounts are whole RWF (BIGINT). Totals are computed by the server; the database
-- additionally guarantees the arithmetic identity and the lifecycle.

CREATE TABLE invoice_number_sequences (
    merchant_id uuid PRIMARY KEY REFERENCES merchants (id),
    last_value  integer NOT NULL DEFAULT 0,
    CONSTRAINT ck_invoice_seq_nonneg CHECK (last_value >= 0)
);

CREATE TABLE invoices (
    id                  uuid PRIMARY KEY,
    merchant_id         uuid         NOT NULL REFERENCES merchants (id),
    invoice_number      varchar(40)  NOT NULL,
    status              varchar(12)  NOT NULL,
    branch_id           uuid         NOT NULL,
    created_by_user_id  uuid         NOT NULL REFERENCES users (id),
    assigned_to_user_id uuid         NOT NULL REFERENCES users (id),
    created_by_name     varchar(120) NOT NULL,
    assigned_to_name    varchar(120) NOT NULL,
    customer_name       varchar(200) NOT NULL,
    customer_email      varchar(254),
    customer_phone      varchar(20),
    customer_address    varchar(300),
    customer_tin        varchar(9),
    merchant_snapshot   text         NOT NULL,
    branch_snapshot     text         NOT NULL,
    currency            varchar(3)   NOT NULL DEFAULT 'RWF',
    tax_mode            varchar(10)  NOT NULL,
    subtotal_rwf        bigint       NOT NULL,
    discount_total_rwf  bigint       NOT NULL,
    tax_total_rwf       bigint       NOT NULL,
    grand_total_rwf     bigint       NOT NULL,
    due_on              date         NOT NULL,
    issued_at           timestamptz,
    cancelled_at        timestamptz,
    voided_at           timestamptz,
    void_reason         varchar(500),
    notes               varchar(1000),
    created_at          timestamptz  NOT NULL,
    updated_at          timestamptz  NOT NULL,
    version             bigint       NOT NULL DEFAULT 1,
    CONSTRAINT ck_invoices_status CHECK (status IN ('DRAFT', 'ISSUED', 'CANCELLED', 'VOIDED')),
    CONSTRAINT ck_invoices_currency CHECK (currency = 'RWF'),
    CONSTRAINT ck_invoices_tax_mode CHECK (tax_mode IN ('EXCLUSIVE', 'INCLUSIVE')),
    CONSTRAINT ck_invoices_amounts CHECK (subtotal_rwf >= 0 AND discount_total_rwf >= 0
        AND tax_total_rwf >= 0 AND grand_total_rwf >= 0),
    CONSTRAINT ck_invoices_identity CHECK (grand_total_rwf =
        CASE tax_mode WHEN 'EXCLUSIVE' THEN subtotal_rwf - discount_total_rwf + tax_total_rwf
                      ELSE subtotal_rwf - discount_total_rwf END),
    CONSTRAINT ck_invoices_issued CHECK (status <> 'ISSUED' OR (issued_at IS NOT NULL AND grand_total_rwf > 0)),
    CONSTRAINT ck_invoices_voided CHECK ((status = 'VOIDED') = (voided_at IS NOT NULL)),
    CONSTRAINT ck_invoices_cancelled CHECK ((status = 'CANCELLED') = (cancelled_at IS NOT NULL)),
    CONSTRAINT ux_invoices_number UNIQUE (merchant_id, invoice_number),
    CONSTRAINT ux_invoices_id_merchant UNIQUE (id, merchant_id),
    CONSTRAINT fk_invoices_branch FOREIGN KEY (branch_id, merchant_id) REFERENCES branches (id, merchant_id)
);
CREATE INDEX ix_invoices_merchant_created ON invoices (merchant_id, created_at DESC);
CREATE INDEX ix_invoices_assignee ON invoices (merchant_id, assigned_to_user_id);

CREATE TABLE invoice_items (
    id              uuid PRIMARY KEY,
    invoice_id      uuid         NOT NULL REFERENCES invoices (id) ON DELETE CASCADE,
    line_no         integer      NOT NULL,
    description     varchar(300) NOT NULL,
    quantity_milli  bigint       NOT NULL,
    unit_price_rwf  bigint       NOT NULL,
    discount_rwf    bigint       NOT NULL,
    tax_category    varchar(16)  NOT NULL,
    tax_rate_bp     integer      NOT NULL,
    net_amount_rwf  bigint       NOT NULL,
    tax_amount_rwf  bigint       NOT NULL,
    line_total_rwf  bigint       NOT NULL,
    CONSTRAINT ck_invoice_items_values CHECK (quantity_milli > 0 AND unit_price_rwf >= 0
        AND discount_rwf >= 0 AND net_amount_rwf >= 0 AND tax_amount_rwf >= 0 AND line_total_rwf >= 0),
    CONSTRAINT ck_invoice_items_tax CHECK (
        tax_category IN ('NOT_APPLICABLE', 'EXEMPT', 'ZERO_RATED', 'STANDARD')
        AND tax_rate_bp BETWEEN 0 AND 10000),
    CONSTRAINT ux_invoice_items_line UNIQUE (invoice_id, line_no)
);

-- Lifecycle and immutability are enforced by the database as well as by the service.
CREATE FUNCTION guard_invoice_update() RETURNS trigger AS $$
BEGIN
    IF OLD.merchant_id <> NEW.merchant_id OR OLD.invoice_number <> NEW.invoice_number THEN
        RAISE EXCEPTION 'invoice identity is immutable';
    END IF;
    IF OLD.status <> NEW.status AND NOT (
        (OLD.status = 'DRAFT' AND NEW.status IN ('ISSUED', 'CANCELLED')) OR
        (OLD.status = 'ISSUED' AND NEW.status = 'VOIDED')) THEN
        RAISE EXCEPTION 'illegal invoice status transition % -> %', OLD.status, NEW.status;
    END IF;
    -- Once issued, money fields never change.
    IF OLD.status <> 'DRAFT' AND (
        OLD.grand_total_rwf <> NEW.grand_total_rwf OR OLD.subtotal_rwf <> NEW.subtotal_rwf OR
        OLD.tax_total_rwf <> NEW.tax_total_rwf OR OLD.discount_total_rwf <> NEW.discount_total_rwf OR
        OLD.tax_mode <> NEW.tax_mode OR OLD.currency <> NEW.currency) THEN
        RAISE EXCEPTION 'issued invoice amounts are immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_invoices_guard BEFORE UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION guard_invoice_update();

CREATE FUNCTION guard_invoice_items_change() RETURNS trigger AS $$
DECLARE
    inv_status varchar;
    target_invoice uuid;
BEGIN
    IF TG_OP = 'DELETE' THEN target_invoice := OLD.invoice_id; ELSE target_invoice := NEW.invoice_id; END IF;
    SELECT status INTO inv_status FROM invoices WHERE id = target_invoice;
    IF inv_status IS NOT NULL AND inv_status <> 'DRAFT' THEN
        RAISE EXCEPTION 'items of a non-draft invoice are immutable';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_invoice_items_guard BEFORE INSERT OR UPDATE OR DELETE ON invoice_items
    FOR EACH ROW EXECUTE FUNCTION guard_invoice_items_change();
