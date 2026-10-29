-- R6b: Equity merchant KYC onboarding, collected by OuPay. SEPARATE from ordinary merchant registration (which is unchanged).
--
-- What this records, and what it never claims:
--   * An application is what the merchant OWNER told OuPay. COLLECTED means "submitted to OuPay for review", NOT "received by Equity".
--   * HANDED_OFF, MORE_INFO_REQUESTED, APPROVED and REJECTED can only exist with recorded evidence (a verified bank event, or an operator
--     citing written evidence with a second person checking). No merchant action reaches them, and the database refuses them without it.
--   * No document content is stored anywhere: there is no secure object storage yet. Document rows track what is required and what the
--     owner says they have ready; STORED needs a content hash, size and private object key and cannot be reached today.
--   * Sensitive values (identity number, bank account reference) are stored ONLY as AES-GCM ciphertext; the schema refuses plaintext for them.
--
-- ADDITIVE: new tables, functions and triggers only. No existing table, column, row or constraint changes, so the previous application
-- version keeps working and rolling back needs no schema change. The requirement set seeded below is PROVISIONAL: it is OuPay's minimal
-- starting set, not a list confirmed by Equity (see docs/equity-technical-questions.md, section 5). Equity can change it by publishing
-- a new VERSION (a new row); published versions are immutable, so every application keeps the exact set it was started under.
--
-- Conventions (V1, V9, V11): merchant_id on every table, references stay inside one business through composite foreign keys.

-- ---------------------------------------------------------------------------------------------
-- Requirement sets: configurable, versioned, immutable once published
-- ---------------------------------------------------------------------------------------------

CREATE TABLE kyc_requirement_sets (
    id                uuid PRIMARY KEY,
    provider_id       varchar(24)  NOT NULL,
    version           integer      NOT NULL,
    effective_from    timestamptz  NOT NULL,
    -- true while the content has not been confirmed by the bank.
    provisional       boolean      NOT NULL,
    definition        jsonb        NOT NULL,
    definition_sha256 varchar(64)  NOT NULL,
    created_at        timestamptz  NOT NULL,
    CONSTRAINT ux_kyc_requirement_sets_version UNIQUE (provider_id, version),
    CONSTRAINT ux_kyc_requirement_sets_key UNIQUE (id, provider_id),
    CONSTRAINT ck_kyc_requirement_sets_provider CHECK (provider_id IN ('EQUITY')),
    CONSTRAINT ck_kyc_requirement_sets_version CHECK (version >= 1),
    CONSTRAINT ck_kyc_requirement_sets_definition CHECK (jsonb_typeof(definition) = 'object'),
    CONSTRAINT ck_kyc_requirement_sets_sha256 CHECK (definition_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE FUNCTION kyc_immutable() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION '% rows are never changed or deleted', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_kyc_requirement_sets_immutable BEFORE UPDATE OR DELETE ON kyc_requirement_sets
    FOR EACH ROW EXECUTE FUNCTION kyc_immutable();

-- Version 1: a deliberately minimal, PROVISIONAL set. Nothing here is an Equity-confirmed requirement.
INSERT INTO kyc_requirement_sets (id, provider_id, version, effective_from, provisional, definition, definition_sha256, created_at)
SELECT '5a1c0d7e-3b2f-4c11-9a64-0e6d2f8b7a01'::uuid, 'EQUITY', 1, TIMESTAMPTZ '2026-01-01 00:00:00+00', true, d, encode(sha256(convert_to(d::text, 'UTF8')), 'hex'), now()
FROM (SELECT $json$
{
  "note": "This is OuPay's minimal starting list. Equity has not confirmed it. Equity may ask for more, or different, information or documents.",
  "sections": [
    {"key": "BUSINESS", "label": "Business information"},
    {"key": "REPRESENTATIVE", "label": "Representative information"},
    {"key": "BANK", "label": "Equity account information"}
  ],
  "fields": [
    {"key": "business.legalName", "section": "BUSINESS", "label": "Legal business name", "type": "TEXT", "required": true, "maxLength": 200},
    {"key": "business.type", "section": "BUSINESS", "label": "Business type", "type": "CHOICE", "required": true,
     "options": [{"value": "registered_company", "label": "Registered company"}, {"value": "cooperative", "label": "Cooperative"},
                 {"value": "non_profit", "label": "Non-profit organisation"}, {"value": "sole_proprietor", "label": "Sole proprietor"},
                 {"value": "informal_vendor", "label": "Informal vendor"}]},
    {"key": "business.registrationNumber", "section": "BUSINESS", "label": "Registration number", "type": "TEXT", "required": true, "maxLength": 60,
     "appliesWhen": {"key": "business.type", "in": ["registered_company", "cooperative", "non_profit"]},
     "help": "Not needed for sole proprietors and informal vendors."},
    {"key": "business.tin", "section": "BUSINESS", "label": "Tax identification number (TIN)", "type": "TEXT", "required": false, "pattern": "^[0-9]{9}$",
     "patternHint": "A TIN has 9 digits.", "help": "Only when the business has one."},
    {"key": "business.physicalAddress", "section": "BUSINESS", "label": "Physical address", "type": "TEXT", "required": true, "maxLength": 300},
    {"key": "business.contactPhone", "section": "BUSINESS", "label": "Contact phone", "type": "PHONE", "required": true},
    {"key": "business.contactEmail", "section": "BUSINESS", "label": "Contact email", "type": "EMAIL", "required": true},
    {"key": "representative.fullName", "section": "REPRESENTATIVE", "label": "Representative full name", "type": "TEXT", "required": true, "maxLength": 120},
    {"key": "representative.role", "section": "REPRESENTATIVE", "label": "Role in the business", "type": "CHOICE", "required": true,
     "options": [{"value": "OWNER", "label": "Owner"}, {"value": "DIRECTOR", "label": "Director"}, {"value": "MANAGER", "label": "Manager"},
                 {"value": "AUTHORISED_SIGNATORY", "label": "Authorised signatory"}]},
    {"key": "representative.idDocumentType", "section": "REPRESENTATIVE", "label": "Identity document type", "type": "CHOICE", "required": true,
     "options": [{"value": "NATIONAL_ID", "label": "National ID"}, {"value": "PASSPORT", "label": "Passport"}, {"value": "OTHER", "label": "Other"}]},
    {"key": "representative.nationality", "section": "REPRESENTATIVE", "label": "Nationality", "type": "TEXT", "required": false, "maxLength": 60,
     "help": "Only if Equity asks for it."},
    {"key": "representative.idNumber", "section": "REPRESENTATIVE", "label": "Identity document number", "type": "TEXT", "required": false,
     "sensitive": true, "maxLength": 40, "pattern": "^[A-Za-z0-9 -]{4,40}$", "patternHint": "Letters, digits, spaces and hyphens only.",
     "help": "Optional for now. Equity has not said it needs this from OuPay. It is stored encrypted and only the owner can see it."},
    {"key": "bank.hasEquityAccount", "section": "BANK", "label": "Does the business already have an Equity business account?", "type": "CHOICE", "required": true,
     "options": [{"value": "YES", "label": "Yes"}, {"value": "NO", "label": "No"}, {"value": "NOT_SURE", "label": "Not sure"}]},
    {"key": "bank.accountReference", "section": "BANK", "label": "Equity account number", "type": "TEXT", "required": false, "sensitive": true, "maxLength": 40,
     "pattern": "^[0-9 -]{6,40}$", "patternHint": "Digits, spaces and hyphens only.",
     "appliesWhen": {"key": "bank.hasEquityAccount", "in": ["YES"]},
     "help": "Optional. Never enter an online banking password, PIN or one-time code. OuPay will never ask for them."}
  ],
  "documents": [
    {"key": "doc.registrationCertificate", "label": "Business registration certificate", "required": true, "appliesWhen": {"key": "business.type", "in": ["registered_company", "cooperative", "non_profit"]}},
    {"key": "doc.tinCertificate", "label": "TIN certificate", "required": false},
    {"key": "doc.representativeId", "label": "Representative identity document", "required": true}
  ],
  "consent": {
    "textVersion": "v1",
    "text": "I confirm that I am authorised to act for this business and that the information I have given is accurate. I agree that OuPay may keep this information and prepare it for Equity Bank, for account opening and merchant collection services. I understand that submitting this application to OuPay does not mean that Equity has received, reviewed or approved it."
  }
}
$json$::jsonb AS d) s;

-- ---------------------------------------------------------------------------------------------
-- Applications
-- ---------------------------------------------------------------------------------------------

CREATE TABLE kyc_applications (
    id                          uuid PRIMARY KEY,
    merchant_id                 uuid         NOT NULL REFERENCES merchants (id),
    provider_id                 varchar(24)  NOT NULL,
    -- The requirement set this application was started under, and its version (kept even if newer versions are published).
    requirement_set_id          uuid         NOT NULL,
    requirement_set_version     integer      NOT NULL,
    status                      varchar(20)  NOT NULL,
    -- Durable identity of the request that started it, with its server-computed fingerprint: a repeat is the same request.
    client_operation_id         uuid         NOT NULL,
    request_sha256              varchar(64)  NOT NULL,
    created_by_user_id          uuid         NOT NULL REFERENCES users (id),
    created_at                  timestamptz  NOT NULL,
    updated_at                  timestamptz  NOT NULL,
    version                     bigint       NOT NULL DEFAULT 0,
    -- SUBMISSION TO OUPAY. Set once; nothing here says Equity has seen anything.
    submission_request_id       uuid,
    submitted_at                timestamptz,
    submitted_by_user_id        uuid REFERENCES users (id),
    submitted_by_name           varchar(120),
    answers_sha256              varchar(64),
    -- What was submitted, frozen: the answers (sensitive ones only as "provided"), where each came from, and the set version.
    submission_snapshot         jsonb,
    retention_until             timestamptz,
    -- EVIDENCE OF A REAL HAND-OFF to the bank (never set by a merchant).
    handoff_source              varchar(12),
    handoff_evidence_ref        varchar(200),
    handoff_recorded_by_user_id uuid REFERENCES users (id),
    handoff_checked_by_user_id  uuid REFERENCES users (id),
    handed_off_at               timestamptz,
    -- EVIDENCE OF THE BANK'S DECISION (never set by a merchant).
    decision_source             varchar(12),
    decision_evidence_ref       varchar(200),
    decision_recorded_by_user_id uuid REFERENCES users (id),
    decision_checked_by_user_id uuid REFERENCES users (id),
    decided_at                  timestamptz,
    decision_reason             varchar(300),
    CONSTRAINT ux_kyc_applications_id_merchant UNIQUE (id, merchant_id),
    CONSTRAINT ux_kyc_applications_client_operation UNIQUE (merchant_id, client_operation_id),
    CONSTRAINT fk_kyc_applications_set FOREIGN KEY (requirement_set_id, provider_id) REFERENCES kyc_requirement_sets (id, provider_id),
    CONSTRAINT ck_kyc_applications_provider CHECK (provider_id IN ('EQUITY')),
    CONSTRAINT ck_kyc_applications_status CHECK (status IN ('DRAFT', 'COLLECTED', 'HANDED_OFF', 'MORE_INFO_REQUESTED', 'APPROVED', 'REJECTED')),
    CONSTRAINT ck_kyc_applications_request_sha256 CHECK (request_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_kyc_applications_answers_sha256 CHECK (answers_sha256 IS NULL OR answers_sha256 ~ '^[0-9a-f]{64}$'),
    -- Submitted to OuPay: exactly when it is no longer a draft, with who and what.
    CONSTRAINT ck_kyc_applications_submission CHECK (
        (status = 'DRAFT' AND submission_request_id IS NULL AND submitted_at IS NULL AND submitted_by_user_id IS NULL AND submitted_by_name IS NULL
            AND answers_sha256 IS NULL AND submission_snapshot IS NULL)
        OR (status <> 'DRAFT' AND submission_request_id IS NOT NULL AND submitted_at IS NOT NULL AND submitted_by_user_id IS NOT NULL
            AND submitted_by_name IS NOT NULL AND answers_sha256 IS NOT NULL AND submission_snapshot IS NOT NULL)),
    -- Evidence is all-or-nothing. An operator is two different people; a bank event is no person. (Written so that no branch can evaluate
    -- to NULL: a CHECK that is NULL PASSES, which would let a bank state through with a missing source.)
    CONSTRAINT ck_kyc_applications_handoff CHECK (
        (handoff_source IS NULL AND handoff_evidence_ref IS NULL AND handed_off_at IS NULL AND handoff_recorded_by_user_id IS NULL AND handoff_checked_by_user_id IS NULL)
        OR (handoff_source IS NOT NULL AND handoff_evidence_ref IS NOT NULL AND length(btrim(handoff_evidence_ref)) > 0 AND handed_off_at IS NOT NULL
            AND ((handoff_source = 'BANK_EVENT' AND handoff_recorded_by_user_id IS NULL AND handoff_checked_by_user_id IS NULL)
              OR (handoff_source = 'OPERATOR' AND handoff_recorded_by_user_id IS NOT NULL AND handoff_checked_by_user_id IS NOT NULL AND handoff_recorded_by_user_id <> handoff_checked_by_user_id)))),
    -- Evidence is all-or-nothing. An operator is two different people; a bank event is no person. (Written so that no branch can evaluate
    -- to NULL: a CHECK that is NULL PASSES, which would let a bank state through with a missing source.)
    CONSTRAINT ck_kyc_applications_decision CHECK (
        (decision_source IS NULL AND decision_evidence_ref IS NULL AND decided_at IS NULL AND decision_recorded_by_user_id IS NULL AND decision_checked_by_user_id IS NULL AND decision_reason IS NULL)
        OR (decision_source IS NOT NULL AND decision_evidence_ref IS NOT NULL AND length(btrim(decision_evidence_ref)) > 0 AND decided_at IS NOT NULL
            AND ((decision_source = 'BANK_EVENT' AND decision_recorded_by_user_id IS NULL AND decision_checked_by_user_id IS NULL)
              OR (decision_source = 'OPERATOR' AND decision_recorded_by_user_id IS NOT NULL AND decision_checked_by_user_id IS NOT NULL AND decision_recorded_by_user_id <> decision_checked_by_user_id)))),
    -- The states that say the bank did something exist only with evidence that it did.
    CONSTRAINT ck_kyc_applications_bank_states CHECK (
        (status NOT IN ('HANDED_OFF', 'MORE_INFO_REQUESTED', 'APPROVED', 'REJECTED') OR handed_off_at IS NOT NULL)
        AND ((status IN ('APPROVED', 'REJECTED')) = (decided_at IS NOT NULL))
        AND (status <> 'REJECTED' OR length(btrim(coalesce(decision_reason, ''))) > 0))
);
-- One live application per business and provider; a REJECTED one stays as history and no longer blocks a new start.
CREATE UNIQUE INDEX ux_kyc_applications_live ON kyc_applications (merchant_id, provider_id) WHERE status <> 'REJECTED';
CREATE UNIQUE INDEX ux_kyc_applications_submission ON kyc_applications (merchant_id, submission_request_id) WHERE submission_request_id IS NOT NULL;
CREATE INDEX ix_kyc_applications_merchant ON kyc_applications (merchant_id, created_at DESC);

CREATE FUNCTION guard_kyc_application() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a KYC application is never deleted; it stays as history';
    END IF;
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.merchant_id IS DISTINCT FROM OLD.merchant_id OR NEW.provider_id IS DISTINCT FROM OLD.provider_id
       OR NEW.requirement_set_id IS DISTINCT FROM OLD.requirement_set_id OR NEW.requirement_set_version IS DISTINCT FROM OLD.requirement_set_version
       OR NEW.client_operation_id IS DISTINCT FROM OLD.client_operation_id OR NEW.request_sha256 IS DISTINCT FROM OLD.request_sha256
       OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'the identity of a KYC application never changes';
    END IF;
    IF OLD.status IN ('APPROVED', 'REJECTED') THEN
        RAISE EXCEPTION 'a decided KYC application is final';
    END IF;
    -- What was submitted is frozen once it has been submitted.
    IF OLD.status <> 'DRAFT' AND (NEW.submission_request_id IS DISTINCT FROM OLD.submission_request_id OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
       OR NEW.submitted_by_user_id IS DISTINCT FROM OLD.submitted_by_user_id OR NEW.answers_sha256 IS DISTINCT FROM OLD.answers_sha256
       OR NEW.submission_snapshot IS DISTINCT FROM OLD.submission_snapshot) THEN
        RAISE EXCEPTION 'a submitted KYC application is a frozen snapshot';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT ((OLD.status = 'DRAFT' AND NEW.status = 'COLLECTED')
             OR (OLD.status = 'COLLECTED' AND NEW.status = 'HANDED_OFF')
             OR (OLD.status = 'HANDED_OFF' AND NEW.status IN ('MORE_INFO_REQUESTED', 'APPROVED', 'REJECTED'))
             OR (OLD.status = 'MORE_INFO_REQUESTED' AND NEW.status IN ('COLLECTED', 'APPROVED', 'REJECTED'))) THEN
            RAISE EXCEPTION 'a KYC application cannot move from % to %', OLD.status, NEW.status;
        END IF;
        -- The bank asking for more means there is a recorded, evidenced request to answer.
        IF NEW.status = 'MORE_INFO_REQUESTED' AND NOT EXISTS (SELECT 1 FROM kyc_information_requests r WHERE r.application_id = NEW.id AND r.status = 'OPEN') THEN
            RAISE EXCEPTION 'more information can only be requested with a recorded information request';
        END IF;
        -- Every hand-off needs its OWN evidence, even a second one after the bank asked for more.
        IF NEW.status = 'HANDED_OFF' AND NEW.handed_off_at IS NOT DISTINCT FROM OLD.handed_off_at THEN
            RAISE EXCEPTION 'a hand-off needs new evidence';
        END IF;
    ELSE
        -- Without a status change no evidence is added, changed or removed.
        IF NEW.handoff_evidence_ref IS DISTINCT FROM OLD.handoff_evidence_ref OR NEW.handed_off_at IS DISTINCT FROM OLD.handed_off_at
           OR NEW.decision_evidence_ref IS DISTINCT FROM OLD.decision_evidence_ref OR NEW.decided_at IS DISTINCT FROM OLD.decided_at THEN
            RAISE EXCEPTION 'evidence is recorded only together with the step it proves';
        END IF;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_kyc_applications_guard BEFORE UPDATE OR DELETE ON kyc_applications
    FOR EACH ROW EXECUTE FUNCTION guard_kyc_application();

-- ---------------------------------------------------------------------------------------------
-- Answers: editable only while the application is a draft
-- ---------------------------------------------------------------------------------------------

CREATE TABLE kyc_answers (
    application_id uuid         NOT NULL,
    merchant_id    uuid         NOT NULL,
    field_key      varchar(80)  NOT NULL,
    sensitive      boolean      NOT NULL,
    -- Plain value: ONLY for fields that are not sensitive.
    value_text     varchar(500),
    -- Sensitive value: AES-GCM ciphertext only (iv || ciphertext || tag). The key is outside the database; key_id names which one.
    ciphertext     bytea,
    key_id         varchar(24),
    -- A masked hint (for example the last characters) so the owner can recognise a value without revealing it.
    value_hint     varchar(20),
    -- Where the value came from: copied from the business registration, or typed by the owner.
    source         varchar(8)   NOT NULL,
    updated_at     timestamptz  NOT NULL,
    PRIMARY KEY (application_id, field_key),
    CONSTRAINT fk_kyc_answers_application FOREIGN KEY (application_id, merchant_id) REFERENCES kyc_applications (id, merchant_id),
    CONSTRAINT ck_kyc_answers_source CHECK (source IN ('PREFILL', 'OWNER')),
    CONSTRAINT ck_kyc_answers_storage CHECK (
        (sensitive AND value_text IS NULL AND ciphertext IS NOT NULL AND octet_length(ciphertext) > 28 AND key_id IS NOT NULL)
        OR (NOT sensitive AND ciphertext IS NULL AND key_id IS NULL AND value_hint IS NULL AND value_text IS NOT NULL AND length(btrim(value_text)) > 0))
);

CREATE FUNCTION guard_kyc_answer() RETURNS trigger AS $$
DECLARE
    app_status varchar(20);
    app_id uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.application_id ELSE NEW.application_id END;
BEGIN
    SELECT status INTO app_status FROM kyc_applications WHERE id = app_id;
    IF app_status IS DISTINCT FROM 'DRAFT' THEN
        RAISE EXCEPTION 'the answers of a submitted KYC application never change';
    END IF;
    IF TG_OP = 'UPDATE' AND (NEW.application_id IS DISTINCT FROM OLD.application_id OR NEW.field_key IS DISTINCT FROM OLD.field_key) THEN
        RAISE EXCEPTION 'an answer keeps its application and field';
    END IF;
    RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_kyc_answers_guard BEFORE INSERT OR UPDATE OR DELETE ON kyc_answers
    FOR EACH ROW EXECUTE FUNCTION guard_kyc_answer();

-- ---------------------------------------------------------------------------------------------
-- Consents: append-only evidence of an affirmative act by an identified representative
-- ---------------------------------------------------------------------------------------------

CREATE TABLE kyc_consents (
    id                       uuid PRIMARY KEY,
    application_id           uuid         NOT NULL,
    merchant_id              uuid         NOT NULL,
    user_id                  uuid         NOT NULL REFERENCES users (id),
    -- The consenting person as they were when they consented.
    consenting_name          varchar(120) NOT NULL,
    requirement_set_version  integer      NOT NULL,
    consent_text_version     varchar(20)  NOT NULL,
    consent_text_sha256      varchar(64)  NOT NULL,
    -- The exact answers this consent covers: any later change to them makes it out of date.
    answers_sha256           varchar(64)  NOT NULL,
    affirmed                 boolean      NOT NULL,
    affirmation_method       varchar(24)  NOT NULL,
    given_at                 timestamptz  NOT NULL,
    CONSTRAINT fk_kyc_consents_application FOREIGN KEY (application_id, merchant_id) REFERENCES kyc_applications (id, merchant_id),
    CONSTRAINT ck_kyc_consents_affirmed CHECK (affirmed),
    CONSTRAINT ck_kyc_consents_method CHECK (affirmation_method IN ('EXPLICIT_AFFIRMATION')),
    CONSTRAINT ck_kyc_consents_hashes CHECK (consent_text_sha256 ~ '^[0-9a-f]{64}$' AND answers_sha256 ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ux_kyc_consents_once UNIQUE (application_id, consent_text_version, answers_sha256)
);
CREATE INDEX ix_kyc_consents_application ON kyc_consents (application_id, given_at DESC);
CREATE TRIGGER trg_kyc_consents_immutable BEFORE UPDATE OR DELETE ON kyc_consents FOR EACH ROW EXECUTE FUNCTION kyc_immutable();

-- ---------------------------------------------------------------------------------------------
-- Documents: tracking and metadata ONLY. No content is stored.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE kyc_documents (
    application_id    uuid         NOT NULL,
    merchant_id       uuid         NOT NULL,
    requirement_key   varchar(80)  NOT NULL,
    -- NOT_PROVIDED: nothing. DECLARED_READY: the owner SAYS they have it (no file received). STORED: a file really is held privately.
    state             varchar(16)  NOT NULL,
    declared_ready_at timestamptz,
    -- Only for STORED (future): a private object key (never a URL), the content hash, size and type.
    object_key        varchar(200),
    content_sha256    varchar(64),
    size_bytes        bigint,
    media_type        varchar(60),
    stored_at         timestamptz,
    updated_at        timestamptz  NOT NULL,
    PRIMARY KEY (application_id, requirement_key),
    CONSTRAINT fk_kyc_documents_application FOREIGN KEY (application_id, merchant_id) REFERENCES kyc_applications (id, merchant_id),
    CONSTRAINT ck_kyc_documents_state CHECK (state IN ('NOT_PROVIDED', 'DECLARED_READY', 'STORED')),
    CONSTRAINT ck_kyc_documents_declared CHECK ((state = 'DECLARED_READY') = (declared_ready_at IS NOT NULL) OR state = 'STORED'),
    -- A file is "stored" only with its private key, hash, size and type; any other state holds none of them.
    CONSTRAINT ck_kyc_documents_stored CHECK (
        (state = 'STORED' AND object_key IS NOT NULL AND content_sha256 IS NOT NULL AND content_sha256 ~ '^[0-9a-f]{64}$' AND size_bytes IS NOT NULL
            AND size_bytes > 0 AND media_type IS NOT NULL AND stored_at IS NOT NULL AND object_key !~* '^[a-z]+://')
        OR (state <> 'STORED' AND object_key IS NULL AND content_sha256 IS NULL AND size_bytes IS NULL AND media_type IS NULL AND stored_at IS NULL))
);

CREATE FUNCTION guard_kyc_document() RETURNS trigger AS $$
DECLARE
    app_status varchar(20);
BEGIN
    SELECT status INTO app_status FROM kyc_applications WHERE id = NEW.application_id;
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'document tracking rows are never deleted';
    END IF;
    IF app_status NOT IN ('DRAFT', 'MORE_INFO_REQUESTED') THEN
        RAISE EXCEPTION 'documents can only be tracked while the application is a draft or more information was requested';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_kyc_documents_guard BEFORE INSERT OR UPDATE OR DELETE ON kyc_documents
    FOR EACH ROW EXECUTE FUNCTION guard_kyc_document();

-- ---------------------------------------------------------------------------------------------
-- Information requests from the bank (recorded only with evidence), answered by the owner
-- ---------------------------------------------------------------------------------------------

CREATE TABLE kyc_information_requests (
    id                      uuid PRIMARY KEY,
    application_id          uuid         NOT NULL,
    merchant_id             uuid         NOT NULL,
    source                  varchar(12)  NOT NULL,
    evidence_ref            varchar(200) NOT NULL,
    recorded_by_user_id     uuid REFERENCES users (id),
    checked_by_user_id      uuid REFERENCES users (id),
    message                 varchar(1000) NOT NULL,
    field_key               varchar(80),
    requested_at            timestamptz  NOT NULL,
    status                  varchar(10)  NOT NULL,
    response_text           varchar(2000),
    responded_by_user_id    uuid REFERENCES users (id),
    responded_at            timestamptz,
    CONSTRAINT fk_kyc_information_requests_application FOREIGN KEY (application_id, merchant_id) REFERENCES kyc_applications (id, merchant_id),
    CONSTRAINT ck_kyc_information_requests_status CHECK (status IN ('OPEN', 'RESPONDED')),
    CONSTRAINT ck_kyc_information_requests_evidence CHECK (length(btrim(evidence_ref)) > 0 AND length(btrim(message)) > 0
        AND ((source = 'BANK_EVENT' AND recorded_by_user_id IS NULL AND checked_by_user_id IS NULL)
          OR (source = 'OPERATOR' AND recorded_by_user_id IS NOT NULL AND checked_by_user_id IS NOT NULL AND recorded_by_user_id <> checked_by_user_id))),
    CONSTRAINT ck_kyc_information_requests_response CHECK (
        (status = 'OPEN' AND response_text IS NULL AND responded_by_user_id IS NULL AND responded_at IS NULL)
        OR (status = 'RESPONDED' AND length(btrim(response_text)) > 0 AND responded_by_user_id IS NOT NULL AND responded_at IS NOT NULL)),
    CONSTRAINT ux_kyc_information_requests_id_merchant UNIQUE (id, merchant_id)
);
CREATE INDEX ix_kyc_information_requests_application ON kyc_information_requests (application_id, requested_at DESC);

CREATE FUNCTION guard_kyc_information_request() RETURNS trigger AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'information requests are never deleted';
    END IF;
    IF OLD.status <> 'OPEN' OR NEW.status <> 'RESPONDED' OR NEW.id IS DISTINCT FROM OLD.id OR NEW.application_id IS DISTINCT FROM OLD.application_id
       OR NEW.source IS DISTINCT FROM OLD.source OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref OR NEW.message IS DISTINCT FROM OLD.message
       OR NEW.field_key IS DISTINCT FROM OLD.field_key OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
       OR NEW.recorded_by_user_id IS DISTINCT FROM OLD.recorded_by_user_id OR NEW.checked_by_user_id IS DISTINCT FROM OLD.checked_by_user_id THEN
        RAISE EXCEPTION 'an information request can only be answered, once';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_kyc_information_requests_guard BEFORE UPDATE OR DELETE ON kyc_information_requests
    FOR EACH ROW EXECUTE FUNCTION guard_kyc_information_request();

-- ---------------------------------------------------------------------------------------------
-- Events: an append-only history. It holds NO personal data: kinds, statuses and field KEYS only.
-- ---------------------------------------------------------------------------------------------

CREATE TABLE kyc_events (
    id              bigserial PRIMARY KEY,
    application_id  uuid         NOT NULL,
    merchant_id     uuid         NOT NULL,
    kind            varchar(40)  NOT NULL,
    actor_user_id   uuid REFERENCES users (id),
    from_status     varchar(20),
    to_status       varchar(20),
    -- A field key, a document key or an evidence reference: never a value.
    detail          varchar(200),
    created_at      timestamptz  NOT NULL,
    CONSTRAINT fk_kyc_events_application FOREIGN KEY (application_id, merchant_id) REFERENCES kyc_applications (id, merchant_id)
);
CREATE INDEX ix_kyc_events_application ON kyc_events (application_id, id);
CREATE TRIGGER trg_kyc_events_immutable BEFORE UPDATE OR DELETE ON kyc_events FOR EACH ROW EXECUTE FUNCTION kyc_immutable();
