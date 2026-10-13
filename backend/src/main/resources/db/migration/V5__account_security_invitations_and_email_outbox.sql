-- Milestone 10: account recovery, staff invitations, transactional email outbox, pagination indexes.
-- Secrets (reset/verification/invitation tokens) are never stored: only their SHA-256 hash is.

ALTER TABLE users ADD COLUMN email_verified_at timestamptz;

-- Single-use, expiring tokens for password reset and e-mail verification.
CREATE TABLE account_tokens (
    id           uuid PRIMARY KEY,
    user_id      uuid         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    purpose      varchar(24)  NOT NULL,
    token_hash   bytea        NOT NULL,
    -- The address the token was mailed to. A verification only ever verifies THIS address.
    email        varchar(254) NOT NULL,
    requested_ip varchar(64),
    created_at   timestamptz  NOT NULL,
    expires_at   timestamptz  NOT NULL,
    used_at      timestamptz,
    CONSTRAINT ck_account_tokens_purpose CHECK (purpose IN ('PASSWORD_RESET', 'EMAIL_VERIFICATION')),
    CONSTRAINT ux_account_tokens_hash UNIQUE (token_hash)
);
CREATE INDEX ix_account_tokens_user ON account_tokens (user_id, purpose, created_at DESC);

-- Staff invitations. The INVITED membership already exists (for a brand-new person, owned by a PENDING
-- user that cannot sign in); accepting activates it. The token is only ever e-mailed.
CREATE TABLE staff_invitations (
    id                 uuid PRIMARY KEY,
    merchant_id        uuid         NOT NULL REFERENCES merchants (id),
    membership_id      uuid         NOT NULL,
    email              varchar(254) NOT NULL,
    role               varchar(16)  NOT NULL,
    note               varchar(300),
    invited_by_user_id uuid         NOT NULL REFERENCES users (id),
    token_hash         bytea        NOT NULL,
    status             varchar(10)  NOT NULL,
    expires_at         timestamptz  NOT NULL,
    created_at         timestamptz  NOT NULL,
    updated_at         timestamptz  NOT NULL,
    responded_at       timestamptz,
    CONSTRAINT ck_staff_invitations_role CHECK (role IN ('MANAGER', 'CASHIER')),
    CONSTRAINT ck_staff_invitations_status CHECK (status IN ('PENDING', 'ACCEPTED', 'REVOKED', 'EXPIRED')),
    CONSTRAINT ux_staff_invitations_token UNIQUE (token_hash),
    CONSTRAINT ux_staff_invitations_id_merchant UNIQUE (id, merchant_id),
    CONSTRAINT fk_staff_invitations_membership FOREIGN KEY (membership_id, merchant_id)
        REFERENCES memberships (id, merchant_id)
);
-- At most one live invitation per membership, enforced by the database.
CREATE UNIQUE INDEX ux_staff_invitations_pending ON staff_invitations (membership_id) WHERE status = 'PENDING';
CREATE INDEX ix_staff_invitations_merchant ON staff_invitations (merchant_id, created_at DESC);

-- Branches an invitation will assign on acceptance (same-merchant branches only, by composite key).
CREATE TABLE staff_invitation_branches (
    invitation_id uuid NOT NULL,
    merchant_id   uuid NOT NULL,
    branch_id     uuid NOT NULL,
    PRIMARY KEY (invitation_id, branch_id),
    CONSTRAINT fk_invitation_branches_invitation FOREIGN KEY (invitation_id, merchant_id)
        REFERENCES staff_invitations (id, merchant_id) ON DELETE CASCADE,
    CONSTRAINT fk_invitation_branches_branch FOREIGN KEY (branch_id, merchant_id)
        REFERENCES branches (id, merchant_id)
);

-- Transactional e-mail outbox: a message is written in the SAME transaction as the business change that
-- caused it, and delivered afterwards by a dispatcher with retries. A message body that contains a link
-- token is erased as soon as it has been delivered (or given up on).
CREATE TABLE email_outbox (
    id                uuid PRIMARY KEY,
    kind              varchar(40)  NOT NULL,
    recipient         varchar(254) NOT NULL,
    recipient_user_id uuid,
    subject           varchar(200) NOT NULL,
    body_text         text,
    body_html         text,
    status            varchar(10)  NOT NULL,
    attempts          integer      NOT NULL DEFAULT 0,
    max_attempts      integer      NOT NULL,
    next_attempt_at   timestamptz  NOT NULL,
    locked_until      timestamptz,
    last_error        varchar(300),
    created_at        timestamptz  NOT NULL,
    updated_at        timestamptz  NOT NULL,
    sent_at           timestamptz,
    CONSTRAINT ck_email_outbox_status CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED')),
    CONSTRAINT ck_email_outbox_attempts CHECK (attempts >= 0 AND max_attempts > 0)
);
CREATE INDEX ix_email_outbox_due ON email_outbox (next_attempt_at) WHERE status IN ('PENDING', 'SENDING');
CREATE INDEX ix_email_outbox_failed ON email_outbox (updated_at DESC) WHERE status = 'FAILED';

-- Provider events: a hash of the payload as received (the stored payload itself is redacted), so a replay of
-- the same event id with different content can be detected without keeping personal data.
ALTER TABLE bank_events ADD COLUMN payload_sha256 varchar(64);

-- Deterministic keyset pagination: (sort column, id) indexes for the high-volume lists.
CREATE INDEX ix_invoices_merchant_page ON invoices (merchant_id, created_at DESC, id DESC);
CREATE INDEX ix_bank_transactions_page ON bank_transactions (merchant_id, provider_occurred_at DESC, id DESC);
CREATE INDEX ix_payment_allocations_page ON payment_allocations (merchant_id, created_at DESC, id DESC);
CREATE INDEX ix_notifications_page ON notifications (recipient_user_id, merchant_id, created_at DESC, id DESC);
