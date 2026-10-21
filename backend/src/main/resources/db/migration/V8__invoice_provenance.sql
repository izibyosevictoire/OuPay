-- R3: where an invoice and a payment request came from, a durable identity for sales created by checkout flows, and
-- database-enforced attribution of invoices.
--
-- Purely ADDITIVE and forward-only: no column is dropped or renamed, no row is rewritten, no financial constraint is
-- weakened. Every new column is nullable, so the previous application version keeps working against this schema (the
-- rows it writes simply leave them empty), and old records are read with an explicit fallback:
--   invoices.sale_channel IS NULL                 -> the invoice is a traditional INVOICE
--   payment_requests.source IS NULL               -> OPEN when it has no invoice, otherwise INVOICE
-- There is NO backfill. Should a defect be found here, the fix is a later migration (V9), never an edit of this file,
-- and rolling the application back needs no schema change.
--
-- NOTE ON THIS FILE'S HISTORY: V8 was revised during R3 review (request fingerprint, completeness rules for payment
-- request provenance, invoice attribution triggers) BEFORE it was ever merged or applied to any persistent environment
-- (CI databases are created fresh for every run). Once V8 has been applied anywhere it must never be edited again.
--
-- The provenance columns are set once, by trusted server code, and never change (triggers below). No API accepts them.

-- ---------------------------------------------------------------------------------------------
-- Invoices
-- ---------------------------------------------------------------------------------------------

ALTER TABLE invoices
    ADD COLUMN sale_channel          varchar(12),
    -- The durable identity of the ORIGINAL sale-creation request. It is the permanent guard against creating the same
    -- sale twice; R2's HTTP idempotency records are only a 30-day replay cache and must never be the sole guard.
    ADD COLUMN client_request_id     uuid,
    -- SHA-256 of that original request, computed by the server with R2's canonical fingerprint (never supplied by a
    -- client). A repeat of the same client_request_id is the same sale only if its fingerprint is identical; a different
    -- payload under the same id is a conflict, not a second invoice and not a silent reuse.
    ADD COLUMN client_request_sha256 varchar(64),
    ADD CONSTRAINT ck_invoices_sale_channel CHECK (sale_channel IS NULL OR sale_channel IN ('INVOICE', 'POS', 'SIMPLIFIED')),
    -- A POS or simplified sale must carry its durable request id. Traditional invoices and legacy rows need none.
    ADD CONSTRAINT ck_invoices_checkout_request_id CHECK (sale_channel IS NULL OR sale_channel = 'INVOICE' OR client_request_id IS NOT NULL),
    -- The request id and its fingerprint exist together or not at all.
    ADD CONSTRAINT ck_invoices_request_identity CHECK ((client_request_id IS NULL) = (client_request_sha256 IS NULL)),
    ADD CONSTRAINT ck_invoices_request_sha256 CHECK (client_request_sha256 IS NULL OR client_request_sha256 ~ '^[0-9a-f]{64}$');

-- One sale per (business, request id). A different business may use the same id.
CREATE UNIQUE INDEX ux_invoices_client_request ON invoices (merchant_id, client_request_id) WHERE client_request_id IS NOT NULL;

-- A tenant-and-branch-scoped key that later tables (payment requests now, stock reservations later) can reference, so the
-- database itself guarantees they share the invoice's business and branch.
ALTER TABLE invoices ADD CONSTRAINT ux_invoices_id_merchant_branch UNIQUE (id, merchant_id, branch_id);

-- Provenance is fixed at creation. This is a separate trigger: the existing guard_invoice_update is not touched.
CREATE FUNCTION guard_invoice_provenance() RETURNS trigger AS $$
BEGIN
    IF OLD.sale_channel IS DISTINCT FROM NEW.sale_channel OR OLD.client_request_id IS DISTINCT FROM NEW.client_request_id
       OR OLD.client_request_sha256 IS DISTINCT FROM NEW.client_request_sha256 THEN
        RAISE EXCEPTION 'invoice provenance is fixed when the invoice is created';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_invoices_provenance_guard BEFORE UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION guard_invoice_provenance();

-- Attribution. The existing guard_invoice_update protects identity, lifecycle and amounts but not WHO and WHERE: until now only
-- the service stopped an issued invoice from changing branch or cashier. The creator never changes; the branch and the assigned
-- cashier are free while the invoice is a draft and fixed from the moment it is no longer one (including the update that
-- issues it). Draft edits are unaffected.
CREATE FUNCTION guard_invoice_attribution() RETURNS trigger AS $$
BEGIN
    IF OLD.created_by_user_id <> NEW.created_by_user_id THEN
        RAISE EXCEPTION 'the creator of an invoice never changes';
    END IF;
    IF NEW.status <> 'DRAFT' AND (OLD.branch_id <> NEW.branch_id OR OLD.assigned_to_user_id <> NEW.assigned_to_user_id) THEN
        RAISE EXCEPTION 'the branch and the assigned cashier of an issued invoice are fixed';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_invoices_attribution_guard BEFORE UPDATE ON invoices
    FOR EACH ROW EXECUTE FUNCTION guard_invoice_attribution();

-- ---------------------------------------------------------------------------------------------
-- Payment requests
-- ---------------------------------------------------------------------------------------------

-- source:     OPEN (an anonymous, invoice-less collection) or the sale channel of the invoice it collects for.
-- branch_id:  the branch the collection belongs to. For an invoice request it is the invoice's own branch (the branch of an
--             issued invoice is fixed, so the two can never drift); for an open request, its payment link's branch.
-- created_by: the member who created the request. The tenant is part of the key, so the creator must belong to the
--             SAME business as the request. Anonymous open requests have none.
-- These record facts the request would otherwise have to be joined to find; the database guarantees they agree with their
-- sources, so they are never a second, divergent copy. Records with source NULL predate this migration (or come from code
-- that does not record provenance) and keep working.
ALTER TABLE payment_requests
    ADD COLUMN source             varchar(12),
    ADD COLUMN branch_id          uuid,
    ADD COLUMN created_by_user_id uuid,
    ADD CONSTRAINT ck_payment_requests_source CHECK (source IS NULL OR source IN ('OPEN', 'INVOICE', 'POS', 'SIMPLIFIED')),
    -- OPEN exactly when there is no invoice: the two can never disagree.
    ADD CONSTRAINT ck_payment_requests_source_invoice CHECK (source IS NULL OR (source = 'OPEN') = (invoice_id IS NULL)),
    -- Provenance is all-or-nothing: a branch or a creator without a source is refused, so a NULL source cannot be used to
    -- smuggle in half a record.
    ADD CONSTRAINT ck_payment_requests_provenance_whole CHECK (source IS NOT NULL OR (branch_id IS NULL AND created_by_user_id IS NULL)),
    -- An anonymous open request has no creator: it cannot claim the identity of a member.
    ADD CONSTRAINT ck_payment_requests_open_anonymous CHECK (source IS DISTINCT FROM 'OPEN' OR created_by_user_id IS NULL),
    -- A request that collects for an invoice must name its branch and its creator: NULL cannot bypass the consistency rules.
    ADD CONSTRAINT ck_payment_requests_invoice_attribution CHECK (
        source IS NULL OR source = 'OPEN' OR (branch_id IS NOT NULL AND created_by_user_id IS NOT NULL)),
    ADD CONSTRAINT fk_payment_requests_branch FOREIGN KEY (branch_id, merchant_id)
        REFERENCES branches (id, merchant_id),
    -- With a branch present (required above for invoice requests) it must be the invoice's own branch.
    ADD CONSTRAINT fk_payment_requests_invoice_branch FOREIGN KEY (invoice_id, merchant_id, branch_id)
        REFERENCES invoices (id, merchant_id, branch_id),
    ADD CONSTRAINT fk_payment_requests_creator FOREIGN KEY (created_by_user_id, merchant_id)
        REFERENCES memberships (user_id, merchant_id);

-- Insert: the rules that need another table.
--   * a request for a POS or simplified invoice MUST record its source, and it must be that invoice's channel (so neither a
--     NULL source nor a mismatched one can be used to look like another flow);
--   * an open request may only carry its own payment link's branch.
-- Update: provenance never changes.
CREATE FUNCTION guard_payment_request_provenance() RETURNS trigger AS $$
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
        IF channel IN ('POS', 'SIMPLIFIED') AND NEW.source IS NULL THEN
            RAISE EXCEPTION 'a payment request for a POS or simplified invoice must record its source';
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
CREATE TRIGGER trg_payment_requests_provenance BEFORE INSERT OR UPDATE ON payment_requests
    FOR EACH ROW EXECUTE FUNCTION guard_payment_request_provenance();
