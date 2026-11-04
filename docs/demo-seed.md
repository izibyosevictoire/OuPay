# R9: persistent demonstration seed data

The demonstration business is **ordinary data in PostgreSQL**, created through the application's own services, and from the first minute it is
managed like any other business: through the normal UI and API, with the normal permissions, audit and tenant rules. It is **not** a set of
front-end constants or browser storage, and the seeder is **not** a back door.

## What is seeded

| Kind | What |
| --- | --- |
| Business | `Umurava Demo Traders Ltd (demonstration)`, BUSINESS mode, reserved registration number `DEMO-RC-0001` and TIN `990000001` |
| Branches | `KGL1` Kigali Central (demo), `RMR2` Remera (demo), `NYM3` Nyamirambo (demo) |
| Users | owner `owner@<domain>`, manager `manager@<domain>` (branches KGL1, RMR2), cashier `cashier@<domain>` (branch KGL1). `<domain>` defaults to `demo.oupay.test` |
| Catalog | 12 entries: rice, sugar, maize flour, cooking oil, soda, water, notebook, laundry soap (goods) and phone charging, photocopy, delivery, tailoring repair (services), plus a rice sack and a soda crate package |
| Inventory | 12 ordinary immutable *opening* movements at KGL1 and RMR2; NYM3 starts empty so a person can receive stock there |
| Payment points | a static QR (KGL1), an NFC tag (RMR2) and an NFC bracelet (KGL1, the cashier's) |

## What is deliberately NOT seeded

* **No money:** no bank transaction, allocation, ledger entry, bank balance or settlement account.
* **No approvals:** no collection code (so none can be "approved"), and nothing that bypasses the Equity approval gates.
* **No tax decision:** items have **no tax treatment** configured, and nothing sets or approves `oupay.pos.approved-tax-treatments`.
* **No POS drafts, invoices or bills:** a draft is a person's working cart and billing needs both a tax decision and an approved code, two gates a seeder must not
  bypass. Users create drafts themselves in the POS page once branches, staff and catalog exist.
* **No payment point is given a bill** (that needs a code sale).

## How it works (and why it is safe)

* **It authenticates.** The seeder registers or signs in the demonstration **owner** with a password **you supply at run time** (never in the repository)
  and acts as that owner. A wrong password stops the run; it is never used to reset anything.
* **Staff use the real invitation flow.** The owner invites the manager and cashier; the one-time link goes to the in-memory **mail sink** (the seeder refuses
  to run unless the mail provider is the sink, so it can never send a real email) and the invitee accepts through that link. No verification flag is set by
  hand: the invited staff are verified by the link, the owner's email stays **unverified** (the demo address has no real mailbox).
* **Idempotent and non-destructive.** Every record is found by a natural key (registration number, branch code, item code, device request id, stock history) and
  **created only if missing**. An existing record is **never updated, reset or deleted**: a renamed item, a changed price, a deactivated entry, a revoked payment
  point, extra stock, a fourth branch or extra staff all survive any number of runs. Each step commits on its own, so a run that stopped half way is finished by
  simply running it again.
* **Same services, same rules.** Branches, catalog, inventory, payment points and invitations are created by `BranchService`, `CatalogService`,
  `InventoryService`, `EntryDeviceService` and `InvitationService`: tenant checks, role permissions, validation, immutable stock movements and audit records apply.
  Creations are audited with the owner as actor, and a run that created something adds one `DEMO_SEED_RUN` audit line.
* **A demonstration business is only ever adopted if its owner is the demonstration owner.** A business that merely holds the reserved registration number is
  never touched: the run stops.

## The three locks (production cannot trigger it)

1. **Profile.** It can be switched on only under the dedicated `demo-seed` profile and **never together with `prod`**. With any other profile
   (prod, staging, dev, none) the application **refuses to start** if `oupay.demo-seed.enabled` or `run-on-startup` is set. Without the switch the seeder
   classes are not even beans.
2. **A database designated by hand.** The seeder runs only if the table `demo_environment` (V20, **empty everywhere by default**) contains its single row. No
   migration, no code and no seeder ever inserts that row: **a person inserts it, once, on the disposable demonstration database only.**
3. **Host and name.** The JDBC host must be in `oupay.demo-seed.allowed-db-hosts` and `oupay.demo-seed.confirm-database` must equal the actual database name.

## Running it

Use a **disposable demonstration database** (a local PostgreSQL, or a separate Neon project/branch created for demonstrations). **Never** the live
merchant database, and never run it against deployed Neon unless that database is a designated demonstration one.

```bash
# 1. Designate the demonstration database, by hand, once.
psql -d oupay_demo -c "insert into demo_environment (label) values ('OuPay demonstration database')"

# 2. Run it (the application migrates the schema first; every secret is supplied here, never committed).
export OUPAY_DB_URL=jdbc:postgresql://localhost:5432/oupay_demo OUPAY_DB_USER=oupay OUPAY_DB_PASSWORD=...
export OUPAY_DEMO_SEED_ENABLED=true
export OUPAY_DEMO_SEED_CONFIRM_DATABASE=oupay_demo
export OUPAY_DEMO_SEED_ALLOWED_DB_HOSTS=localhost
export OUPAY_DEMO_SEED_OWNER_PASSWORD="$(openssl rand -base64 24)"      # keep these: they are the logins
export OUPAY_DEMO_SEED_MANAGER_PASSWORD="$(openssl rand -base64 24)"    # (manager and cashier are only needed on the first run)
export OUPAY_DEMO_SEED_CASHIER_PASSWORD="$(openssl rand -base64 24)"
mvn -B spring-boot:run -Dspring-boot.run.profiles=demo-seed
```

The process prints a report (created / kept per kind of record, never a secret) and exits (non-zero if it refused). Running it again prints "created 0".
Optional: `OUPAY_DEMO_SEED_EMAIL_DOMAIN` (default `demo.oupay.test`).

## Inspecting the initial data

```sql
select entity_type, count(*) from demo_seed_registry group by 1 order by 1;            -- what the seeder made
select code, name, status from branches where merchant_id = (select id from merchants where registration_number = 'DEMO-RC-0001');
select kind, count(*) from audit_log where merchant_id = (select id from merchants where registration_number = 'DEMO-RC-0001') group by 1;
```

Or sign in to the application (any normal profile, pointed at the demonstration database) as the owner, manager or cashier with the passwords you set.

## Continuing in the UI

Everything is a normal record. As the **owner**: add branches and staff (Branches, Cashiers & staff), add, edit and deactivate catalog entries and change a
price (Catalog: each price change is a new immutable version), receive and adjust stock (Inventory), register, suspend and revoke payment points (Payment
points), and create POS drafts (POS billing, as an assigned cashier or manager). The seeder never overwrites any of it.

## Limitations and blockers

* To **reset** a demonstration environment, recreate its database: the seeder is deliberately non-destructive and has no "reset".
* The seeded emails (`*.test`) have no mailbox: the owner's email stays unverified, and new staff invited later need a real SMTP configuration (or the sink in a
  local run).
* Billing a POS draft still needs a tax decision, an approved collection code and enabled live collection; none exists in a deployed environment (Equity gates),
  so the demonstration shows catalog, stock, staff, branches and payment points, not a paid sale.
* V20 is additive (two empty tables, one trigger); it reaches a deployed database only when the application is next deployed. The seeder classes then ship but are
  inert: they need the `demo-seed` profile and explicit switches.
