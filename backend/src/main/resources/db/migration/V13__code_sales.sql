-- R6c: agent code-based checkout. A "code sale" is an ordinary invoice with a fixed-amount payment request (the existing financial
-- infrastructure: no second ledger), plus ONE immutable record of WHICH collection code and WHICH assignment it was made through.
--
-- Nothing here is, or claims to be, a real Equity payment instruction. A sale made through a simulated code is a DEMONSTRATION and the
-- database refuses to record it as anything else; a LIVE sale needs a bank-approved, non-simulated code.
--
-- ADDITIVE, with two WIDENINGS of existing allow-lists (a new value is accepted; nothing is removed or relaxed otherwise):
--   * invoices.sale_channel and payment_requests.source accept 'CODE' (the provenance of a code sale);
--   * the V8 insert guard treats 'CODE' like 'POS' and 'SIMPLIFIED' (a request for such an invoice MUST record its source).
-- V1 to V12 are untouched. The previous application version keeps working: it never writes 'CODE'.
--
-- Everything a historical sale needs is COPIED into the sale row (code, agent, assignment, branch and account as they were), so a later
-- reassignment, suspension or branch change can never change how the sale is read.

ALTER TABLE invoices DROP CONSTRAINT ck_invoices_sale_channel;
ALTER TABLE invoices ADD CONSTRAINT ck_invoices_sale_channel CHECK (sale_channel IS NULL OR sale_channel IN ('INVOICE', 'POS', 'SIMPLIFIED', 'CODE'));

ALTER TABLE payment_requests DROP CONSTRAINT ck_payment_requests_source;
ALTER TABLE payment_requests ADD CONSTRAINT ck_payment_requests_source CHECK (source IS NULL OR source IN ('OPEN', 'INVOICE', 'POS', 'SIMPLIFIED', 'CODE'));

CREATE OR REPLACE FUNCTION guard_payment_request_provenance() RETURNS trigger AS $$
DECLARE
    channel varchar;
    link_branch uuid;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.source IS DISTINCT FROM NEW.source OR OLD.branch_id IS DISTINCT FROM NEW.branch_id
           OR OLD.created_by_user_id IS DISTINCT FROM NEW.created_by_user_id THEN
            RAISE EXCEPTION 'payment request provenance is fixed when the request is created';
        END IF;
        RETURN NEW;
    END IF;
    IF NEW.invoice_id IS NOT NULL THEN
        SELECT coalesce(sale_channel, 'INVOICE') INTO channel
          FROM invoices WHERE id = NEW.invoice_id AND merchant_id = NEW.merchant_id;
        IF channel IN ('POS', 'SIMPLIFIED', 'CODE') AND NEW.source IS NULL THEN
            RAISE EXCEPTION 'a payment request for a POS, simplified or code sale invoice must record its source';
        END IF;
        IF NEW.source IS NOT NULL AND channel IS DISTINCT FROM NEW.source THEN
            RAISE EXCEPTION 'payment request source must match the sale channel of its invoice';
        END IF;
    ELSIF NEW.source = 'OPEN' AND NEW.branch_id IS NOT NULL THEN
        SELECT branch_id INTO link_branch FROM payment_profiles WHERE id = NEW.payment_profile_id AND merchant_id = NEW.merchant_id;
        IF NEW.branch_id IS DISTINCT FROM link_branch THEN
            RAISE EXCEPTION 'an open payment request can only carry the branch of its own payment link';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE code_sales (
    -- The sale IS its payment request: same id, and the unique sale reference the customer quotes is that request's public reference.
    payment_request_id        uuid PRIMARY KEY,
    merchant_id               uuid         NOT NULL REFERENCES merchants (id),
    invoice_id                uuid         NOT NULL,
    branch_id                 uuid         NOT NULL,
    sale_reference            varchar(24)  NOT NULL,
    amount_rwf                bigint       NOT NULL,
    description               varchar(120) NOT NULL,
    -- LIVE: a bank-approved code on a real account. DEMONSTRATION: a simulated code; no real bank payment can be made with it.
    presentation_mode         varchar(14)  NOT NULL,
    -- WHO and THROUGH WHAT, as they were when the sale was made.
    agent_user_id             uuid         NOT NULL REFERENCES users (id),
    agent_name                varchar(120) NOT NULL,
    collection_code_id        uuid         NOT NULL,
    assignment_id             uuid         NOT NULL,
    code_provider_id          varchar(24)  NOT NULL,
    code_internal_ref         varchar(11)  NOT NULL,
    code_label                varchar(60)  NOT NULL,
    -- The bank-issued code at the time: NULL for a demonstration (OuPay never invents a bank code).
    code_external_code        varchar(64),
    code_status               varchar(20)  NOT NULL,
    code_is_simulated         boolean      NOT NULL,
    settlement_destination_id uuid         NOT NULL,
    settlement_masked_account varchar(40)  NOT NULL,
    assignment_kind           varchar(16)  NOT NULL,
    assignee_membership_id    uuid,
    assignee_name             varchar(120) NOT NULL,
    assignee_role             varchar(16),
    assignment_valid_from     timestamptz  NOT NULL,
    branch_name               varchar(120) NOT NULL,
    branch_code               varchar(12),
    created_at                timestamptz  NOT NULL,
    CONSTRAINT ux_code_sales_reference UNIQUE (sale_reference),
    CONSTRAINT ux_code_sales_invoice UNIQUE (invoice_id),
    CONSTRAINT ux_code_sales_id_merchant UNIQUE (payment_request_id, merchant_id),
    CONSTRAINT fk_code_sales_request FOREIGN KEY (payment_request_id, merchant_id) REFERENCES payment_requests (id, merchant_id),
    CONSTRAINT fk_code_sales_invoice FOREIGN KEY (invoice_id, merchant_id, branch_id) REFERENCES invoices (id, merchant_id, branch_id),
    CONSTRAINT fk_code_sales_code FOREIGN KEY (collection_code_id, merchant_id) REFERENCES collection_codes (id, merchant_id),
    CONSTRAINT fk_code_sales_assignment FOREIGN KEY (assignment_id, merchant_id) REFERENCES collection_code_assignments (id, merchant_id),
    CONSTRAINT fk_code_sales_destination FOREIGN KEY (settlement_destination_id, merchant_id, code_provider_id)
        REFERENCES payment_destinations (id, merchant_id, provider_id),
    CONSTRAINT ck_code_sales_amount CHECK (amount_rwf > 0),
    CONSTRAINT ck_code_sales_description CHECK (length(btrim(description)) > 0),
    CONSTRAINT ck_code_sales_mode CHECK (presentation_mode IN ('DEMONSTRATION', 'LIVE')),
    -- A demonstration is a simulated code with no bank code; a live sale is a real, ACTIVE code that has its bank-issued value.
    CONSTRAINT ck_code_sales_honesty CHECK (
        (presentation_mode = 'DEMONSTRATION' AND code_is_simulated)
        OR (presentation_mode = 'LIVE' AND NOT code_is_simulated AND code_status = 'ACTIVE' AND code_external_code IS NOT NULL)),
    CONSTRAINT ck_code_sales_assignee CHECK (
        (assignment_kind = 'MEMBER' AND assignee_membership_id IS NOT NULL)
        OR (assignment_kind = 'COLLECTION_POINT' AND assignee_membership_id IS NULL))
);
CREATE INDEX ix_code_sales_agent ON code_sales (merchant_id, agent_user_id, created_at DESC);
CREATE INDEX ix_code_sales_code ON code_sales (collection_code_id, created_at DESC);

-- DEMONSTRATION sales. A demonstration is a real issued invoice (the checkout demonstration needs one) but it is NOT a business record:
-- every list, total, report and outside system must skip it. The flag is one immutable column set when the invoice is created, so a
-- consumer has ONE thing to test, and the database keeps it consistent with the sale's mode (guard_code_sale below).
ALTER TABLE invoices ADD COLUMN is_demonstration boolean NOT NULL DEFAULT false;
ALTER TABLE invoices ADD CONSTRAINT ck_invoices_demonstration CHECK (NOT is_demonstration OR sale_channel = 'CODE');
CREATE INDEX ix_invoices_real ON invoices (merchant_id, created_at DESC) WHERE NOT is_demonstration;

-- Demonstrations are numbered from their own series (DEMO-0001...): they never consume, or leave a gap in, the real INV- numbers.
CREATE TABLE demo_invoice_number_sequences (
    merchant_id uuid PRIMARY KEY REFERENCES merchants (id),
    last_value  integer NOT NULL DEFAULT 0,
    CONSTRAINT ck_demo_invoice_seq_nonneg CHECK (last_value >= 0)
);

CREATE OR REPLACE FUNCTION guard_invoice_provenance() RETURNS trigger AS $$
BEGIN
    IF OLD.sale_channel IS DISTINCT FROM NEW.sale_channel OR OLD.client_request_id IS DISTINCT FROM NEW.client_request_id
       OR OLD.client_request_sha256 IS DISTINCT FROM NEW.client_request_sha256 OR OLD.is_demonstration IS DISTINCT FROM NEW.is_demonstration THEN
        RAISE EXCEPTION 'invoice provenance is fixed when the invoice is created';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- A sale row is evidence: it is never changed or deleted, and it must describe the REQUEST and INVOICE it names.
CREATE FUNCTION guard_code_sale() RETURNS trigger AS $$
DECLARE
    request_row payment_requests%ROWTYPE;
    invoice_channel varchar;
    invoice_demo boolean;
BEGIN
    IF TG_OP <> 'INSERT' THEN
        RAISE EXCEPTION 'a code sale is never changed or deleted';
    END IF;
    SELECT * INTO request_row FROM payment_requests WHERE id = NEW.payment_request_id AND merchant_id = NEW.merchant_id;
    SELECT coalesce(sale_channel, 'INVOICE'), is_demonstration INTO invoice_channel, invoice_demo FROM invoices WHERE id = NEW.invoice_id AND merchant_id = NEW.merchant_id;
    -- The invoice's financial flag and the sale's mode are one fact: a demonstration is excluded from every financial view, a live sale is not.
    IF invoice_demo IS DISTINCT FROM (NEW.presentation_mode = 'DEMONSTRATION') THEN
        RAISE EXCEPTION 'the invoice of a code sale must be flagged as a demonstration exactly when the sale is one';
    END IF;
    IF request_row.id IS NULL OR request_row.source IS DISTINCT FROM 'CODE' OR invoice_channel IS DISTINCT FROM 'CODE'
       OR request_row.invoice_id IS DISTINCT FROM NEW.invoice_id OR request_row.requested_amount_rwf <> NEW.amount_rwf
       OR request_row.public_reference <> NEW.sale_reference THEN
        RAISE EXCEPTION 'a code sale must describe its own CODE invoice and payment request';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_code_sales_guard BEFORE INSERT OR UPDATE OR DELETE ON code_sales
    FOR EACH ROW EXECUTE FUNCTION guard_code_sale();

-- THE AUTHORITATIVE BOUNDARY for code sales and bank money (last line of defence; the services refuse first, with friendlier errors).
--   * A DEMONSTRATION sale can NEVER receive an allocation, by any route: a simulated code takes no real payment, so real bank money must
--     never make it "paid".
--   * No CODE sale receives an AUTOMATIC allocation (origin AUTO_REFERENCE) until bank attribution (R6d) exists and Equity has confirmed what
--     evidence a code payment carries. A reference or invoice-number match alone is not enough.
--   * A LIVE code sale may still receive a MANUAL allocation by an authorised person.
-- It runs before the generic allocation guard and never weakens it: every other allocation rule still applies afterwards.
CREATE FUNCTION guard_code_sale_allocation() RETURNS trigger AS $$
DECLARE
    invoice_channel varchar;
    invoice_demo boolean;
BEGIN
    SELECT coalesce(sale_channel, 'INVOICE'), is_demonstration INTO invoice_channel, invoice_demo FROM invoices WHERE id = NEW.invoice_id;
    IF invoice_demo THEN
        RAISE EXCEPTION 'a demonstration code sale can never receive bank money';
    END IF;
    IF invoice_channel = 'CODE' THEN
        IF NEW.origin <> 'MANUAL' THEN
            RAISE EXCEPTION 'a code sale is not matched to bank money automatically until bank attribution exists';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_payment_allocations_code_sale BEFORE INSERT ON payment_allocations
    FOR EACH ROW EXECUTE FUNCTION guard_code_sale_allocation();
