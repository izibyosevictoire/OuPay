-- R7c: verified-payment INVENTORY FULFILMENT. ADDITIVE: V1 to V17 are untouched, no historical invoice, payment, ledger or stock value is
-- rewritten, and there is NO new stock ledger: physical stock still moves only through R5c stock movements. A SALE movement is the only new kind.
--
-- When a LIVE POS sale is paid in full through bank money that R6d-B has RECONCILED (active allocations that cover the invoice), the sale's ACTIVE
-- reservation becomes FULFILLED and one SALE movement per reservation line deducts the physical stock, all in ONE transaction. "Posted" means the
-- STOCK LEDGER was updated. It does not mean the goods were handed to the customer (not tracked in R7c) and "PAID" never means "fulfilled".
--
-- Lock order of the posting transaction (everything else that locks any of these rows takes a prefix of this order, so no cycle exists):
--     invoice row  ->  pos_fulfilments row  ->  stock_reservations row  ->  inventory_balances rows (ascending item id)  ->  movements.

-- ---------------------------------------------------------------------------------------------
-- 1. The SALE movement
-- ---------------------------------------------------------------------------------------------
ALTER TABLE stock_movements DROP CONSTRAINT ck_stock_movements_type;
ALTER TABLE stock_movements ADD CONSTRAINT ck_stock_movements_type CHECK (movement_type IN ('OPENING', 'RECEIVE', 'ADJUST_IN', 'ADJUST_OUT', 'SALE'));
ALTER TABLE stock_movements DROP CONSTRAINT ck_stock_movements_sign;
ALTER TABLE stock_movements ADD CONSTRAINT ck_stock_movements_sign CHECK (
    (movement_type IN ('OPENING', 'RECEIVE', 'ADJUST_IN') AND quantity_delta > 0)
    OR (movement_type IN ('ADJUST_OUT', 'SALE') AND quantity_delta < 0));
-- A SALE movement is posted by the system on behalf of a verified payment, not by a person: it has no actor (every other movement still needs one),
-- and it always names the sale it belongs to and why.
ALTER TABLE stock_movements ALTER COLUMN actor_user_id DROP NOT NULL;
ALTER TABLE stock_movements ADD CONSTRAINT ck_stock_movements_actor CHECK (actor_user_id IS NOT NULL OR movement_type = 'SALE');
ALTER TABLE stock_movements ADD CONSTRAINT ck_stock_movements_sale_named CHECK (movement_type <> 'SALE' OR (reference IS NOT NULL AND reason IS NOT NULL));

-- ---------------------------------------------------------------------------------------------
-- 2. One fulfilment per sale: the durable operation identity, its state and its retry state
-- ---------------------------------------------------------------------------------------------
-- status: PENDING (waiting, or retrying after a failure), POSTED (the stock ledger was updated: final) or EXCEPTION (it can not be posted without a
-- decision by a person: see pos_fulfilment_exceptions). There is NO row for a sale that was never eligible, a demonstration, or a sale of services only.
CREATE TABLE pos_fulfilments (
    sale_id          uuid PRIMARY KEY,
    merchant_id      uuid         NOT NULL,
    invoice_id       uuid         NOT NULL,
    branch_id        uuid         NOT NULL,
    reservation_id   uuid         NOT NULL,
    status           varchar(10)  NOT NULL,
    attempts         integer      NOT NULL DEFAULT 0,
    last_attempt_at  timestamptz,
    -- When the next AUTOMATIC attempt is due (NULL: nothing is scheduled). Failures back off; after the last attempt the sale becomes an EXCEPTION.
    next_attempt_at  timestamptz,
    last_error       varchar(300),
    posted_at        timestamptz,
    created_at       timestamptz  NOT NULL,
    updated_at       timestamptz  NOT NULL,
    CONSTRAINT ux_pos_fulfilments_invoice UNIQUE (invoice_id),
    CONSTRAINT ux_pos_fulfilments_reservation UNIQUE (reservation_id),
    CONSTRAINT ux_pos_fulfilments_sale_merchant UNIQUE (sale_id, merchant_id),
    CONSTRAINT fk_pos_fulfilments_sale FOREIGN KEY (sale_id, merchant_id) REFERENCES pos_sales (payment_request_id, merchant_id),
    CONSTRAINT fk_pos_fulfilments_reservation FOREIGN KEY (reservation_id, merchant_id, branch_id) REFERENCES stock_reservations (id, merchant_id, branch_id),
    CONSTRAINT ck_pos_fulfilments_status CHECK (status IN ('PENDING', 'POSTED', 'EXCEPTION')),
    CONSTRAINT ck_pos_fulfilments_attempts CHECK (attempts >= 0),
    CONSTRAINT ck_pos_fulfilments_posted CHECK ((status = 'POSTED') = (posted_at IS NOT NULL))
);
CREATE INDEX ix_pos_fulfilments_due ON pos_fulfilments (next_attempt_at) WHERE status = 'PENDING';

-- Exactly one row per reservation line, and the immutable link from a SALE movement to the reservation line (so to the reservation, the invoice
-- line and the sale). A reservation line can be posted ONCE, and a movement belongs to ONE line: a second deduction is impossible.
CREATE TABLE pos_fulfilment_lines (
    reservation_line_id  uuid PRIMARY KEY REFERENCES stock_reservation_lines (id),
    sale_id              uuid          NOT NULL REFERENCES pos_fulfilments (sale_id),
    merchant_id          uuid          NOT NULL,
    branch_id            uuid          NOT NULL,
    item_id              uuid          NOT NULL,
    movement_id          uuid          NOT NULL UNIQUE REFERENCES stock_movements (id),
    quantity             numeric(20,6) NOT NULL,
    created_at           timestamptz   NOT NULL,
    CONSTRAINT ck_pos_fulfilment_lines_quantity CHECK (quantity > 0)
);
CREATE INDEX ix_pos_fulfilment_lines_sale ON pos_fulfilment_lines (sale_id);

-- Why a sale can not be posted without a decision. OPEN until a person resolves it (resolution is a later milestone: the columns exist so that
-- history is never lost, but nothing resolves one yet).
--   RESERVATION_RELEASED          paid, but the owner released the reservation first (nothing is re-reserved, nothing deducted)
--   INSUFFICIENT_STOCK            paid and reserved, but physical stock can not cover it (nothing deducted)
--   PAYMENT_REVERSED_AFTER_POSTING  the stock was deducted, then the payment was reversed (the SALE movement is kept; stock is NOT restored)
--   PROCESSING_FAILED             the automatic attempts all failed
CREATE TABLE pos_fulfilment_exceptions (
    id                   uuid PRIMARY KEY,
    merchant_id          uuid         NOT NULL,
    sale_id              uuid         NOT NULL,
    kind                 varchar(40)  NOT NULL,
    status               varchar(10)  NOT NULL DEFAULT 'OPEN',
    detail               varchar(500) NOT NULL,
    opened_at            timestamptz  NOT NULL,
    resolved_at          timestamptz,
    resolved_by_user_id  uuid REFERENCES users (id),
    resolution_note      varchar(500),
    CONSTRAINT fk_pos_fulfilment_exceptions_sale FOREIGN KEY (sale_id, merchant_id) REFERENCES pos_sales (payment_request_id, merchant_id),
    CONSTRAINT ck_pos_fulfilment_exceptions_kind CHECK (kind IN ('RESERVATION_RELEASED', 'INSUFFICIENT_STOCK', 'PAYMENT_REVERSED_AFTER_POSTING', 'PROCESSING_FAILED')),
    CONSTRAINT ck_pos_fulfilment_exceptions_status CHECK (
        (status = 'OPEN' AND resolved_at IS NULL AND resolved_by_user_id IS NULL AND resolution_note IS NULL)
        OR (status = 'RESOLVED' AND resolved_at IS NOT NULL AND resolved_by_user_id IS NOT NULL AND length(btrim(resolution_note)) >= 10))
);
-- One OPEN exception of a kind per sale: a re-scan never opens it twice.
CREATE UNIQUE INDEX ux_pos_fulfilment_exceptions_open ON pos_fulfilment_exceptions (sale_id, kind) WHERE status = 'OPEN';
CREATE INDEX ix_pos_fulfilment_exceptions_merchant ON pos_fulfilment_exceptions (merchant_id, status, opened_at DESC);

-- The append-only history of what happened to a fulfilment (attempts, failures, exceptions, the posting).
CREATE TABLE pos_fulfilment_events (
    id           bigserial PRIMARY KEY,
    merchant_id  uuid         NOT NULL,
    sale_id      uuid         NOT NULL,
    kind         varchar(30)  NOT NULL,
    detail       varchar(500) NOT NULL,
    created_at   timestamptz  NOT NULL,
    CONSTRAINT fk_pos_fulfilment_events_sale FOREIGN KEY (sale_id, merchant_id) REFERENCES pos_sales (payment_request_id, merchant_id)
);
CREATE INDEX ix_pos_fulfilment_events_sale ON pos_fulfilment_events (sale_id, id);

-- ---------------------------------------------------------------------------------------------
-- 3. What the database itself guarantees
-- ---------------------------------------------------------------------------------------------
CREATE FUNCTION forbid_pos_fulfilment_history_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'fulfilment history is append-only';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_pos_fulfilment_events_immutable BEFORE UPDATE OR DELETE ON pos_fulfilment_events
    FOR EACH ROW EXECUTE FUNCTION forbid_pos_fulfilment_history_change();
CREATE TRIGGER trg_pos_fulfilment_lines_immutable BEFORE UPDATE OR DELETE ON pos_fulfilment_lines
    FOR EACH ROW EXECUTE FUNCTION forbid_pos_fulfilment_history_change();

-- A fulfilment keeps its identity; POSTED is final; EXCEPTION is not re-queued automatically.
CREATE FUNCTION guard_pos_fulfilment() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a fulfilment is never deleted';
    END IF;
    IF OLD.sale_id <> NEW.sale_id OR OLD.merchant_id <> NEW.merchant_id OR OLD.invoice_id <> NEW.invoice_id OR OLD.branch_id <> NEW.branch_id
       OR OLD.reservation_id <> NEW.reservation_id OR OLD.created_at <> NEW.created_at THEN
        RAISE EXCEPTION 'the identity of a fulfilment never changes';
    END IF;
    IF OLD.status = 'POSTED' AND (NEW.status <> 'POSTED' OR NEW.posted_at IS DISTINCT FROM OLD.posted_at OR NEW.attempts <> OLD.attempts) THEN
        RAISE EXCEPTION 'a posted fulfilment is final';
    END IF;
    IF OLD.status = 'EXCEPTION' AND NEW.status <> 'EXCEPTION' THEN
        RAISE EXCEPTION 'an exception is resolved by a person, not by retrying';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_pos_fulfilments_guard BEFORE UPDATE OR DELETE ON pos_fulfilments
    FOR EACH ROW EXECUTE FUNCTION guard_pos_fulfilment();

-- An exception keeps its identity and is never deleted; its only change is OPEN -> RESOLVED.
CREATE FUNCTION guard_pos_fulfilment_exception() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a fulfilment exception is never deleted';
    END IF;
    IF OLD.sale_id <> NEW.sale_id OR OLD.merchant_id <> NEW.merchant_id OR OLD.kind <> NEW.kind OR OLD.detail <> NEW.detail OR OLD.opened_at <> NEW.opened_at THEN
        RAISE EXCEPTION 'the identity of a fulfilment exception never changes';
    END IF;
    IF OLD.status = 'RESOLVED' THEN
        RAISE EXCEPTION 'a resolved fulfilment exception is final';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_pos_fulfilment_exceptions_guard BEFORE UPDATE OR DELETE ON pos_fulfilment_exceptions
    FOR EACH ROW EXECUTE FUNCTION guard_pos_fulfilment_exception();

-- A posting line must be EXACTLY its reservation line, deducted by a SALE movement of exactly that quantity at that branch and item.
CREATE FUNCTION guard_pos_fulfilment_line() RETURNS trigger AS $$
DECLARE
    line stock_reservation_lines%ROWTYPE;
    movement stock_movements%ROWTYPE;
    owner_reservation uuid;
BEGIN
    SELECT * INTO line FROM stock_reservation_lines WHERE id = NEW.reservation_line_id;
    SELECT * INTO movement FROM stock_movements WHERE id = NEW.movement_id;
    SELECT reservation_id INTO owner_reservation FROM pos_fulfilments WHERE sale_id = NEW.sale_id AND merchant_id = NEW.merchant_id;
    IF line.id IS NULL OR movement.id IS NULL OR owner_reservation IS DISTINCT FROM line.reservation_id THEN
        RAISE EXCEPTION 'a posting must describe a line of the reservation of its own sale';
    END IF;
    IF movement.movement_type <> 'SALE' OR movement.merchant_id <> line.merchant_id OR movement.branch_id <> line.branch_id OR movement.item_id <> line.item_id
       OR movement.quantity_delta <> -line.quantity OR NEW.quantity <> line.quantity OR NEW.merchant_id <> line.merchant_id
       OR NEW.branch_id <> line.branch_id OR NEW.item_id <> line.item_id THEN
        RAISE EXCEPTION 'a posting must deduct exactly the reserved quantity, by a SALE movement, at the reserved branch and item';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_pos_fulfilment_lines_guard BEFORE INSERT ON pos_fulfilment_lines
    FOR EACH ROW EXECUTE FUNCTION guard_pos_fulfilment_line();

-- ATOMICITY, checked at commit: a SALE movement has a posting; a FULFILLED reservation has a POSTED fulfilment; a POSTED fulfilment has a FULFILLED
-- reservation and one posting for EVERY reservation line. So the reservation, the movements and the fulfilment are written together or not at all.
CREATE FUNCTION check_sale_movement_posted() RETURNS trigger AS $$
BEGIN
    IF NEW.movement_type = 'SALE' AND NOT EXISTS (SELECT 1 FROM pos_fulfilment_lines WHERE movement_id = NEW.id) THEN
        RAISE EXCEPTION 'a SALE movement belongs to a fulfilment posting';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER trg_stock_movements_sale_posted AFTER INSERT ON stock_movements
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_sale_movement_posted();

CREATE FUNCTION check_fulfilment_consistent() RETURNS trigger AS $$
DECLARE
    reservation_id_value uuid;
    reservation_status varchar;
    fulfilment_status varchar;
    expected integer;
    posted integer;
BEGIN
    IF TG_TABLE_NAME = 'stock_reservations' THEN
        reservation_id_value := NEW.id;
    ELSIF TG_TABLE_NAME = 'pos_fulfilments' THEN
        reservation_id_value := NEW.reservation_id;
    ELSE
        SELECT reservation_id INTO reservation_id_value FROM pos_fulfilments WHERE sale_id = NEW.sale_id;
    END IF;
    SELECT status INTO reservation_status FROM stock_reservations WHERE id = reservation_id_value;
    SELECT status INTO fulfilment_status FROM pos_fulfilments WHERE reservation_id = reservation_id_value;
    IF reservation_status = 'FULFILLED' AND fulfilment_status IS DISTINCT FROM 'POSTED' THEN
        RAISE EXCEPTION 'a reservation is fulfilled only by a posted fulfilment';
    END IF;
    IF fulfilment_status = 'POSTED' THEN
        IF reservation_status IS DISTINCT FROM 'FULFILLED' THEN
            RAISE EXCEPTION 'a posted fulfilment needs a fulfilled reservation';
        END IF;
        SELECT count(*) INTO expected FROM stock_reservation_lines WHERE reservation_id = reservation_id_value;
        SELECT count(*) INTO posted FROM pos_fulfilment_lines l JOIN stock_reservation_lines r ON r.id = l.reservation_line_id WHERE r.reservation_id = reservation_id_value;
        IF expected <> posted THEN
            RAISE EXCEPTION 'a posted fulfilment needs one posting for every reserved line';
        END IF;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER trg_stock_reservations_fulfilled AFTER UPDATE ON stock_reservations
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.status = 'FULFILLED') EXECUTE FUNCTION check_fulfilment_consistent();
CREATE CONSTRAINT TRIGGER trg_pos_fulfilments_consistent AFTER INSERT OR UPDATE ON pos_fulfilments
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_fulfilment_consistent();
CREATE CONSTRAINT TRIGGER trg_pos_fulfilment_lines_consistent AFTER INSERT ON pos_fulfilment_lines
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_fulfilment_consistent();
