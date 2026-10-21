-- R2: HTTP idempotency records.
--
-- THIS TABLE IS A REPLAY CACHE, NOT A SAFETY NET. It lets a client that lost a response (or retried a request that was
-- still running) get the original outcome back instead of repeating the operation. Rows are pruned after 30 days (see
-- Housekeeping), so the permanent guarantee against a duplicate financial or stock operation must always come from a
-- uniqueness constraint on the business rows themselves (bank events, allocations, movements), never from this table.
-- See docs/idempotency.md.
--
-- A record is written in the SAME transaction as the business operation it protects, so a committed row always belongs
-- to a committed operation, and a rolled-back operation leaves nothing behind. The deferred trigger below turns that
-- rule into a database guarantee: a row cannot commit without its result.

CREATE TABLE idempotency_keys (
    merchant_id        uuid        NOT NULL REFERENCES merchants (id),
    scope              varchar(40) NOT NULL,
    idem_key           varchar(80) NOT NULL,
    actor_user_id      uuid        NOT NULL REFERENCES users (id),
    -- SHA-256 (lower-case hex) of the canonical request: a reused key with different data is refused.
    request_sha256     varchar(64) NOT NULL,
    -- What the operation produced, so the response can be rebuilt (after an authorisation check) on replay.
    result_entity_type varchar(40),
    result_entity_id   uuid,
    created_at         timestamptz NOT NULL,
    PRIMARY KEY (merchant_id, scope, idem_key),
    CONSTRAINT ck_idempotency_scope  CHECK (scope ~ '^[A-Z][A-Z0-9_]{1,39}$'),
    CONSTRAINT ck_idempotency_key    CHECK (idem_key ~ '^[A-Za-z0-9._~-]{8,80}$'),
    CONSTRAINT ck_idempotency_sha256 CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_idempotency_result_type CHECK (result_entity_type IS NULL OR result_entity_type ~ '^[a-z][a-z0-9_]{1,39}$'),
    CONSTRAINT ck_idempotency_result CHECK ((result_entity_type IS NULL) = (result_entity_id IS NULL))
);
-- Retention pruning walks the oldest rows first, in bounded batches.
CREATE INDEX ix_idempotency_keys_created ON idempotency_keys (created_at);

-- The only legal change to a record is attaching its result, once.
CREATE FUNCTION guard_idempotency_key_update() RETURNS trigger AS $$
BEGIN
    IF OLD.merchant_id <> NEW.merchant_id OR OLD.scope <> NEW.scope OR OLD.idem_key <> NEW.idem_key
       OR OLD.actor_user_id <> NEW.actor_user_id OR OLD.request_sha256 <> NEW.request_sha256
       OR OLD.created_at <> NEW.created_at THEN
        RAISE EXCEPTION 'an idempotency record is immutable';
    END IF;
    IF OLD.result_entity_id IS NOT NULL THEN
        RAISE EXCEPTION 'an idempotency record already has its result';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_idempotency_keys_update BEFORE UPDATE ON idempotency_keys
    FOR EACH ROW EXECUTE FUNCTION guard_idempotency_key_update();

-- Commit-time invariant: a committed record always carries its result. (The row is inserted first, to claim the key,
-- and completed later in the same transaction; this is checked when the transaction commits.)
CREATE FUNCTION check_idempotency_key_completed() RETURNS trigger AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM idempotency_keys k
                    WHERE k.merchant_id = NEW.merchant_id AND k.scope = NEW.scope AND k.idem_key = NEW.idem_key
                      AND k.result_entity_id IS NOT NULL) THEN
        RAISE EXCEPTION 'an idempotency record must carry its result when the transaction commits';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER trg_idempotency_keys_completed AFTER INSERT ON idempotency_keys
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_idempotency_key_completed();
