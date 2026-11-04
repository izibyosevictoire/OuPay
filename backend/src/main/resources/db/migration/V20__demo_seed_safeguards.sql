-- R9: safeguards for the persistent DEMONSTRATION seed. Additive: V1 to V19 are untouched, and nothing here changes any existing table.
--
-- The demonstration seeder (rw.oupay.demo) may only ever run against a database that an operator has DELIBERATELY designated as a demonstration
-- environment. This migration creates the marker table EMPTY. No migration, no application code and no seeder ever inserts the marker row: a person
-- inserts it by hand, once, on the disposable demonstration database, so a production or staging database can never be mistaken for one by accident.
--
--   demo_environment    one optional row: "this database is a demonstration environment". EMPTY everywhere unless an operator adds it.
--   demo_seed_registry  insert-only record of what the seeder created (so a run can be inspected, and a merchant is only ever adopted if the seeder
--                       made it). It never records or changes anything about money.

CREATE TABLE demo_environment (
    id            smallint    PRIMARY KEY DEFAULT 1,
    label         varchar(80) NOT NULL,
    designated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT ck_demo_environment_single CHECK (id = 1),
    CONSTRAINT ck_demo_environment_label CHECK (length(btrim(label)) > 0)
);

CREATE TABLE demo_seed_registry (
    seed_key    varchar(160) PRIMARY KEY,
    entity_type varchar(40)  NOT NULL,
    entity_id   uuid         NOT NULL,
    merchant_id uuid REFERENCES merchants (id),
    created_at  timestamptz  NOT NULL
);
CREATE INDEX ix_demo_seed_registry_merchant ON demo_seed_registry (merchant_id, entity_type);

-- Registry rows are facts about what was seeded: never rewritten, never deleted.
CREATE FUNCTION forbid_demo_registry_change() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'demo_seed_registry rows are never changed or deleted';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_demo_seed_registry_immutable BEFORE UPDATE OR DELETE ON demo_seed_registry
    FOR EACH ROW EXECUTE FUNCTION forbid_demo_registry_change();
