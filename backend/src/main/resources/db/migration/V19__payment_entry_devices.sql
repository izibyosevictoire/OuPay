-- R8a: persistent payment-ENTRY devices (static QR codes, NFC tags, NFC bracelets). Additive: V1 to V18 are untouched.
--
-- A device is only a stable doorway. It carries one permanent HTTPS URL (/e/{public_token}) and NOTHING else: no bank credential, no
-- account, no amount, no person. The physical object never changes between customers; OuPay decides, server side, which prepared bill the
-- doorway currently leads to. QR and NFC are entry methods only: the bill is still paid through the bank-approved collection code of the
-- sale, and reconciliation (R6d-B) stays the only authority on whether money arrived. NOTHING in this migration touches the ledger, a payment
-- request or stock.
--
--   payment_entry_devices            the registered doorway (merchant, branch, optional cashier, lifecycle)
--   payment_entry_device_assignments immutable history of every (branch, cashier) the device has had
--   payment_entry_bindings           which prepared sale a device leads to; at most ONE open binding per device and per sale
--   payment_entry_claims             a short-lived customer session on a bound sale; at most ONE open claim per device
--
-- The public token is an OPAQUE public identifier (128 random bits), never a merchant, cashier or sale id. It is stored as is because the owner
-- must be able to copy and reprint the same URL: it is not a credential (anyone with the tag can read it) and it opens nothing but the
-- currently bound bill's customer page, through a claim. The CLAIM token, in contrast, is a bearer secret of one customer's session: only its
-- SHA-256 hash is stored and it is shown to that customer once.

-- ---------------------------------------------------------------------------------------------
-- 1. A code sale can be referenced together with its branch (so a binding can never name another branch's sale)
-- ---------------------------------------------------------------------------------------------
ALTER TABLE code_sales ADD CONSTRAINT ux_code_sales_id_merchant_branch UNIQUE (payment_request_id, merchant_id, branch_id);

-- ---------------------------------------------------------------------------------------------
-- 2. Devices
-- ---------------------------------------------------------------------------------------------
CREATE TABLE payment_entry_devices (
    id                        uuid PRIMARY KEY,
    merchant_id               uuid         NOT NULL REFERENCES merchants (id),
    branch_id                 uuid         NOT NULL,
    device_type               varchar(14)  NOT NULL,
    -- 16 random bytes, base64url without padding. Opaque: it names no merchant, branch, person or sale.
    public_token              varchar(22)  NOT NULL,
    display_name              varchar(60)  NOT NULL,
    -- The cashier who normally sells through this device. NULL for a shared counter device. A bracelet is personal, so it always has one.
    assigned_cashier_user_id  uuid REFERENCES users (id),
    status                    varchar(10)  NOT NULL,
    status_reason             varchar(200),
    client_request_id         uuid         NOT NULL,
    created_by_user_id        uuid         NOT NULL REFERENCES users (id),
    created_at                timestamptz  NOT NULL,
    updated_at                timestamptz  NOT NULL,
    revoked_at                timestamptz,
    version                   bigint       NOT NULL DEFAULT 0,
    CONSTRAINT ux_entry_devices_token UNIQUE (public_token),
    CONSTRAINT ux_entry_devices_id_merchant UNIQUE (id, merchant_id),
    CONSTRAINT ux_entry_devices_request UNIQUE (merchant_id, client_request_id),
    CONSTRAINT fk_entry_devices_branch FOREIGN KEY (branch_id, merchant_id) REFERENCES branches (id, merchant_id),
    CONSTRAINT ck_entry_devices_type CHECK (device_type IN ('STATIC_QR', 'NFC_TAG', 'NFC_BRACELET')),
    CONSTRAINT ck_entry_devices_token CHECK (public_token ~ '^[A-Za-z0-9_-]{22}$'),
    CONSTRAINT ck_entry_devices_name CHECK (length(btrim(display_name)) BETWEEN 1 AND 60),
    CONSTRAINT ck_entry_devices_status CHECK (status IN ('ACTIVE', 'SUSPENDED', 'REVOKED')),
    CONSTRAINT ck_entry_devices_bracelet CHECK (device_type <> 'NFC_BRACELET' OR assigned_cashier_user_id IS NOT NULL),
    CONSTRAINT ck_entry_devices_revoked CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);
CREATE INDEX ix_entry_devices_list ON payment_entry_devices (merchant_id, created_at DESC, id DESC);
CREATE INDEX ix_entry_devices_branch ON payment_entry_devices (merchant_id, branch_id);
-- A name identifies a device to the people at the counter: unique among the devices that are not revoked.
CREATE UNIQUE INDEX ux_entry_devices_name ON payment_entry_devices (merchant_id, lower(display_name)) WHERE status <> 'REVOKED';

-- ---------------------------------------------------------------------------------------------
-- 3. Assignment history: every (branch, cashier) a device has had, with the person who changed it
-- ---------------------------------------------------------------------------------------------
CREATE TABLE payment_entry_device_assignments (
    id                        uuid PRIMARY KEY,
    device_id                 uuid         NOT NULL,
    merchant_id               uuid         NOT NULL,
    branch_id                 uuid         NOT NULL,
    branch_name               varchar(120) NOT NULL,
    assigned_cashier_user_id  uuid REFERENCES users (id),
    -- The name as it was when the assignment was made: later renames never rewrite history.
    assigned_cashier_name     varchar(120),
    valid_from                timestamptz  NOT NULL,
    valid_to                  timestamptz,
    assigned_by_user_id       uuid         NOT NULL REFERENCES users (id),
    change_reason             varchar(200),
    CONSTRAINT fk_entry_assignments_device FOREIGN KEY (device_id, merchant_id) REFERENCES payment_entry_devices (id, merchant_id),
    CONSTRAINT fk_entry_assignments_branch FOREIGN KEY (branch_id, merchant_id) REFERENCES branches (id, merchant_id),
    CONSTRAINT ck_entry_assignments_period CHECK (valid_to IS NULL OR valid_to >= valid_from),
    CONSTRAINT ck_entry_assignments_name CHECK ((assigned_cashier_user_id IS NULL) = (assigned_cashier_name IS NULL))
);
CREATE UNIQUE INDEX ux_entry_assignments_open ON payment_entry_device_assignments (device_id) WHERE valid_to IS NULL;
CREATE INDEX ix_entry_assignments_history ON payment_entry_device_assignments (device_id, valid_from DESC);

-- ---------------------------------------------------------------------------------------------
-- 4. Bindings: which prepared sale a device leads to
-- ---------------------------------------------------------------------------------------------
CREATE TABLE payment_entry_bindings (
    id                        uuid PRIMARY KEY,
    device_id                 uuid         NOT NULL,
    merchant_id               uuid         NOT NULL,
    branch_id                 uuid         NOT NULL,
    -- The sale IS its payment request (code_sales.payment_request_id). The sale keeps its own identity and its code-assignment snapshot.
    sale_id                   uuid         NOT NULL,
    -- The sale's agent as the sale recorded it. A binding never changes who collected.
    agent_user_id             uuid         NOT NULL REFERENCES users (id),
    bound_by_user_id          uuid         NOT NULL REFERENCES users (id),
    bound_at                  timestamptz  NOT NULL,
    ended_at                  timestamptz,
    end_reason                varchar(20),
    -- NULL when the system closed it (the sale reached an end by itself).
    ended_by_user_id          uuid REFERENCES users (id),
    CONSTRAINT ux_entry_bindings_key UNIQUE (id, device_id, merchant_id),
    CONSTRAINT fk_entry_bindings_device FOREIGN KEY (device_id, merchant_id) REFERENCES payment_entry_devices (id, merchant_id),
    CONSTRAINT fk_entry_bindings_sale FOREIGN KEY (sale_id, merchant_id, branch_id) REFERENCES code_sales (payment_request_id, merchant_id, branch_id),
    CONSTRAINT ck_entry_bindings_end CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
    CONSTRAINT ck_entry_bindings_reason CHECK (end_reason IS NULL OR end_reason IN
        ('UNBOUND', 'SALE_PAID', 'SALE_EXPIRED', 'SALE_CANCELLED', 'DEVICE_REVOKED', 'DEVICE_REASSIGNED')),
    CONSTRAINT ck_entry_bindings_period CHECK (ended_at IS NULL OR ended_at >= bound_at)
);
-- ONE open binding per device, and a sale can lead from at most one device at a time: concurrent binds can never overwrite each other.
CREATE UNIQUE INDEX ux_entry_bindings_device_open ON payment_entry_bindings (device_id) WHERE ended_at IS NULL;
CREATE UNIQUE INDEX ux_entry_bindings_sale_open ON payment_entry_bindings (sale_id) WHERE ended_at IS NULL;
CREATE INDEX ix_entry_bindings_history ON payment_entry_bindings (device_id, bound_at DESC);
CREATE INDEX ix_entry_bindings_sale ON payment_entry_bindings (sale_id);

-- ---------------------------------------------------------------------------------------------
-- 5. Claims: a customer's short-lived session on the bound sale
-- ---------------------------------------------------------------------------------------------
CREATE TABLE payment_entry_claims (
    id                        uuid PRIMARY KEY,
    device_id                 uuid         NOT NULL,
    merchant_id               uuid         NOT NULL,
    binding_id                uuid         NOT NULL,
    sale_id                   uuid         NOT NULL,
    -- SHA-256 (lower-case hex) of the opaque claim token the customer's browser holds. The token itself is never stored.
    claim_token_hash          char(64)     NOT NULL,
    created_at                timestamptz  NOT NULL,
    expires_at                timestamptz  NOT NULL,
    ended_at                  timestamptz,
    end_reason                varchar(20),
    CONSTRAINT ux_entry_claims_token UNIQUE (claim_token_hash),
    CONSTRAINT fk_entry_claims_binding FOREIGN KEY (binding_id, device_id, merchant_id) REFERENCES payment_entry_bindings (id, device_id, merchant_id),
    CONSTRAINT ck_entry_claims_hash CHECK (claim_token_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_entry_claims_period CHECK (expires_at > created_at),
    CONSTRAINT ck_entry_claims_end CHECK ((ended_at IS NULL) = (end_reason IS NULL)),
    CONSTRAINT ck_entry_claims_reason CHECK (end_reason IS NULL OR end_reason IN ('EXPIRED', 'RELEASED', 'BINDING_ENDED', 'DEVICE_REVOKED'))
);
-- ONE open claim per device, whatever the number of backend instances: the database, not a process, prevents two customers sharing a device.
CREATE UNIQUE INDEX ux_entry_claims_device_open ON payment_entry_claims (device_id) WHERE ended_at IS NULL;
CREATE INDEX ix_entry_claims_binding ON payment_entry_claims (binding_id);

-- ---------------------------------------------------------------------------------------------
-- 6. Guards
-- ---------------------------------------------------------------------------------------------

-- A cashier may hold a device only while they are an ACTIVE member of the business assigned to the device's branch; the branch must be ACTIVE.
-- (Checked when the assignment is made: later staff changes never rewrite history, the owner sees them and reassigns.)
CREATE FUNCTION guard_entry_device() RETURNS trigger AS $$
DECLARE
    branch_status varchar;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF NEW.id IS DISTINCT FROM OLD.id OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id OR NEW.device_type IS DISTINCT FROM OLD.device_type
           OR NEW.public_token IS DISTINCT FROM OLD.public_token OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
           OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.client_request_id IS DISTINCT FROM OLD.client_request_id THEN
            RAISE EXCEPTION 'a payment entry device keeps its identity, type and public token for life';
        END IF;
        IF OLD.status = 'REVOKED' THEN
            RAISE EXCEPTION 'a revoked payment entry device is final';
        END IF;
        IF NEW.branch_id IS NOT DISTINCT FROM OLD.branch_id AND NEW.assigned_cashier_user_id IS NOT DISTINCT FROM OLD.assigned_cashier_user_id THEN
            RETURN NEW;
        END IF;
        IF NEW.status = 'REVOKED' THEN
            RETURN NEW;
        END IF;
    END IF;
    SELECT status INTO branch_status FROM branches WHERE id = NEW.branch_id AND merchant_id = NEW.merchant_id;
    IF branch_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'a payment entry device can only belong to an active branch of its business';
    END IF;
    IF NEW.assigned_cashier_user_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM memberships m
          JOIN branch_assignments a ON a.membership_id = m.id AND a.merchant_id = m.merchant_id
         WHERE m.user_id = NEW.assigned_cashier_user_id AND m.merchant_id = NEW.merchant_id AND m.status = 'ACTIVE'
           AND a.branch_id = NEW.branch_id AND a.status = 'ACTIVE') THEN
        RAISE EXCEPTION 'the assigned cashier must be an active member assigned to the device''s branch';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_entry_devices_guard BEFORE INSERT OR UPDATE ON payment_entry_devices FOR EACH ROW EXECUTE FUNCTION guard_entry_device();
CREATE TRIGGER trg_entry_devices_nodelete BEFORE DELETE ON payment_entry_devices FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- The device's current branch and cashier always equal its open assignment: history can not drift from the current state (checked at commit).
CREATE FUNCTION check_entry_device_assignment() RETURNS trigger AS $$
BEGIN
    IF NEW.status = 'REVOKED' THEN
        RETURN NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM payment_entry_device_assignments a
                    WHERE a.device_id = NEW.id AND a.valid_to IS NULL AND a.branch_id = NEW.branch_id
                      AND a.assigned_cashier_user_id IS NOT DISTINCT FROM NEW.assigned_cashier_user_id) THEN
        RAISE EXCEPTION 'a payment entry device must have an open assignment record matching its branch and cashier';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER trg_entry_devices_assignment_consistent AFTER INSERT OR UPDATE ON payment_entry_devices
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_device_assignment();

CREATE FUNCTION guard_entry_assignment() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.valid_to IS NOT NULL OR NEW.valid_to IS NULL
           OR (NEW.id, NEW.device_id, NEW.merchant_id, NEW.branch_id, NEW.branch_name, NEW.assigned_cashier_user_id, NEW.assigned_cashier_name,
               NEW.valid_from, NEW.assigned_by_user_id, NEW.change_reason)
              IS DISTINCT FROM
              (OLD.id, OLD.device_id, OLD.merchant_id, OLD.branch_id, OLD.branch_name, OLD.assigned_cashier_user_id, OLD.assigned_cashier_name,
               OLD.valid_from, OLD.assigned_by_user_id, OLD.change_reason) THEN
            RAISE EXCEPTION 'an assignment record can only be closed, once, and never rewritten';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_entry_assignments_guard BEFORE UPDATE ON payment_entry_device_assignments FOR EACH ROW EXECUTE FUNCTION guard_entry_assignment();
CREATE TRIGGER trg_entry_assignments_nodelete BEFORE DELETE ON payment_entry_device_assignments FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- A binding can be made only for an ACTIVE device, for a sale of the device's own branch, collected by the device's cashier (when it has one),
-- and only while the sale's payment request is neither cancelled nor expired. Once made, a binding is only ever closed.
CREATE FUNCTION guard_entry_binding() RETURNS trigger AS $$
DECLARE
    device RECORD;
    sale RECORD;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.ended_at IS NOT NULL OR NEW.ended_at IS NULL
           OR (NEW.id, NEW.device_id, NEW.merchant_id, NEW.branch_id, NEW.sale_id, NEW.agent_user_id, NEW.bound_by_user_id, NEW.bound_at)
              IS DISTINCT FROM (OLD.id, OLD.device_id, OLD.merchant_id, OLD.branch_id, OLD.sale_id, OLD.agent_user_id, OLD.bound_by_user_id, OLD.bound_at) THEN
            RAISE EXCEPTION 'a binding can only be closed, once, and never rewritten';
        END IF;
        RETURN NEW;
    END IF;
    SELECT status, branch_id, assigned_cashier_user_id INTO device FROM payment_entry_devices WHERE id = NEW.device_id AND merchant_id = NEW.merchant_id;
    IF device.status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'only an active payment entry device can be bound to a sale';
    END IF;
    IF device.branch_id IS DISTINCT FROM NEW.branch_id THEN
        RAISE EXCEPTION 'a device can only be bound to a sale of its own branch';
    END IF;
    SELECT s.agent_user_id, r.cancelled_at, r.expires_at INTO sale
      FROM code_sales s JOIN payment_requests r ON r.id = s.payment_request_id AND r.merchant_id = s.merchant_id
     WHERE s.payment_request_id = NEW.sale_id AND s.merchant_id = NEW.merchant_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'the sale does not exist in this business';
    END IF;
    IF sale.agent_user_id IS DISTINCT FROM NEW.agent_user_id THEN
        RAISE EXCEPTION 'a binding records the agent of the sale, never another person';
    END IF;
    IF device.assigned_cashier_user_id IS NOT NULL AND device.assigned_cashier_user_id IS DISTINCT FROM sale.agent_user_id THEN
        RAISE EXCEPTION 'this device belongs to another cashier: it can only lead to that cashier''s sales';
    END IF;
    IF sale.cancelled_at IS NOT NULL OR sale.expires_at <= NEW.bound_at THEN
        RAISE EXCEPTION 'a cancelled or expired sale can not be bound to a device';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_entry_bindings_guard BEFORE INSERT OR UPDATE ON payment_entry_bindings FOR EACH ROW EXECUTE FUNCTION guard_entry_binding();
CREATE TRIGGER trg_entry_bindings_nodelete BEFORE DELETE ON payment_entry_bindings FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- A claim exists only on an ACTIVE device's OPEN binding, for that binding's own sale. Afterwards only its expiry may be extended (while open)
-- or it may be closed once; it never moves to another sale.
CREATE FUNCTION guard_entry_claim() RETURNS trigger AS $$
DECLARE
    binding RECORD;
    device_status varchar;
BEGIN
    IF TG_OP = 'UPDATE' THEN
        IF OLD.ended_at IS NOT NULL
           OR (NEW.id, NEW.device_id, NEW.merchant_id, NEW.binding_id, NEW.sale_id, NEW.claim_token_hash, NEW.created_at)
              IS DISTINCT FROM (OLD.id, OLD.device_id, OLD.merchant_id, OLD.binding_id, OLD.sale_id, OLD.claim_token_hash, OLD.created_at)
           OR (NEW.ended_at IS NULL AND NEW.expires_at < OLD.expires_at) THEN
            RAISE EXCEPTION 'a claim can only be renewed or closed, and never rewritten';
        END IF;
        RETURN NEW;
    END IF;
    SELECT status INTO device_status FROM payment_entry_devices WHERE id = NEW.device_id AND merchant_id = NEW.merchant_id;
    SELECT sale_id, ended_at INTO binding FROM payment_entry_bindings WHERE id = NEW.binding_id AND device_id = NEW.device_id;
    IF device_status IS DISTINCT FROM 'ACTIVE' THEN
        RAISE EXCEPTION 'a claim can only be opened on an active payment entry device';
    END IF;
    IF binding.ended_at IS NOT NULL OR binding.sale_id IS DISTINCT FROM NEW.sale_id THEN
        RAISE EXCEPTION 'a claim belongs to the open binding of its own sale';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_entry_claims_guard BEFORE INSERT OR UPDATE ON payment_entry_claims FOR EACH ROW EXECUTE FUNCTION guard_entry_claim();
CREATE TRIGGER trg_entry_claims_nodelete BEFORE DELETE ON payment_entry_claims FOR EACH ROW EXECUTE FUNCTION forbid_delete();

-- At commit: a closed binding has no open claim, and a revoked device has no open binding or claim.
CREATE FUNCTION check_entry_binding_closed() RETURNS trigger AS $$
BEGIN
    IF NEW.ended_at IS NOT NULL AND EXISTS (SELECT 1 FROM payment_entry_claims c WHERE c.binding_id = NEW.id AND c.ended_at IS NULL) THEN
        RAISE EXCEPTION 'a closed binding can not leave a customer claim open';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER trg_entry_bindings_closed_consistent AFTER UPDATE ON payment_entry_bindings
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_binding_closed();

CREATE FUNCTION check_entry_device_revoked() RETURNS trigger AS $$
BEGIN
    IF NEW.status = 'REVOKED' AND (EXISTS (SELECT 1 FROM payment_entry_bindings b WHERE b.device_id = NEW.id AND b.ended_at IS NULL)
                                   OR EXISTS (SELECT 1 FROM payment_entry_claims c WHERE c.device_id = NEW.id AND c.ended_at IS NULL)) THEN
        RAISE EXCEPTION 'a revoked payment entry device can not keep an open binding or claim';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER trg_entry_devices_revoked_consistent AFTER UPDATE ON payment_entry_devices
    DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_entry_device_revoked();
