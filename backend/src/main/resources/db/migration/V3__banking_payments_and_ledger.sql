-- Banking connections, payment links/requests and the financial ledger.
--
-- Three independent concepts (mirrors the frontend domain):
--   bank_transactions     what the BANK reported (PENDING, CONFIRMED, FAILED, REVERSED)
--   payment_allocations   confirmed money applied to an invoice (ACTIVE or REVERSED)
--   invoices.status       the commercial lifecycle (V2)
-- Invoice balances are NEVER stored: they are derived from ACTIVE allocations.
--
-- Money is whole RWF in BIGINT columns named *_rwf.

CREATE TABLE bank_connections (
    id                  uuid PRIMARY KEY,
    merchant_id         uuid         NOT NULL REFERENCES merchants (id),
    provider_id         varchar(24)  NOT NULL,
    status              varchar(12)  NOT NULL,
    account_nickname    varchar(60)  NOT NULL,
    -- Opaque provider-side account identifier. Never a real account number.
    provider_account_id varchar(64),
    masked_account      varchar(24),
    is_simulated        boolean      NOT NULL,
    last_error          varchar(300),
    created_at          timestamptz  NOT NULL,
    updated_at          timestamptz  NOT NULL,
    version             bigint       NOT NULL DEFAULT 0,
    CONSTRAINT ck_bank_connections_provider CHECK (provider_id IN ('EQUITY_MOCK', 'MTN_MOMO', 'AIRTEL_MONEY')),
    CONSTRAINT ck_bank_connections_status CHECK (status IN ('PENDING', 'CONNECTED', 'ERROR', 'DISABLED')),
    CONSTRAINT ck_bank_connections_account CHECK (status IN ('ERROR', 'DISABLED') OR provider_account_id IS NOT NULL),
    CONSTRAINT ux_bank_connections_id_merchant UNIQUE (id, merchant_id)
);
-- A provider account can belong to ONE live connection, and a merchant has one live link per provider.
CREATE UNIQUE INDEX ux_bank_connections_live_account
    ON bank_connections (provider_id, provider_account_id) WHERE status IN ('PENDING', 'CONNECTED');
CREATE UNIQUE INDEX ux_bank_connections_live_provider
    ON bank_connections (merchant_id, provider_id) WHERE status IN ('PENDING', 'CONNECTED');

CREATE TABLE payment_destinations (
    id                  uuid PRIMARY KEY,
    merchant_id         uuid         NOT NULL,
    bank_connection_id  uuid         NOT NULL,
    label               varchar(60)  NOT NULL,
    provider_id         varchar(24)  NOT NULL,
    provider_account_id varchar(64)  NOT NULL,
    masked_account      varchar(24)  NOT NULL,
    is_simulated        boolean      NOT NULL,
    created_at          timestamptz  NOT NULL,
    CONSTRAINT ux_payment_destinations_id_merchant UNIQUE (id, merchant_id),
    CONSTRAINT fk_payment_destinations_connection FOREIGN KEY (bank_connection_id, merchant_id)
        REFERENCES bank_connections (id, merchant_id)
);

CREATE TABLE payment_profiles (
    id                      uuid PRIMARY KEY,
    merchant_id             uuid         NOT NULL,
    -- Public, opaque, unguessable token (62^12). A public identifier, NOT a credential.
    public_token            varchar(12)  NOT NULL,
    label                   varchar(60)  NOT NULL,
    branch_id               uuid,
    assigned_cashier_user_id uuid REFERENCES users (id),
    payment_destination_id  uuid         NOT NULL,
    status                  varchar(10)  NOT NULL,
    replaced_by_profile_id  uuid REFERENCES payment_profiles (id),
    created_at              timestamptz  NOT NULL,
    updated_at              timestamptz  NOT NULL,
    version                 bigint       NOT NULL DEFAULT 0,
    CONSTRAINT ck_payment_profiles_status CHECK (status IN ('ACTIVE', 'INACTIVE', 'REVOKED')),
    CONSTRAINT ck_payment_profiles_token CHECK (public_token ~ '^[0-9A-Za-z]{12}$'),
    CONSTRAINT ux_payment_profiles_token UNIQUE (public_token),
    CONSTRAINT ux_payment_profiles_id_merchant UNIQUE (id, merchant_id),
    CONSTRAINT fk_payment_profiles_merchant FOREIGN KEY (merchant_id) REFERENCES merchants (id),
    CONSTRAINT fk_payment_profiles_branch FOREIGN KEY (branch_id, merchant_id) REFERENCES branches (id, merchant_id),
    CONSTRAINT fk_payment_profiles_destination FOREIGN KEY (payment_destination_id, merchant_id)
        REFERENCES payment_destinations (id, merchant_id)
);
CREATE INDEX ix_payment_profiles_merchant ON payment_profiles (merchant_id);

CREATE TABLE payment_requests (
    id                      uuid PRIMARY KEY,
    merchant_id             uuid         NOT NULL,
    payment_profile_id      uuid         NOT NULL,
    invoice_id              uuid,
    requested_amount_rwf    bigint       NOT NULL,
    currency                varchar(3)   NOT NULL DEFAULT 'RWF',
    -- High-entropy customer-facing reference (OP- plus 12 Crockford-style characters).
    public_reference        varchar(15)  NOT NULL,
    expires_at              timestamptz  NOT NULL,
    cancelled_at            timestamptz,
    instructions_opened_at  timestamptz,
    customer_claimed_at     timestamptz,
    created_at              timestamptz  NOT NULL,
    updated_at              timestamptz  NOT NULL,
    CONSTRAINT ck_payment_requests_amount CHECK (requested_amount_rwf > 0),
    CONSTRAINT ck_payment_requests_currency CHECK (currency = 'RWF'),
    CONSTRAINT ck_payment_requests_reference CHECK (public_reference ~ '^OP-[2-9A-HJKMNP-Z]{12}$'),
    CONSTRAINT ux_payment_requests_reference UNIQUE (public_reference),
    CONSTRAINT ux_payment_requests_id_merchant UNIQUE (id, merchant_id),
    CONSTRAINT fk_payment_requests_merchant FOREIGN KEY (merchant_id) REFERENCES merchants (id),
    CONSTRAINT fk_payment_requests_profile FOREIGN KEY (payment_profile_id, merchant_id)
        REFERENCES payment_profiles (id, merchant_id),
    CONSTRAINT fk_payment_requests_invoice FOREIGN KEY (invoice_id, merchant_id)
        REFERENCES invoices (id, merchant_id)
);
CREATE INDEX ix_payment_requests_invoice ON payment_requests (invoice_id) WHERE invoice_id IS NOT NULL;
CREATE INDEX ix_payment_requests_profile ON payment_requests (payment_profile_id);

-- Raw provider events: written once, before processing, and never edited except for the single
-- RECEIVED -> final outcome transition. (provider, event id) uniqueness makes ingestion idempotent.
CREATE TABLE bank_events (
    id                      uuid PRIMARY KEY,
    provider_id             varchar(24)  NOT NULL,
    provider_event_id       varchar(120) NOT NULL,
    provider_transaction_id varchar(120) NOT NULL,
    merchant_id             uuid REFERENCES merchants (id),
    outcome                 varchar(10)  NOT NULL,
    outcome_reason          varchar(300),
    raw_payload             text         NOT NULL,
    received_at             timestamptz  NOT NULL,
    processed_at            timestamptz,
    CONSTRAINT ck_bank_events_outcome CHECK (outcome IN ('RECEIVED', 'APPLIED', 'DUPLICATE', 'STALE', 'REJECTED')),
    CONSTRAINT ux_bank_events_provider_event UNIQUE (provider_id, provider_event_id)
);
CREATE INDEX ix_bank_events_transaction ON bank_events (provider_id, provider_transaction_id);

CREATE TABLE bank_transactions (
    id                       uuid PRIMARY KEY,
    merchant_id              uuid         NOT NULL,
    bank_connection_id       uuid         NOT NULL,
    provider_id              varchar(24)  NOT NULL,
    provider_transaction_id  varchar(120) NOT NULL,
    last_provider_event_id   varchar(120) NOT NULL,
    direction                varchar(8)   NOT NULL,
    amount_rwf               bigint       NOT NULL,
    currency                 varchar(3)   NOT NULL DEFAULT 'RWF',
    payment_reference        varchar(64),
    payer_display_name       varchar(80)  NOT NULL,
    provider_occurred_at     timestamptz  NOT NULL,
    -- Provider time of the event that produced the current status: orders out-of-order events.
    status_applied_at        timestamptz  NOT NULL,
    received_at              timestamptz  NOT NULL,
    status                   varchar(10)  NOT NULL,
    is_simulated             boolean      NOT NULL,
    payment_request_id       uuid,
    review_state             varchar(12)  NOT NULL DEFAULT 'NONE',
    review_reason            varchar(300),
    review_note              varchar(500),
    created_at               timestamptz  NOT NULL,
    updated_at               timestamptz  NOT NULL,
    version                  bigint       NOT NULL DEFAULT 1,
    CONSTRAINT ck_bank_transactions_status CHECK (status IN ('PENDING', 'CONFIRMED', 'FAILED', 'REVERSED')),
    CONSTRAINT ck_bank_transactions_direction CHECK (direction IN ('INCOMING', 'OUTGOING')),
    CONSTRAINT ck_bank_transactions_amount CHECK (amount_rwf > 0),
    CONSTRAINT ck_bank_transactions_currency CHECK (currency = 'RWF'),
    CONSTRAINT ck_bank_transactions_review CHECK (review_state IN ('NONE', 'NEEDS_REVIEW', 'REVIEWED')),
    CONSTRAINT ux_bank_transactions_provider_tx UNIQUE (provider_id, provider_transaction_id),
    CONSTRAINT ux_bank_transactions_id_merchant UNIQUE (id, merchant_id),
    CONSTRAINT fk_bank_transactions_merchant FOREIGN KEY (merchant_id) REFERENCES merchants (id),
    CONSTRAINT fk_bank_transactions_connection FOREIGN KEY (bank_connection_id, merchant_id)
        REFERENCES bank_connections (id, merchant_id),
    CONSTRAINT fk_bank_transactions_request FOREIGN KEY (payment_request_id, merchant_id)
        REFERENCES payment_requests (id, merchant_id)
);
CREATE INDEX ix_bank_transactions_merchant_time ON bank_transactions (merchant_id, provider_occurred_at DESC);
CREATE INDEX ix_bank_transactions_reference ON bank_transactions (merchant_id, payment_reference)
    WHERE payment_reference IS NOT NULL;
CREATE INDEX ix_bank_transactions_request ON bank_transactions (payment_request_id)
    WHERE payment_request_id IS NOT NULL;

CREATE TABLE payment_allocations (
    id                   uuid PRIMARY KEY,
    merchant_id          uuid         NOT NULL,
    bank_transaction_id  uuid         NOT NULL,
    invoice_id           uuid         NOT NULL,
    amount_rwf           bigint       NOT NULL,
    status               varchar(10)  NOT NULL,
    origin               varchar(16)  NOT NULL,
    created_by_user_id   uuid REFERENCES users (id),
    created_at           timestamptz  NOT NULL,
    reversed_at          timestamptz,
    reversed_by_user_id  uuid REFERENCES users (id),
    reversal_kind        varchar(20),
    reversal_reason      varchar(300),
    CONSTRAINT ck_payment_allocations_amount CHECK (amount_rwf > 0),
    CONSTRAINT ck_payment_allocations_status CHECK (status IN ('ACTIVE', 'REVERSED')),
    CONSTRAINT ck_payment_allocations_origin CHECK (origin IN ('AUTO_REFERENCE', 'MANUAL')),
    CONSTRAINT ck_payment_allocations_reversal CHECK (
        (status = 'ACTIVE' AND reversed_at IS NULL AND reversal_kind IS NULL)
        OR (status = 'REVERSED' AND reversed_at IS NOT NULL AND reversal_kind IN ('BANK_REVERSAL', 'MANUAL_CORRECTION'))),
    CONSTRAINT ck_payment_allocations_manual_actor CHECK (origin <> 'MANUAL' OR created_by_user_id IS NOT NULL),
    CONSTRAINT fk_payment_allocations_tx FOREIGN KEY (bank_transaction_id, merchant_id)
        REFERENCES bank_transactions (id, merchant_id),
    CONSTRAINT fk_payment_allocations_invoice FOREIGN KEY (invoice_id, merchant_id)
        REFERENCES invoices (id, merchant_id)
);
CREATE INDEX ix_payment_allocations_invoice ON payment_allocations (invoice_id) WHERE status = 'ACTIVE';
CREATE INDEX ix_payment_allocations_tx ON payment_allocations (bank_transaction_id);
CREATE INDEX ix_payment_allocations_merchant ON payment_allocations (merchant_id, created_at DESC);

-- ---------------------------------------------------------------------------------------------
-- Financial guarantees enforced by the database (defence in depth behind the service layer)
-- ---------------------------------------------------------------------------------------------

-- Bank transaction: immutable identity and amount, legal status transitions, monotonic provider time.
CREATE FUNCTION guard_bank_transaction_update() RETURNS trigger AS $$
BEGIN
    IF OLD.merchant_id <> NEW.merchant_id OR OLD.provider_id <> NEW.provider_id
       OR OLD.provider_transaction_id <> NEW.provider_transaction_id OR OLD.amount_rwf <> NEW.amount_rwf
       OR OLD.direction <> NEW.direction OR OLD.currency <> NEW.currency
       OR OLD.bank_connection_id <> NEW.bank_connection_id THEN
        RAISE EXCEPTION 'bank transaction identity and amount are immutable';
    END IF;
    IF OLD.status <> NEW.status THEN
        IF NOT ((OLD.status = 'PENDING' AND NEW.status IN ('CONFIRMED', 'FAILED', 'REVERSED'))
             OR (OLD.status = 'CONFIRMED' AND NEW.status = 'REVERSED')) THEN
            RAISE EXCEPTION 'illegal bank transaction status transition % -> %', OLD.status, NEW.status;
        END IF;
        IF NEW.status_applied_at < OLD.status_applied_at THEN
            RAISE EXCEPTION 'bank transaction status must not move backwards in provider time';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_bank_transactions_guard BEFORE UPDATE ON bank_transactions
    FOR EACH ROW EXECUTE FUNCTION guard_bank_transaction_update();

CREATE FUNCTION forbid_delete() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% rows are never deleted', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_bank_transactions_nodelete BEFORE DELETE ON bank_transactions
    FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER trg_payment_allocations_nodelete BEFORE DELETE ON payment_allocations
    FOR EACH ROW EXECUTE FUNCTION forbid_delete();
CREATE TRIGGER trg_bank_events_nodelete BEFORE DELETE ON bank_events
    FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- Allocation insert: takes row locks in the fixed order transaction -> invoice, then checks that
-- the money exists and the invoice is owed it. Concurrent allocations therefore serialise here and
-- can never double-allocate or overpay, whatever the application does.
CREATE FUNCTION guard_allocation_insert() RETURNS trigger AS $$
DECLARE
    tx RECORD;
    inv RECORD;
    tx_allocated bigint;
    inv_allocated bigint;
BEGIN
    SELECT * INTO tx FROM bank_transactions WHERE id = NEW.bank_transaction_id FOR UPDATE;
    SELECT * INTO inv FROM invoices WHERE id = NEW.invoice_id FOR UPDATE;
    IF NEW.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'allocations are created ACTIVE';
    END IF;
    IF tx.status <> 'CONFIRMED' OR tx.direction <> 'INCOMING' THEN
        RAISE EXCEPTION 'only bank-confirmed incoming money can be allocated';
    END IF;
    IF inv.status <> 'ISSUED' THEN
        RAISE EXCEPTION 'only an issued invoice can receive an allocation';
    END IF;
    IF tx.merchant_id <> inv.merchant_id OR tx.merchant_id <> NEW.merchant_id THEN
        RAISE EXCEPTION 'allocation must stay inside one merchant';
    END IF;
    SELECT COALESCE(SUM(amount_rwf), 0) INTO tx_allocated
      FROM payment_allocations WHERE bank_transaction_id = tx.id AND status = 'ACTIVE';
    IF tx_allocated + NEW.amount_rwf > tx.amount_rwf THEN
        RAISE EXCEPTION 'allocation exceeds the unapplied amount of the transaction';
    END IF;
    SELECT COALESCE(SUM(amount_rwf), 0) INTO inv_allocated
      FROM payment_allocations WHERE invoice_id = inv.id AND status = 'ACTIVE';
    IF inv_allocated + NEW.amount_rwf > inv.grand_total_rwf THEN
        RAISE EXCEPTION 'allocation exceeds the remaining balance of the invoice';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_payment_allocations_insert BEFORE INSERT ON payment_allocations
    FOR EACH ROW EXECUTE FUNCTION guard_allocation_insert();

-- Allocation update: the only legal change is ACTIVE -> REVERSED (history is kept).
CREATE FUNCTION guard_allocation_update() RETURNS trigger AS $$
BEGIN
    IF OLD.status = 'REVERSED' THEN
        RAISE EXCEPTION 'a reversed allocation is final';
    END IF;
    IF OLD.merchant_id <> NEW.merchant_id OR OLD.bank_transaction_id <> NEW.bank_transaction_id
       OR OLD.invoice_id <> NEW.invoice_id OR OLD.amount_rwf <> NEW.amount_rwf
       OR OLD.origin <> NEW.origin OR OLD.created_at <> NEW.created_at THEN
        RAISE EXCEPTION 'allocation facts are immutable';
    END IF;
    IF NEW.status <> 'REVERSED' THEN
        RAISE EXCEPTION 'an allocation can only be reversed';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_payment_allocations_update BEFORE UPDATE ON payment_allocations
    FOR EACH ROW EXECUTE FUNCTION guard_allocation_update();

-- Deferred (commit-time) invariant: money that is not CONFIRMED can carry no ACTIVE allocation.
-- This is what makes a bank reversal atomic: the transaction cannot commit as REVERSED while any
-- allocation still counts.
CREATE FUNCTION check_allocation_invariant() RETURNS trigger AS $$
DECLARE
    tx_id uuid;
    tx_status varchar;
    active_total bigint;
BEGIN
    IF TG_TABLE_NAME = 'bank_transactions' THEN tx_id := NEW.id; ELSE tx_id := NEW.bank_transaction_id; END IF;
    SELECT status INTO tx_status FROM bank_transactions WHERE id = tx_id;
    SELECT COALESCE(SUM(amount_rwf), 0) INTO active_total
      FROM payment_allocations WHERE bank_transaction_id = tx_id AND status = 'ACTIVE';
    IF tx_status <> 'CONFIRMED' AND active_total > 0 THEN
        RAISE EXCEPTION 'unconfirmed or reversed money cannot carry active allocations (transaction %)', tx_id;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER trg_tx_allocation_invariant AFTER UPDATE ON bank_transactions
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_allocation_invariant();
CREATE CONSTRAINT TRIGGER trg_alloc_allocation_invariant AFTER INSERT OR UPDATE ON payment_allocations
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_allocation_invariant();

-- Raw events: immutable except the single RECEIVED -> final outcome step.
CREATE FUNCTION guard_bank_event_update() RETURNS trigger AS $$
BEGIN
    IF OLD.outcome <> 'RECEIVED' THEN
        RAISE EXCEPTION 'a processed bank event is immutable';
    END IF;
    IF OLD.provider_id <> NEW.provider_id OR OLD.provider_event_id <> NEW.provider_event_id
       OR OLD.provider_transaction_id <> NEW.provider_transaction_id
       OR OLD.raw_payload <> NEW.raw_payload OR OLD.received_at <> NEW.received_at THEN
        RAISE EXCEPTION 'raw bank event content is immutable';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_bank_events_update BEFORE UPDATE ON bank_events
    FOR EACH ROW EXECUTE FUNCTION guard_bank_event_update();
