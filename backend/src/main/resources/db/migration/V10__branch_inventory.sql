-- R5c: branch-level physical stock of GOODS: a balance per (business, branch, item) and an append-only movement history.
--
-- Purely ADDITIVE (two tables, two functions, three triggers): no existing table, row or constraint is touched, so the
-- previous application version keeps working against this schema and rolling back needs no schema change.
--
-- Conventions (V1, V9): every table carries merchant_id and references stay inside one business through COMPOSITE foreign
-- keys, so a balance can never join a branch of one business to an item of another. Quantities are NUMERIC(20,6) in the
-- item's CANONICAL stock unit (g, ml, mm, mm2, pc; the R5a measurement contract). Nothing is rounded, no floating point.
--
-- What the database refuses on its own, whatever the application does:
--   * stock for a SERVICE (the item key includes item_type = 'GOODS');
--   * a negative balance, or a balance beyond NUMERIC(20,6);
--   * a fractional piece (COUNT goods hold whole numbers only);
--   * a movement whose sign does not match its type, an adjustment without a reason, a zero movement;
--   * changing or deleting a movement (history is immutable; a mistake is fixed by a NEW movement);
--   * the same operation id twice in one business, and a second OPENING for the same branch and item;
--   * ANY change of a quantity that is not made by a stock movement: a balance starts empty and its quantity changes only inside
--     the BEFORE INSERT trigger of a movement, which checks that the movement continues exactly from the current balance and then
--     applies it, under the balance row lock. So a balance can never differ from the sum of its movements, whatever SQL is run
--     (a superuser can of course disable triggers, as with any trigger-based guarantee).
-- Reservation, sale, return and correction movements arrive in later milestones with their own migration widening
-- ck_stock_movements_type; today only OPENING, RECEIVE, ADJUST_IN and ADJUST_OUT can exist.

CREATE TABLE inventory_balances (
    id                    uuid PRIMARY KEY,
    merchant_id           uuid          NOT NULL,
    branch_id             uuid          NOT NULL,
    item_id               uuid          NOT NULL,
    item_type             varchar(8)    NOT NULL DEFAULT 'GOODS',
    measurement_dimension varchar(8)    NOT NULL,
    -- Physical stock in the item's canonical stock unit. No reservations exist yet, so available = on hand.
    quantity_on_hand      numeric(20,6) NOT NULL,
    created_at            timestamptz   NOT NULL,
    updated_at            timestamptz   NOT NULL,
    version               bigint        NOT NULL DEFAULT 0,
    CONSTRAINT fk_inventory_balances_branch FOREIGN KEY (branch_id, merchant_id) REFERENCES branches (id, merchant_id),
    -- Only a GOODS item of the same business, with the same dimension, can have stock.
    CONSTRAINT fk_inventory_balances_item FOREIGN KEY (item_id, merchant_id, item_type, measurement_dimension)
        REFERENCES catalog_items (id, merchant_id, item_type, measurement_dimension),
    CONSTRAINT ck_inventory_balances_goods CHECK (item_type = 'GOODS'),
    CONSTRAINT ck_inventory_balances_quantity CHECK (quantity_on_hand >= 0 AND quantity_on_hand <= 99999999999999.999999),
    CONSTRAINT ck_inventory_balances_whole_pieces CHECK (measurement_dimension <> 'COUNT' OR quantity_on_hand = trunc(quantity_on_hand)),
    -- One balance per business, branch and item (also the key movements reference).
    CONSTRAINT ux_inventory_balances_key UNIQUE (merchant_id, branch_id, item_id)
);
CREATE INDEX ix_inventory_balances_list ON inventory_balances (merchant_id, created_at DESC, id DESC);
CREATE INDEX ix_inventory_balances_item ON inventory_balances (item_id);

-- Which stock a balance belongs to can never change, and its quantity changes ONLY through a stock movement (see
-- apply_stock_movement below, which raises the transaction-local flag this trigger looks for).
CREATE FUNCTION forbid_inventory_balance_identity_change() RETURNS trigger AS $$
BEGIN
    IF NEW.quantity_on_hand IS DISTINCT FROM OLD.quantity_on_hand
       AND coalesce(current_setting('oupay.applying_stock_movement', true), 'off') <> 'on' THEN
        RAISE EXCEPTION 'stock changes only through a stock movement';
    END IF;
    IF NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
       OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
       OR NEW.item_id IS DISTINCT FROM OLD.item_id
       OR NEW.item_type IS DISTINCT FROM OLD.item_type
       OR NEW.measurement_dimension IS DISTINCT FROM OLD.measurement_dimension
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'the branch and item of an inventory balance cannot change';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_inventory_balances_identity BEFORE UPDATE ON inventory_balances
    FOR EACH ROW EXECUTE FUNCTION forbid_inventory_balance_identity_change();

-- A balance is born empty: stock arrives only through movements.
CREATE FUNCTION require_empty_new_inventory_balance() RETURNS trigger AS $$
BEGIN
    IF NEW.quantity_on_hand <> 0 THEN
        RAISE EXCEPTION 'a new inventory balance must start empty; stock arrives through stock movements';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_inventory_balances_start_empty BEFORE INSERT ON inventory_balances
    FOR EACH ROW EXECUTE FUNCTION require_empty_new_inventory_balance();

CREATE TABLE stock_movements (
    id               uuid PRIMARY KEY,
    merchant_id      uuid          NOT NULL,
    branch_id        uuid          NOT NULL,
    item_id          uuid          NOT NULL,
    movement_type    varchar(12)   NOT NULL,
    -- SIGNED canonical quantity: positive adds stock, negative removes it.
    quantity_delta   numeric(20,6) NOT NULL,
    -- The balance right after this movement (so history reads as a running balance and can be audited against the sum).
    balance_after    numeric(20,6) NOT NULL,
    -- How the quantity was entered, for people ("25 kg", "2 x Bag"). Informational; quantity_delta is the truth.
    entered_as       varchar(160),
    reason           varchar(200),
    reference        varchar(100),
    -- The durable identity of the operation (a client-generated id). With the fingerprint it makes a repeated submission
    -- harmless forever, long after any HTTP-level idempotency record has been pruned.
    operation_id     uuid          NOT NULL,
    request_sha256   varchar(64)   NOT NULL,
    actor_user_id    uuid          NOT NULL REFERENCES users (id),
    created_at       timestamptz   NOT NULL,
    -- The movement belongs to exactly the balance of its own business, branch and item.
    CONSTRAINT fk_stock_movements_balance FOREIGN KEY (merchant_id, branch_id, item_id)
        REFERENCES inventory_balances (merchant_id, branch_id, item_id),
    CONSTRAINT ck_stock_movements_type CHECK (movement_type IN ('OPENING', 'RECEIVE', 'ADJUST_IN', 'ADJUST_OUT')),
    CONSTRAINT ck_stock_movements_sign CHECK (
        (movement_type IN ('OPENING', 'RECEIVE', 'ADJUST_IN') AND quantity_delta > 0)
        OR (movement_type = 'ADJUST_OUT' AND quantity_delta < 0)),
    CONSTRAINT ck_stock_movements_quantity CHECK (abs(quantity_delta) <= 99999999999999.999999),
    -- Never negative after the movement, and never negative before it either.
    CONSTRAINT ck_stock_movements_balance CHECK (balance_after >= 0 AND balance_after <= 99999999999999.999999
        AND balance_after - quantity_delta >= 0),
    CONSTRAINT ck_stock_movements_reason CHECK (
        (movement_type NOT IN ('ADJUST_IN', 'ADJUST_OUT') OR (reason IS NOT NULL AND length(btrim(reason)) > 0))
        AND (reason IS NULL OR length(btrim(reason)) > 0)
        AND (reference IS NULL OR length(btrim(reference)) > 0)),
    CONSTRAINT ck_stock_movements_sha256 CHECK (request_sha256 ~ '^[0-9a-f]{64}$')
);
-- One movement per (business, operation id): the permanent guard against recording the same operation twice.
CREATE UNIQUE INDEX ux_stock_movements_operation ON stock_movements (merchant_id, operation_id);
-- At most one opening per branch and item (the service also requires that no movement exists before it).
CREATE UNIQUE INDEX ux_stock_movements_opening ON stock_movements (merchant_id, branch_id, item_id) WHERE movement_type = 'OPENING';
-- Keyset history: newest first, total order (created_at, id), for the business and for one branch and item.
CREATE INDEX ix_stock_movements_list ON stock_movements (merchant_id, created_at DESC, id DESC);
CREATE INDEX ix_stock_movements_balance ON stock_movements (merchant_id, branch_id, item_id, created_at DESC, id DESC);

-- History is append-only: a recorded movement is never changed or removed. A mistake is corrected by a new movement.
CREATE FUNCTION forbid_stock_movement_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'stock movements are immutable';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_stock_movements_immutable BEFORE UPDATE OR DELETE ON stock_movements
    FOR EACH ROW EXECUTE FUNCTION forbid_stock_movement_change();

-- Every committed change of a balance is exactly one movement: inserting a movement APPLIES it. Under the balance row lock the
-- trigger checks that the movement continues exactly from the current balance (balance_after = current + delta, compared as
-- numbers, so 1 and 1.000000 agree), that OPENING really is the first movement of the branch and item, and then moves the balance
-- (the balance CHECK refuses a negative result). Failing anywhere rolls back the movement as well, so the two can never disagree.
-- The application takes the same row lock first (see InventoryService), so this adds no new lock order.
CREATE FUNCTION apply_stock_movement() RETURNS trigger AS $$
DECLARE
    current_quantity numeric(20,6);
BEGIN
    SELECT quantity_on_hand INTO current_quantity FROM inventory_balances
        WHERE merchant_id = NEW.merchant_id AND branch_id = NEW.branch_id AND item_id = NEW.item_id
        FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'a stock movement needs the balance of its branch and item';
    END IF;
    IF NEW.movement_type = 'OPENING' AND EXISTS (SELECT 1 FROM stock_movements m
            WHERE m.merchant_id = NEW.merchant_id AND m.branch_id = NEW.branch_id AND m.item_id = NEW.item_id) THEN
        RAISE EXCEPTION 'opening stock must be the first movement of a branch and item';
    END IF;
    IF current_quantity + NEW.quantity_delta IS DISTINCT FROM NEW.balance_after THEN
        RAISE EXCEPTION 'the movement does not continue from the current balance';
    END IF;
    PERFORM set_config('oupay.applying_stock_movement', 'on', true);
    UPDATE inventory_balances SET quantity_on_hand = NEW.balance_after, updated_at = NEW.created_at, version = version + 1
        WHERE merchant_id = NEW.merchant_id AND branch_id = NEW.branch_id AND item_id = NEW.item_id;
    PERFORM set_config('oupay.applying_stock_movement', 'off', true);
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_stock_movements_apply BEFORE INSERT ON stock_movements
    FOR EACH ROW EXECUTE FUNCTION apply_stock_movement();
