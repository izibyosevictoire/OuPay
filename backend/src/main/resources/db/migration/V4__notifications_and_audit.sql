-- In-app notifications and the append-only audit log.

CREATE TABLE notifications (
    id                          uuid PRIMARY KEY,
    merchant_id                 uuid         NOT NULL REFERENCES merchants (id),
    recipient_user_id           uuid         NOT NULL REFERENCES users (id),
    kind                        varchar(30)  NOT NULL,
    title                       varchar(120) NOT NULL,
    body                        varchar(500) NOT NULL,
    related_bank_transaction_id uuid,
    related_invoice_id          uuid,
    -- One notification per recipient per business event, however often the event is replayed.
    dedupe_key                  varchar(200) NOT NULL,
    is_simulated                boolean      NOT NULL DEFAULT false,
    read_at                     timestamptz,
    created_at                  timestamptz  NOT NULL,
    CONSTRAINT ck_notifications_kind CHECK (kind IN ('PAYMENT_MATCHED', 'PAYMENT_UNMATCHED',
        'INVOICE_PARTIALLY_SETTLED', 'INVOICE_SETTLED', 'PAYMENT_REVERSED', 'NEEDS_REVIEW')),
    CONSTRAINT ux_notifications_dedupe UNIQUE (recipient_user_id, dedupe_key)
);
CREATE INDEX ix_notifications_recipient ON notifications (recipient_user_id, merchant_id, created_at DESC);

CREATE TABLE audit_log (
    id                  bigserial PRIMARY KEY,
    merchant_id         uuid REFERENCES merchants (id),
    actor_user_id       uuid REFERENCES users (id),
    kind                varchar(40)  NOT NULL,
    entity_type         varchar(40),
    entity_id           uuid,
    bank_transaction_id uuid,
    invoice_id          uuid,
    message             varchar(500) NOT NULL,
    created_at          timestamptz  NOT NULL
);
CREATE INDEX ix_audit_log_merchant ON audit_log (merchant_id, created_at DESC);
CREATE INDEX ix_audit_log_transaction ON audit_log (bank_transaction_id) WHERE bank_transaction_id IS NOT NULL;
CREATE INDEX ix_audit_log_invoice ON audit_log (invoice_id) WHERE invoice_id IS NOT NULL;

CREATE FUNCTION forbid_audit_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'the audit log is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_audit_log_immutable BEFORE UPDATE OR DELETE ON audit_log
    FOR EACH ROW EXECUTE FUNCTION forbid_audit_change();
