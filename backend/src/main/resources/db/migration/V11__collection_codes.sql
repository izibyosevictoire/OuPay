-- R6a: an INTERNAL registry of merchant collection codes and the agents or collection points they are assigned to.
--
-- Nothing here is, or claims to be, a real Equity till number. Equity's capabilities are unconfirmed (see
-- docs/equity-technical-questions.md). A code is a record of what a merchant asked for and, only once real bank evidence is
-- recorded, of what the bank issued. OuPay never invents a bank-recognised value: the OuPay reference (internal_ref) is a separate
-- identifier that is never presented as a payment code, and external_code stays NULL until bank evidence exists.
--
-- ADDITIVE: two new tables, three functions and their triggers, plus ONE constraint added to payment_destinations (a unique key
-- over its existing, already-unique id plus two existing columns, needed so a code can reference its settlement account and provider
-- together). No existing column, row or behaviour changes, so the previous application version keeps working and rolling back needs
-- no schema change.
--
-- Conventions (V1, V9): every table carries merchant_id and references stay inside one business through COMPOSITE foreign keys.
--
-- What the database refuses on its own, whatever the application does:
--   * a code on another merchant's settlement account, or with a provider other than its account's;
--   * ACTIVE without a bank-issued external code AND recorded approval evidence (bank event, or two different operators);
--   * a bank-issued code attached to two codes in the same provider namespace, EVER (a retired code stays reserved);
--   * an illegal lifecycle step, a change of an approved code or of its evidence, and deleting a code;
--   * two open assignments of one code, overlapping assignment periods, an assignment of a terminal code, an assignment to a member
--     who is not ACTIVE, and any edit of an assignment other than ending it once (history is never rewritten or deleted).

ALTER TABLE payment_destinations
    ADD CONSTRAINT ux_payment_destinations_key UNIQUE (id, merchant_id, provider_id);

-- ---------------------------------------------------------------------------------------------
-- Collection codes
-- ---------------------------------------------------------------------------------------------

CREATE TABLE collection_codes (
    id                          uuid PRIMARY KEY,
    merchant_id                 uuid         NOT NULL REFERENCES merchants (id),
    provider_id                 varchar(24)  NOT NULL,
    settlement_destination_id   uuid         NOT NULL,
    -- Copied from the settlement account when the code is requested: a code on a simulated account is never a live code.
    is_simulated                boolean      NOT NULL,
    -- OuPay's own identifier, for people and support. NEVER a payment code.
    internal_ref                varchar(11)  NOT NULL,
    -- The code the BANK issued. NULL until bank evidence is recorded; then it never changes.
    external_code               varchar(64),
    display_label               varchar(60)  NOT NULL,
    branch_id                   uuid,
    status                      varchar(20)  NOT NULL,
    status_reason               varchar(300),
    -- The OWNER's declaration that a request was made to the bank, with the reference they were given. Unverified by OuPay, and NOT an
    -- acknowledgement by the bank: REQUEST_DECLARED means "the owner says they asked", never "the bank has it" or "the bank agreed".
    bank_request_ref            varchar(200),
    bank_request_recorded_at    timestamptz,
    -- Evidence of the bank's approval: a verified bank event, or a trusted operator (two different people) citing real evidence.
    approval_source             varchar(12),
    approval_evidence_ref       varchar(200),
    approval_recorded_by_user_id uuid REFERENCES users (id),
    approval_checked_by_user_id  uuid REFERENCES users (id),
    approved_at                 timestamptz,
    -- Durable identity of the request that created it, with its server-computed fingerprint: a repeat is the same request.
    client_request_id           uuid         NOT NULL,
    request_sha256              varchar(64)  NOT NULL,
    created_by_user_id          uuid         NOT NULL REFERENCES users (id),
    created_at                  timestamptz  NOT NULL,
    updated_at                  timestamptz  NOT NULL,
    version                     bigint       NOT NULL DEFAULT 0,
    -- The code belongs to a settlement account of the SAME merchant, and to that account's provider.
    CONSTRAINT fk_collection_codes_destination FOREIGN KEY (settlement_destination_id, merchant_id, provider_id)
        REFERENCES payment_destinations (id, merchant_id, provider_id),
    CONSTRAINT fk_collection_codes_branch FOREIGN KEY (branch_id, merchant_id) REFERENCES branches (id, merchant_id),
    CONSTRAINT ck_collection_codes_provider CHECK (provider_id IN ('EQUITY_MOCK', 'MTN_MOMO', 'AIRTEL_MONEY')),
    CONSTRAINT ck_collection_codes_status CHECK (status IN ('REQUESTED', 'REQUEST_DECLARED', 'ACTIVE', 'SUSPENDED', 'DEACTIVATED', 'REJECTED')),
    CONSTRAINT ck_collection_codes_internal_ref CHECK (internal_ref ~ '^CC-[2-9A-HJKMNP-Z]{8}$'),
    CONSTRAINT ck_collection_codes_label CHECK (length(btrim(display_label)) > 0),
    CONSTRAINT ck_collection_codes_external CHECK (external_code IS NULL
        OR (external_code = btrim(external_code) AND length(external_code) BETWEEN 1 AND 64 AND upper(external_code) <> internal_ref)),
    CONSTRAINT ck_collection_codes_request_sha256 CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_collection_codes_submission CHECK ((bank_request_ref IS NULL) = (bank_request_recorded_at IS NULL)
        AND (bank_request_ref IS NULL OR length(btrim(bank_request_ref)) > 0)),
    -- A code is REQUEST_DECLARED only because the owner recorded a request reference.
    CONSTRAINT ck_collection_codes_pending CHECK (status <> 'REQUEST_DECLARED' OR bank_request_ref IS NOT NULL),
    -- Approval evidence is all-or-nothing, and exists exactly when the bank-issued code exists.
    CONSTRAINT ck_collection_codes_approval_whole CHECK (
        (approval_source IS NULL) = (approval_evidence_ref IS NULL) AND (approval_source IS NULL) = (approved_at IS NULL)
        AND (approval_source IS NULL) = (external_code IS NULL)),
    CONSTRAINT ck_collection_codes_approval_source CHECK (approval_source IS NULL OR approval_source IN ('BANK_EVENT', 'OPERATOR')),
    CONSTRAINT ck_collection_codes_evidence CHECK (approval_evidence_ref IS NULL OR length(btrim(approval_evidence_ref)) > 0),
    -- A bank event needs no person; an operator approval needs TWO DIFFERENT people (maker and checker).
    CONSTRAINT ck_collection_codes_maker_checker CHECK (approval_source IS NULL OR approval_source = 'BANK_EVENT'
        OR (approval_recorded_by_user_id IS NOT NULL AND approval_checked_by_user_id IS NOT NULL
            AND approval_recorded_by_user_id <> approval_checked_by_user_id)),
    -- ACTIVE and SUSPENDED only exist for a code the bank approved.
    CONSTRAINT ck_collection_codes_active_needs_approval CHECK (status NOT IN ('ACTIVE', 'SUSPENDED') OR external_code IS NOT NULL),
    CONSTRAINT ck_collection_codes_reason CHECK (status NOT IN ('SUSPENDED', 'DEACTIVATED', 'REJECTED')
        OR (status_reason IS NOT NULL AND length(btrim(status_reason)) > 0)),
    CONSTRAINT ux_collection_codes_internal_ref UNIQUE (internal_ref),
    CONSTRAINT ux_collection_codes_id_merchant UNIQUE (id, merchant_id)
);
-- A bank-recognised code can belong to ONE code of ONE merchant in its provider's namespace, for ever: retired and deactivated codes
-- stay reserved (every status is covered), so a code can never be ambiguously re-attributed.
CREATE UNIQUE INDEX ux_collection_codes_external ON collection_codes (provider_id, upper(external_code)) WHERE external_code IS NOT NULL;
CREATE UNIQUE INDEX ux_collection_codes_client_request ON collection_codes (merchant_id, client_request_id);
CREATE INDEX ix_collection_codes_list ON collection_codes (merchant_id, created_at DESC, id DESC);
CREATE INDEX ix_collection_codes_destination ON collection_codes (settlement_destination_id);

-- Lifecycle and identity guard. Legal steps only:
--   REQUESTED -> REQUEST_DECLARED | REJECTED | DEACTIVATED        REQUEST_DECLARED -> ACTIVE | REJECTED | DEACTIVATED
--   ACTIVE -> SUSPENDED | DEACTIVATED                         SUSPENDED -> ACTIVE | DEACTIVATED
-- DEACTIVATED and REJECTED are final. The bank-issued code and its evidence are written once, together, and never change.
CREATE FUNCTION guard_collection_code_change() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'collection codes are never deleted';
    END IF;
    IF NEW.merchant_id IS DISTINCT FROM OLD.merchant_id OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
       OR NEW.settlement_destination_id IS DISTINCT FROM OLD.settlement_destination_id OR NEW.internal_ref IS DISTINCT FROM OLD.internal_ref
       OR NEW.is_simulated IS DISTINCT FROM OLD.is_simulated OR NEW.client_request_id IS DISTINCT FROM OLD.client_request_id
       OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256 OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'the identity of a collection code cannot change';
    END IF;
    IF OLD.bank_request_ref IS NOT NULL AND (NEW.bank_request_ref IS DISTINCT FROM OLD.bank_request_ref
       OR NEW.bank_request_recorded_at IS DISTINCT FROM OLD.bank_request_recorded_at) THEN
        RAISE EXCEPTION 'a recorded bank request reference cannot change';
    END IF;
    IF OLD.external_code IS NOT NULL AND (NEW.external_code IS DISTINCT FROM OLD.external_code
       OR NEW.approval_source IS DISTINCT FROM OLD.approval_source OR NEW.approval_evidence_ref IS DISTINCT FROM OLD.approval_evidence_ref
       OR NEW.approval_recorded_by_user_id IS DISTINCT FROM OLD.approval_recorded_by_user_id
       OR NEW.approval_checked_by_user_id IS DISTINCT FROM OLD.approval_checked_by_user_id OR NEW.approved_at IS DISTINCT FROM OLD.approved_at) THEN
        RAISE EXCEPTION 'the bank-issued code and its approval evidence cannot change';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
           (OLD.status = 'REQUESTED' AND NEW.status IN ('REQUEST_DECLARED', 'REJECTED', 'DEACTIVATED'))
        OR (OLD.status = 'REQUEST_DECLARED' AND NEW.status IN ('ACTIVE', 'REJECTED', 'DEACTIVATED'))
        OR (OLD.status = 'ACTIVE' AND NEW.status IN ('SUSPENDED', 'DEACTIVATED'))
        OR (OLD.status = 'SUSPENDED' AND NEW.status IN ('ACTIVE', 'DEACTIVATED'))) THEN
        RAISE EXCEPTION 'that collection code status change is not allowed';
    END IF;
    -- A code that can no longer be used cannot keep an agent: the assignment is ended first, in the same transaction.
    IF NEW.status IN ('DEACTIVATED', 'REJECTED') AND NEW.status IS DISTINCT FROM OLD.status AND EXISTS (
           SELECT 1 FROM collection_code_assignments a WHERE a.code_id = NEW.id AND a.valid_to IS NULL) THEN
        RAISE EXCEPTION 'end the assignment of a collection code before deactivating or rejecting it';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_collection_codes_guard BEFORE UPDATE OR DELETE ON collection_codes
    FOR EACH ROW EXECUTE FUNCTION guard_collection_code_change();

-- ---------------------------------------------------------------------------------------------
-- Assignments: dated, append-only history of who holds a code
-- ---------------------------------------------------------------------------------------------

CREATE TABLE collection_code_assignments (
    id                    uuid PRIMARY KEY,
    code_id               uuid         NOT NULL,
    merchant_id           uuid         NOT NULL,
    assignee_kind         varchar(16)  NOT NULL,
    membership_id         uuid,
    assignee_user_id      uuid REFERENCES users (id),
    collection_point_label varchar(60),
    -- SNAPSHOTS taken when the assignment was made. Staff or branch changes afterwards never rewrite them.
    assignee_name         varchar(120) NOT NULL,
    assignee_role         varchar(16),
    branch_id             uuid,
    branch_name           varchar(120),
    branch_code           varchar(12),
    valid_from            timestamptz  NOT NULL,
    valid_to              timestamptz,
    assigned_by_user_id   uuid         NOT NULL REFERENCES users (id),
    assigned_by_name      varchar(120) NOT NULL,
    ended_by_user_id      uuid REFERENCES users (id),
    ended_by_name         varchar(120),
    end_reason            varchar(200),
    created_at            timestamptz  NOT NULL,
    CONSTRAINT fk_collection_code_assignments_code FOREIGN KEY (code_id, merchant_id) REFERENCES collection_codes (id, merchant_id),
    CONSTRAINT fk_collection_code_assignments_membership FOREIGN KEY (membership_id, merchant_id) REFERENCES memberships (id, merchant_id),
    CONSTRAINT fk_collection_code_assignments_branch FOREIGN KEY (branch_id, merchant_id) REFERENCES branches (id, merchant_id),
    CONSTRAINT ck_collection_code_assignments_kind CHECK (
        (assignee_kind = 'MEMBER' AND membership_id IS NOT NULL AND assignee_user_id IS NOT NULL AND collection_point_label IS NULL
            AND assignee_role IS NOT NULL)
        OR (assignee_kind = 'COLLECTION_POINT' AND membership_id IS NULL AND assignee_user_id IS NULL
            AND collection_point_label IS NOT NULL AND length(btrim(collection_point_label)) > 0)),
    CONSTRAINT ck_collection_code_assignments_period CHECK (valid_to IS NULL OR valid_to >= valid_from),
    -- Ending records who ended it (a person, or a named process such as "Bank process" when no person acted) and why, with the end time.
    CONSTRAINT ck_collection_code_assignments_ended CHECK (
        (valid_to IS NULL) = (ended_by_name IS NULL) AND (valid_to IS NULL) = (end_reason IS NULL)
        AND (ended_by_user_id IS NULL OR valid_to IS NOT NULL) AND (end_reason IS NULL OR length(btrim(end_reason)) > 0)),
    CONSTRAINT ux_collection_code_assignments_id_merchant UNIQUE (id, merchant_id)
);
-- At most ONE open assignment per code: a code can never have two active agents.
CREATE UNIQUE INDEX ux_collection_code_assignments_open ON collection_code_assignments (code_id) WHERE valid_to IS NULL;
CREATE INDEX ix_collection_code_assignments_history ON collection_code_assignments (code_id, valid_from DESC, id DESC);
CREATE INDEX ix_collection_code_assignments_member ON collection_code_assignments (merchant_id, assignee_user_id) WHERE valid_to IS NULL;

CREATE FUNCTION guard_collection_code_assignment() RETURNS trigger AS $$
DECLARE
    code_status varchar(20);
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'collection code assignment history is never deleted';
    END IF;
    IF TG_OP = 'UPDATE' THEN
        -- The only edit ever allowed: ending an open assignment, once, adding the end facts and nothing else.
        IF OLD.valid_to IS NOT NULL
           OR NEW.id IS DISTINCT FROM OLD.id OR NEW.code_id IS DISTINCT FROM OLD.code_id OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id
           OR NEW.assignee_kind IS DISTINCT FROM OLD.assignee_kind OR NEW.membership_id IS DISTINCT FROM OLD.membership_id
           OR NEW.assignee_user_id IS DISTINCT FROM OLD.assignee_user_id
           OR NEW.collection_point_label IS DISTINCT FROM OLD.collection_point_label OR NEW.assignee_name IS DISTINCT FROM OLD.assignee_name
           OR NEW.assignee_role IS DISTINCT FROM OLD.assignee_role OR NEW.branch_id IS DISTINCT FROM OLD.branch_id
           OR NEW.branch_name IS DISTINCT FROM OLD.branch_name OR NEW.branch_code IS DISTINCT FROM OLD.branch_code
           OR NEW.valid_from IS DISTINCT FROM OLD.valid_from OR NEW.assigned_by_user_id IS DISTINCT FROM OLD.assigned_by_user_id
           OR NEW.assigned_by_name IS DISTINCT FROM OLD.assigned_by_name OR NEW.created_at IS DISTINCT FROM OLD.created_at
           OR NEW.valid_to IS NULL THEN
            RAISE EXCEPTION 'an assignment can only be ended, once; its history is never rewritten';
        END IF;
        RETURN NEW;
    END IF;
    -- INSERT
    SELECT status INTO code_status FROM collection_codes WHERE id = NEW.code_id;
    IF code_status NOT IN ('REQUESTED', 'REQUEST_DECLARED', 'ACTIVE') THEN
        RAISE EXCEPTION 'a collection code in status % cannot be assigned', code_status;
    END IF;
    IF NEW.assignee_kind = 'MEMBER' AND NOT EXISTS (SELECT 1 FROM memberships m
            WHERE m.id = NEW.membership_id AND m.merchant_id = NEW.merchant_id AND m.user_id = NEW.assignee_user_id AND m.status = 'ACTIVE') THEN
        RAISE EXCEPTION 'only an ACTIVE member can be assigned a collection code';
    END IF;
    -- Where: a code with a branch is only ever assigned at that branch, the branch must be active, and a member must be actively assigned to it
    -- (the same rule as for invoice assignees). The service checks the same things; this keeps them true whatever code runs.
    IF EXISTS (SELECT 1 FROM collection_codes c WHERE c.id = NEW.code_id AND c.branch_id IS NOT NULL AND NEW.branch_id IS DISTINCT FROM c.branch_id) THEN
        RAISE EXCEPTION 'a collection code of a branch can only be assigned at that branch';
    END IF;
    IF NEW.branch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM branches b WHERE b.id = NEW.branch_id AND b.merchant_id = NEW.merchant_id AND b.status = 'ACTIVE') THEN
        RAISE EXCEPTION 'a collection code can only be assigned at an active branch';
    END IF;
    IF NEW.assignee_kind = 'MEMBER' AND NEW.branch_id IS NOT NULL AND NOT EXISTS (SELECT 1 FROM branch_assignments ba
            WHERE ba.membership_id = NEW.membership_id AND ba.branch_id = NEW.branch_id AND ba.status = 'ACTIVE') THEN
        RAISE EXCEPTION 'the member is not assigned to that branch';
    END IF;
    -- Periods of one code never overlap: a new one starts when (or after) the previous one ended.
    IF EXISTS (SELECT 1 FROM collection_code_assignments a WHERE a.code_id = NEW.code_id AND (a.valid_to IS NULL OR a.valid_to > NEW.valid_from)) THEN
        RAISE EXCEPTION 'this collection code already has an assignment for that period';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_collection_code_assignments_guard BEFORE INSERT OR UPDATE OR DELETE ON collection_code_assignments
    FOR EACH ROW EXECUTE FUNCTION guard_collection_code_assignment();
