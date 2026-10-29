-- R6d-A: bank transaction ATTRIBUTION. Additive and nullable: a historical transaction has no attribution at all (every new column NULL).
--
-- What this records, and what it never does:
--   * It records which collection code the BANK reported on a transaction, and, only when that value matches exactly one code of THIS
--     merchant on the SAME settlement account, which code that is. It never infers a code from an amount, a time or a payer.
--   * It records an exact CODE sale reference when the transaction carries one, so the agent can be taken from that sale's immutable
--     snapshot. It never infers an agent from who holds a code now, or held it when the event arrived.
--   * It never allocates money. The bank ledger (transactions, allocations) stays the single source of financial truth, and a code sale
--     is still not matched automatically (V13 guard).
--
-- Evidence is immutable once recorded (trigger below). Attribution may be COMPLETED by later evidence (a code or a sale reference that
-- arrives on a later event of the same transaction) and may turn into a CONFLICT, never into something else.

-- code_sales can be referenced by (id, merchant): the tenant is part of the key.
ALTER TABLE code_sales ADD CONSTRAINT ux_code_sales_request_merchant UNIQUE (payment_request_id, merchant_id);

ALTER TABLE bank_transactions
    -- The settlement destination (the merchant's linked account) the money reached, resolved from the authenticated account.
    ADD COLUMN settlement_destination_id uuid,
    -- The code exactly as the bank reported it. NULL when the bank reported none.
    ADD COLUMN reported_code varchar(64),
    -- The merchant's collection code the reported value resolved to, only when unambiguous.
    ADD COLUMN collection_code_id uuid,
    -- CODE_REPORTED: the bank supplied a code. ACCOUNT_ONLY: it did not (the account is all we know). UNATTRIBUTED: not even the account.
    ADD COLUMN attribution_basis varchar(16),
    -- RESOLVED: reported code matches exactly one code of this merchant and account. UNRESOLVED: reported, but unknown, another
    -- business's, or on another account (these are deliberately indistinguishable to a merchant). CONFLICT: contradicting evidence.
    -- NOT_REPORTED: no code was reported.
    ADD COLUMN attribution_status varchar(16),
    -- Internal explanation for reviewers. Never contains another merchant's data.
    ADD COLUMN attribution_note varchar(200),
    -- An exact CODE sale reference carried by the transaction (as a REFERENCE: not a match, not an allocation).
    ADD COLUMN referenced_code_sale_id uuid,
    -- A CONCLUSION about who collected, kept apart from the evidence above it.
    --   CONFIRMED_FROM_SALE_SNAPSHOT: the payment names the exact sale, the bank reported the sale's own code, and the money reached the sale's
    --                                 settlement account. Only then is the agent of that sale's immutable snapshot the collector.
    --   SALE_NAMED_UNCONFIRMED: the payment names the exact sale but the bank reported no code, so the code and agent evidence are incomplete.
    --   UNRESOLVED: anything else (no sale reference, unknown code, a conflict). Never inferred from who holds the code.
    ADD COLUMN agent_attribution varchar(32),
    -- The provider event that first created the transaction (the original evidence).
    ADD COLUMN origin_provider_event_id varchar(120),
    ADD COLUMN attributed_at timestamptz;

ALTER TABLE bank_transactions
    ADD CONSTRAINT fk_bank_transactions_destination FOREIGN KEY (settlement_destination_id, merchant_id)
        REFERENCES payment_destinations (id, merchant_id),
    ADD CONSTRAINT fk_bank_transactions_code FOREIGN KEY (collection_code_id, merchant_id)
        REFERENCES collection_codes (id, merchant_id),
    ADD CONSTRAINT fk_bank_transactions_code_sale FOREIGN KEY (referenced_code_sale_id, merchant_id)
        REFERENCES code_sales (payment_request_id, merchant_id),
    ADD CONSTRAINT ck_bank_transactions_attr_basis CHECK (attribution_basis IS NULL OR attribution_basis IN ('CODE_REPORTED', 'ACCOUNT_ONLY', 'UNATTRIBUTED')),
    ADD CONSTRAINT ck_bank_transactions_attr_status CHECK (attribution_status IS NULL OR attribution_status IN ('RESOLVED', 'UNRESOLVED', 'CONFLICT', 'NOT_REPORTED')),
    ADD CONSTRAINT ck_bank_transactions_attr_agent CHECK (agent_attribution IS NULL OR agent_attribution IN ('CONFIRMED_FROM_SALE_SNAPSHOT', 'SALE_NAMED_UNCONFIRMED', 'UNRESOLVED')),
    ADD CONSTRAINT ck_bank_transactions_attr_code_text CHECK (reported_code IS NULL
        OR (reported_code = btrim(reported_code) AND length(reported_code) BETWEEN 1 AND 64)),
    -- A historical row has none of it; an evaluated row has all of the verdict. (Written so a NULL can never pass by accident.)
    ADD CONSTRAINT ck_bank_transactions_attr_all_or_none CHECK (
        (attribution_status IS NULL AND attribution_basis IS NULL AND agent_attribution IS NULL AND attributed_at IS NULL
            AND collection_code_id IS NULL AND referenced_code_sale_id IS NULL AND attribution_note IS NULL)
        OR (attribution_status IS NOT NULL AND attribution_basis IS NOT NULL AND agent_attribution IS NOT NULL AND attributed_at IS NOT NULL)),
    -- Every comparison below is written with IS [NOT] DISTINCT FROM so that a NULL can never make a CHECK pass by accident.
    ADD CONSTRAINT ck_bank_transactions_attr_resolved CHECK (attribution_status IS DISTINCT FROM 'RESOLVED'
        OR (collection_code_id IS NOT NULL AND reported_code IS NOT NULL AND attribution_basis IS NOT DISTINCT FROM 'CODE_REPORTED')),
    ADD CONSTRAINT ck_bank_transactions_attr_unresolved CHECK (attribution_status IS DISTINCT FROM 'UNRESOLVED'
        OR (collection_code_id IS NULL AND reported_code IS NOT NULL AND attribution_basis IS NOT DISTINCT FROM 'CODE_REPORTED')),
    ADD CONSTRAINT ck_bank_transactions_attr_not_reported CHECK (attribution_status IS DISTINCT FROM 'NOT_REPORTED'
        OR (collection_code_id IS NULL AND reported_code IS NULL AND attribution_basis IS NOT NULL AND attribution_basis <> 'CODE_REPORTED')),
    -- A confirmed agent needs a named sale AND a resolved code; an unconfirmed one needs a named sale and NO reported code.
    ADD CONSTRAINT ck_bank_transactions_attr_agent_confirmed CHECK (agent_attribution IS DISTINCT FROM 'CONFIRMED_FROM_SALE_SNAPSHOT'
        OR (referenced_code_sale_id IS NOT NULL AND collection_code_id IS NOT NULL AND attribution_status IS NOT DISTINCT FROM 'RESOLVED')),
    ADD CONSTRAINT ck_bank_transactions_attr_agent_unconfirmed CHECK (agent_attribution IS DISTINCT FROM 'SALE_NAMED_UNCONFIRMED'
        OR (referenced_code_sale_id IS NOT NULL AND collection_code_id IS NULL AND attribution_status IS NOT DISTINCT FROM 'NOT_REPORTED'));

CREATE INDEX ix_bank_transactions_code ON bank_transactions (collection_code_id, provider_occurred_at DESC) WHERE collection_code_id IS NOT NULL;
CREATE INDEX ix_bank_transactions_code_sale ON bank_transactions (referenced_code_sale_id) WHERE referenced_code_sale_id IS NOT NULL;

-- The database keeps attribution honest, whatever the application does:
--   * a resolved code must be on the SAME provider and the SAME settlement account the money reached;
--   * recorded evidence never changes (the reported value, the account, the original event, a resolved code, a referenced sale);
--   * attribution can be completed once (NOT_REPORTED or none, to a verdict) or turn into CONFLICT, and a CONFLICT is final.
CREATE FUNCTION guard_bank_transaction_attribution() RETURNS trigger AS $$
DECLARE
    code_row collection_codes%ROWTYPE;
    sale_row code_sales%ROWTYPE;
    destination_connection uuid;
BEGIN
    -- The settlement destination is the one of the authenticated connection the money reached.
    IF NEW.settlement_destination_id IS NOT NULL THEN
        SELECT bank_connection_id INTO destination_connection FROM payment_destinations
         WHERE id = NEW.settlement_destination_id AND merchant_id = NEW.merchant_id;
        IF destination_connection IS DISTINCT FROM NEW.bank_connection_id THEN
            RAISE EXCEPTION 'the settlement destination must belong to the connection the money reached';
        END IF;
    END IF;
    -- A confirmed collector is only ever the agent of a sale that is consistent with the evidence: its own code, its own account.
    IF NEW.agent_attribution = 'CONFIRMED_FROM_SALE_SNAPSHOT' THEN
        SELECT * INTO sale_row FROM code_sales WHERE payment_request_id = NEW.referenced_code_sale_id AND merchant_id = NEW.merchant_id;
        IF sale_row.payment_request_id IS NULL OR sale_row.collection_code_id IS DISTINCT FROM NEW.collection_code_id
           OR sale_row.settlement_destination_id IS DISTINCT FROM NEW.settlement_destination_id THEN
            RAISE EXCEPTION 'an agent is confirmed only when the sale, the reported code and the settlement account agree';
        END IF;
    END IF;
    IF NEW.collection_code_id IS NOT NULL THEN
        SELECT * INTO code_row FROM collection_codes WHERE id = NEW.collection_code_id AND merchant_id = NEW.merchant_id;
        IF code_row.id IS NULL OR code_row.provider_id <> NEW.provider_id
           OR NEW.settlement_destination_id IS NULL OR code_row.settlement_destination_id <> NEW.settlement_destination_id THEN
            RAISE EXCEPTION 'a transaction can only be attributed to a code of its own provider and settlement account';
        END IF;
        IF upper(code_row.external_code) IS DISTINCT FROM upper(NEW.reported_code) THEN
            RAISE EXCEPTION 'a code is resolved only from exactly the value the bank reported';
        END IF;
    END IF;
    IF TG_OP = 'UPDATE' THEN
        IF (OLD.reported_code IS NOT NULL AND NEW.reported_code IS DISTINCT FROM OLD.reported_code)
           OR (OLD.settlement_destination_id IS NOT NULL AND NEW.settlement_destination_id IS DISTINCT FROM OLD.settlement_destination_id)
           OR (OLD.origin_provider_event_id IS NOT NULL AND NEW.origin_provider_event_id IS DISTINCT FROM OLD.origin_provider_event_id)
           OR (OLD.collection_code_id IS NOT NULL AND NEW.collection_code_id IS DISTINCT FROM OLD.collection_code_id)
           OR (OLD.referenced_code_sale_id IS NOT NULL AND NEW.referenced_code_sale_id IS DISTINCT FROM OLD.referenced_code_sale_id) THEN
            RAISE EXCEPTION 'recorded bank evidence is never overwritten';
        END IF;
        IF OLD.attribution_status IS NOT NULL AND NEW.attribution_status IS DISTINCT FROM OLD.attribution_status THEN
            IF OLD.attribution_status = 'CONFLICT' THEN
                RAISE EXCEPTION 'a conflicting attribution is final';
            END IF;
            IF NOT (OLD.attribution_status = 'NOT_REPORTED' OR NEW.attribution_status = 'CONFLICT') THEN
                RAISE EXCEPTION 'an attribution verdict is not changed, only completed or contradicted';
            END IF;
        END IF;
        -- Conclusions can be completed by later evidence, or withdrawn when evidence contradicts them. A confirmed agent is never replaced by a
        -- different conclusion except by a CONFLICT, and an unconfirmed one only becomes confirmed (or is withdrawn by a conflict).
        IF OLD.agent_attribution = 'CONFIRMED_FROM_SALE_SNAPSHOT' AND NEW.agent_attribution IS DISTINCT FROM OLD.agent_attribution
           AND NEW.attribution_status IS DISTINCT FROM 'CONFLICT' THEN
            RAISE EXCEPTION 'a confirmed agent is only withdrawn by a conflict';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_bank_transactions_attribution BEFORE INSERT OR UPDATE ON bank_transactions
    FOR EACH ROW EXECUTE FUNCTION guard_bank_transaction_attribution();
