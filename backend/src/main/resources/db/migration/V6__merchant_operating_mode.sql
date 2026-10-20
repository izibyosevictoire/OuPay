-- R1: per-merchant settings, starting with the operating mode.
--   BUSINESS    full business capabilities (goods, services or both arrive in later milestones).
--   SIMPLIFIED  streamlined amount-only payment collection.
-- The mode says how a business WORKS. It is unrelated to merchants.business_type, which is the legal form.
-- Purely additive: no existing table, row or constraint is touched, so the previous application version keeps
-- working against this schema (a merchant it creates simply has no row yet and is read as BUSINESS).

CREATE TABLE merchant_settings (
    merchant_id    uuid PRIMARY KEY REFERENCES merchants (id),
    operating_mode varchar(12) NOT NULL,
    updated_at     timestamptz NOT NULL,
    version        bigint      NOT NULL DEFAULT 0,
    CONSTRAINT ck_merchant_settings_mode CHECK (operating_mode IN ('BUSINESS', 'SIMPLIFIED'))
);

-- Every existing business keeps working exactly as before: it becomes BUSINESS.
INSERT INTO merchant_settings (merchant_id, operating_mode, updated_at)
SELECT id, 'BUSINESS', now() FROM merchants
ON CONFLICT (merchant_id) DO NOTHING;
