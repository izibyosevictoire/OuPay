-- OuPay backend: identity, merchants, memberships, branches.
-- Conventions:
--  * Every business-owned table carries merchant_id. References that must stay inside one
--    business use composite foreign keys (id, merchant_id), so isolation is enforced by the DB.
--  * Money columns are named *_rwf and hold WHOLE Rwandan francs as BIGINT. RWF has exponent 0
--    (no minor unit in everyday use). No floating point, no decimals, anywhere.
--  * Timestamps are timestamptz (UTC instants).

CREATE TABLE users (
    id                    uuid PRIMARY KEY,
    email                 varchar(254) NOT NULL,
    full_name             varchar(120) NOT NULL,
    phone_number          varchar(20)  NOT NULL DEFAULT '',
    password_hash         varchar(255),
    status                varchar(16)  NOT NULL,
    failed_login_attempts integer      NOT NULL DEFAULT 0,
    locked_until          timestamptz,
    password_changed_at   timestamptz,
    created_at            timestamptz  NOT NULL,
    updated_at            timestamptz  NOT NULL,
    version               bigint       NOT NULL DEFAULT 0,
    CONSTRAINT ck_users_status CHECK (status IN ('ACTIVE', 'SUSPENDED', 'PENDING')),
    CONSTRAINT ck_users_active_has_password CHECK (status <> 'ACTIVE' OR password_hash IS NOT NULL),
    CONSTRAINT ck_users_failed_attempts CHECK (failed_login_attempts >= 0)
);
CREATE UNIQUE INDEX ux_users_email_lower ON users (lower(email));

-- Server-side sessions. Only a SHA-256 hash of the opaque cookie value is stored, so a database
-- leak cannot be replayed as a live session.
CREATE TABLE auth_sessions (
    id                  uuid PRIMARY KEY,
    user_id             uuid         NOT NULL REFERENCES users (id) ON DELETE CASCADE,
    token_hash          bytea        NOT NULL,
    remember_me         boolean      NOT NULL,
    created_at          timestamptz  NOT NULL,
    last_seen_at        timestamptz  NOT NULL,
    idle_expires_at     timestamptz  NOT NULL,
    absolute_expires_at timestamptz  NOT NULL,
    revoked_at          timestamptz,
    client_ip           varchar(64),
    user_agent          varchar(200),
    CONSTRAINT ux_auth_sessions_token UNIQUE (token_hash)
);
CREATE INDEX ix_auth_sessions_user ON auth_sessions (user_id) WHERE revoked_at IS NULL;

CREATE TABLE merchants (
    id                  uuid PRIMARY KEY,
    owner_user_id       uuid         NOT NULL REFERENCES users (id),
    legal_name          varchar(200) NOT NULL,
    trading_name        varchar(200),
    business_type       varchar(24)  NOT NULL,
    status              varchar(24)  NOT NULL,
    registration_number varchar(40),
    tin                 varchar(9),
    country             varchar(2)   NOT NULL DEFAULT 'RW',
    province            varchar(60)  NOT NULL,
    district            varchar(60)  NOT NULL,
    sector              varchar(60)  NOT NULL,
    physical_address    varchar(300) NOT NULL,
    contact_full_name   varchar(120) NOT NULL,
    contact_email       varchar(254) NOT NULL,
    contact_phone       varchar(20)  NOT NULL,
    created_at          timestamptz  NOT NULL,
    updated_at          timestamptz  NOT NULL,
    version             bigint       NOT NULL DEFAULT 0,
    CONSTRAINT ck_merchants_type CHECK (business_type IN
        ('registered_company', 'cooperative', 'non_profit', 'sole_proprietor', 'informal_vendor')),
    CONSTRAINT ck_merchants_status CHECK (status IN
        ('draft', 'pending_verification', 'active', 'suspended', 'rejected')),
    CONSTRAINT ck_merchants_tin CHECK (tin IS NULL OR tin ~ '^[0-9]{9}$')
);
CREATE UNIQUE INDEX ux_merchants_tin ON merchants (tin) WHERE tin IS NOT NULL;
CREATE UNIQUE INDEX ux_merchants_registration_number
    ON merchants (registration_number) WHERE registration_number IS NOT NULL;
CREATE INDEX ix_merchants_owner ON merchants (owner_user_id);

CREATE TABLE memberships (
    id          uuid PRIMARY KEY,
    user_id     uuid        NOT NULL REFERENCES users (id),
    merchant_id uuid        NOT NULL REFERENCES merchants (id),
    role        varchar(16) NOT NULL,
    status      varchar(16) NOT NULL,
    created_at  timestamptz NOT NULL,
    updated_at  timestamptz NOT NULL,
    version     bigint      NOT NULL DEFAULT 0,
    CONSTRAINT ck_memberships_role CHECK (role IN ('OWNER', 'MANAGER', 'CASHIER')),
    CONSTRAINT ck_memberships_status CHECK (status IN ('INVITED', 'ACTIVE', 'SUSPENDED', 'REVOKED')),
    CONSTRAINT ux_memberships_user_merchant UNIQUE (user_id, merchant_id),
    CONSTRAINT ux_memberships_id_merchant UNIQUE (id, merchant_id)
);
CREATE INDEX ix_memberships_merchant ON memberships (merchant_id);

CREATE TABLE branches (
    id               uuid PRIMARY KEY,
    merchant_id      uuid         NOT NULL REFERENCES merchants (id),
    name             varchar(120) NOT NULL,
    code             varchar(12)  NOT NULL,
    province         varchar(60)  NOT NULL,
    district         varchar(60)  NOT NULL,
    sector           varchar(60)  NOT NULL,
    physical_address varchar(300) NOT NULL,
    contact_phone    varchar(20),
    status           varchar(16)  NOT NULL,
    created_at       timestamptz  NOT NULL,
    updated_at       timestamptz  NOT NULL,
    version          bigint       NOT NULL DEFAULT 0,
    CONSTRAINT ck_branches_status CHECK (status IN ('ACTIVE', 'INACTIVE')),
    CONSTRAINT ck_branches_code CHECK (code = upper(code)),
    CONSTRAINT ux_branches_merchant_code UNIQUE (merchant_id, code),
    CONSTRAINT ux_branches_id_merchant UNIQUE (id, merchant_id)
);

CREATE TABLE branch_assignments (
    id            uuid PRIMARY KEY,
    merchant_id   uuid        NOT NULL,
    membership_id uuid        NOT NULL,
    branch_id     uuid        NOT NULL,
    status        varchar(8)  NOT NULL,
    created_at    timestamptz NOT NULL,
    updated_at    timestamptz NOT NULL,
    ended_at      timestamptz,
    CONSTRAINT ck_branch_assignments_status CHECK (status IN ('ACTIVE', 'ENDED')),
    CONSTRAINT ck_branch_assignments_ended CHECK ((status = 'ENDED') = (ended_at IS NOT NULL)),
    CONSTRAINT fk_branch_assignments_membership FOREIGN KEY (membership_id, merchant_id)
        REFERENCES memberships (id, merchant_id),
    CONSTRAINT fk_branch_assignments_branch FOREIGN KEY (branch_id, merchant_id)
        REFERENCES branches (id, merchant_id)
);
-- One ACTIVE assignment per person and branch.
CREATE UNIQUE INDEX ux_branch_assignments_active
    ON branch_assignments (membership_id, branch_id) WHERE status = 'ACTIVE';
CREATE INDEX ix_branch_assignments_branch ON branch_assignments (branch_id) WHERE status = 'ACTIVE';
