# R9b: sample data for an EXISTING merchant

An operator command that adds a small, clearly labelled sample dataset to **one existing merchant** in the database the application already uses. It adds
**ordinary records, through the application's own services**, as the merchant's own owner, so they behave exactly like records a person made: they appear in the
normal screens, can be edited and extended in the UI, and are audited, tenant-scoped and permission-checked like everything else.

It is **not** a seeder for the whole database, **not** an HTTP endpoint, and **not** a back door. It never creates a second merchant, project or deployment.

> Not to be confused with the R9 demonstration seeder (`docs/demo-seed.md`): that one builds a *separate* demo business in a *disposable* database and is
> locked to it. R9b adds sample records to *your* business and is locked to *that business and its owner*. Neither relaxes the other's guards.

## The sample dataset

Everything carries the prefix `DEMO` and the batch identifier `R9B-SAMPLE-1` (defined in `SampleDataPlan`).

| Kind | What |
| --- | --- |
| Branches (3) | `DEMO - Kigali Main` (`DEMOKGL`), `DEMO - Remera` (`DEMORMR`), `DEMO - Kimironko` (`DEMOKMR`) |
| Catalog, goods (10) | `DEMO-RICE`, `DEMO-SUGAR`, `DEMO-FLOUR`, `DEMO-BEANS`, `DEMO-SALT` (kg), `DEMO-OIL` (l), `DEMO-SODA`, `DEMO-WATER`, `DEMO-NOTE`, `DEMO-SOAP` (pieces); names `DEMO - Rice`, ...; a rice *Sack* (25 kg) and a soda *Crate* (24) package |
| Catalog, services (2) | `DEMO-CHARGE` phone charging (RWF 200), `DEMO-DELIVER` delivery within Kigali (RWF 2,000) |
| Opening stock | 21 ordinary immutable *opening* movements: Kigali Main carries all 10 goods, Remera 6, Kimironko 5; each carries the reference `R9B-SAMPLE-1` |
| Payment points (3) | two static QR (`DEMO - Kigali Main counter QR`, `DEMO - Remera counter QR`) and one NFC tag (`DEMO - Kimironko door tag`) |
| Staff (1 manager, 2 cashiers) | invited through the real invitation flow, **only to addresses you supply** (see below) |
| POS drafts (2) | `DEMO - sample cart: groceries` and `... stationery and soap`, **only if the existing rules allow them** (see below) |

**Never created:** a bank transaction, allocation, ledger entry, balance, settlement account, collection code, approval or tax decision; any invoice, bill,
payment request, stock reservation or sale; any user with a password, any verified-by-hand email, or any session for anyone but the owner.

### Staff: real flow, real mailbox

An invited person is created as a *placeholder that cannot sign in* and receives a one-time link by email; they choose their own name and password through the
supported flow, and only then does the membership activate and the branch assignments (carried by the invitation) take effect. The importer therefore needs **real
addresses you control** (for example `you+manager@yourdomain`), supplied at run time (`manager-email`, `cashier-emails`). With none supplied the staff lines are
reported as `SKIP` and nothing is invited. The importer **queues** the invitation emails in the shared outbox; the **deployed service's dispatcher** sends them (the
importer's own process has its dispatcher switched off, so nothing is sent from your machine). The preview masks addresses and warns that a real email will be sent.

### POS drafts: only where the rules allow

The existing rules allow a draft (a cart, never a sale: no tax decision, no code, no stock) only to someone **assigned to the branch**, in business mode. The
importer **never changes anyone's branch assignments**, so on a first run drafts are reported as `SKIP` ("the owner is not assigned to a sample branch"). Assign
yourself to a sample branch in the application (Branches), then run the importer again: the preview now shows the two drafts as `CREATE`. Billing a draft still needs
a tax decision and an approved collection code (Equity gates); the importer touches neither.

## How the target merchant is chosen (the targeting mechanism)

Three things must all hold, supplied by you at run time and never defaulted:

1. `oupay.sample-import.merchant-id`, the **one** merchant's id. There is no "all merchants" and no default.
2. `oupay.sample-import.owner-email` and `OUPAY_SAMPLE_IMPORT_OWNER_PASSWORD`: the owner's credentials. The password is verified against its hash, and the user must hold an
   **ACTIVE OWNER membership of exactly that merchant**. A manager, a cashier, the owner of a different business, an unknown address or a wrong password are all refused
   with the same message, so the importer cannot be used to discover which addresses exist. (Suspended or rejected merchants are refused too.)
3. `oupay.sample-import.confirm-plan`: the fingerprint of the exact plan you previewed (below). Without it the command is a **dry run**.

Every write is then made **as that owner**, through `BranchService`, `CatalogService`, `InventoryService`, `EntryDeviceService`, `InvitationService` and
`PosService`: the same tenant checks, role permissions, validation, immutable stock movements, catalog price versions and audit lines as the UI. No business table
is written with SQL; the importer's own SQL only reads.

## Dry run, confirmation and the preview

A run without `confirm-plan` is a **dry run**: it writes nothing (not even a sign-in or a failed-login count) and prints every record as

* `CREATE`: will be created;
* `KEEP`: already there (by natural key); left exactly as it is, whatever a person did to it;
* `SKIP`: cannot or should not be created, with the reason.

It ends with a 16-character **plan fingerprint**, computed from the database name, the merchant, the dataset version and every line's decision. To apply, run again with
that value as `confirm-plan`. The importer recomputes the plan at that moment and **refuses unless it is identical**: if anything changed since your preview (a person
made one of the records, a different merchant, a different dataset version), the confirmation no longer matches and nothing is written. A confirmation for one merchant
can never apply to another.

Example preview (abridged):

```
Sample data batch R9B-SAMPLE-1 (plan v1)
  merchant : Your Business Ltd [active] 3b44d464-...
  database : neondb on ep-...-pooler.neon.tech
  CREATE branch        DEMO - Kigali Main (DEMOKGL)
  CREATE catalog item  DEMO - Rice (DEMO-RICE, goods, RWF 1200)
  CREATE opening stock DEMOKGL / DEMO-RICE opening 150 kg
  CREATE payment point DEMO - Kigali Main counter QR (STATIC_QR)
  SKIP   staff         Sample manager (manager)  -- no address supplied (...)
  SKIP   POS draft     DEMO - sample cart: groceries  -- the owner is not assigned to a sample branch ...
  total    : 41 to create, 0 already there, 5 skipped
  plan fingerprint: 9f2c4a7d1e8b3a60
```

## Repeat-run behaviour (idempotent, non-destructive)

* Every record is found by its **natural key** (branch code, item code, device request id derived from merchant + key, stock history of the branch and item, draft request id,
  staff address) and **created only if missing**.
* An existing record is **never updated, reset, re-created or deleted**: a renamed item, a changed price (a new immutable price version), a deactivated entry, a revoked or
  suspended payment point, an inactive branch, extra stock, discarded drafts, a fourth branch or extra staff all survive any number of runs.
* **Stock:** if a branch/item pair has *any* stock history (a person's own opening, a receipt, a sale, an adjustment) it is `KEEP`. Opening stock is written once.
* **Branches/items that already exist under a sample code** (even if a person made them) are `KEEP`, never altered.
* A second run therefore previews `0 to create`, writes nothing, does not sign in, and adds no audit line.
* A run that stops half-way leaves each completed record committed on its own; a **fresh dry run** shows the remainder, a new confirmation finishes it.
* One `SAMPLE_IMPORT_RUN` audit line (owner as actor, batch identifier, number created) is written per run that created something.

## Safety design

* **No unauthenticated surface.** There is no controller, endpoint or scheduled job; the code exists only as an operator command (`ApplicationRunner`).
* **Cannot run in the deployed service.** It starts only under the dedicated `sample-import` profile and **never with `prod` or `demo-seed`**; the application **refuses to
  start** if `oupay.sample-import.enabled`/`run-on-startup` is set under any other profile (`SampleImportStartupGuard`). Production security configuration is untouched.
* **R9 demonstration guards are untouched** (`DemoSeed*`, `demo_environment`, `demo_seed_registry`, `application-demo-seed.yml`).
* **It never migrates the database.** The `sample-import` profile switches Flyway off, and the importer refuses unless the database's applied migration version **equals** this
  build's latest: run it from the same commit that is deployed (so the schema matches the code that writes to it).
* **Nothing else runs.** The profile switches off the email dispatcher, housekeeping, the fulfilment worker and the simulator, binds to loopback on a random port, and exits when
  the import ends (status 0; non-zero if it refused or a step failed, through Spring Boot's lifecycle, never `System.exit`).
* **No credentials in the repository or in the output.** The database URL/user/password, the owner's password and the staff addresses are run-time settings; the output
  never prints a password, and addresses are masked.

## Controlled import into the existing database: exact steps

Do these **in this order**. Nothing below is done by the coding task; each step is yours.

0. **Make sure the deployed service is the commit you will run from.** R9b depends on the R9 migration V20 (additive, two empty tables). Merge PR #10 and R9b only when you are
   ready; let Render deploy so Flyway applies V20 to the live database. The importer refuses to run if the applied schema version differs from the build's.
1. **Create a restore point.** In Neon, create a **branch** of the production database (or take a snapshot/export) *before* writing. Do not rely on a backup that you have not
   confirmed exists.
2. **Rehearse on a copy first** (strongly recommended): point the same command at the Neon branch you just made and import there; look at the result in a local frontend.
3. **Find the merchant id** (read-only), signed in as the owner in the application, or:

   ```sql
   select m.id, m.legal_name, m.trading_name, m.status
   from merchants m join memberships ms on ms.merchant_id = m.id join users u on u.id = ms.user_id
   where lower(u.email) = lower('<owner email>') and ms.role = 'OWNER' and ms.status = 'ACTIVE';
   ```

4. **Set the run-time settings** in a terminal (not in a file; the same connection details the Render service uses; prefer the **direct** Neon connection, not the pooler. If you
   must use a pooled URL also set `OUPAY_DB_CONNECTION_INIT_SQL="SELECT 1"`):

   ```bash
   export OUPAY_DB_URL='jdbc:postgresql://<host>/<db>?sslmode=require' OUPAY_DB_USER='<user>' OUPAY_DB_PASSWORD='<password>'
   export OUPAY_SAMPLE_IMPORT_ENABLED=true
   export OUPAY_SAMPLE_IMPORT_MERCHANT_ID='<merchant id>'
   export OUPAY_SAMPLE_IMPORT_OWNER_EMAIL='<owner email>'
   read -rs OUPAY_SAMPLE_IMPORT_OWNER_PASSWORD && export OUPAY_SAMPLE_IMPORT_OWNER_PASSWORD     # typed, not echoed
   # optional: real mailboxes you control, to invite sample staff
   export OUPAY_SAMPLE_IMPORT_MANAGER_EMAIL='you+manager@yourdomain'
   export OUPAY_SAMPLE_IMPORT_CASHIER_EMAILS='you+cashier1@yourdomain,you+cashier2@yourdomain'
   ```

5. **Dry run** (from the commit that is deployed):

   ```bash
   cd backend && mvn -B spring-boot:run -Dspring-boot.run.profiles=sample-import
   ```

   Read the preview. Check the merchant name and the database host. Check every `CREATE`. Copy the fingerprint.
6. **Apply** exactly that plan:

   ```bash
   export OUPAY_SAMPLE_IMPORT_CONFIRM_PLAN='<fingerprint>'
   mvn -B spring-boot:run -Dspring-boot.run.profiles=sample-import
   ```

7. **Verify in the application** as the owner: branches, catalog, inventory, payment points; invited staff receive their email (sent by the deployed service).
8. **Optional drafts:** assign yourself to a `DEMO` branch in the UI, `unset OUPAY_SAMPLE_IMPORT_CONFIRM_PLAN`, run the dry run again, and apply the new fingerprint.
9. **Clean up your shell:** `unset OUPAY_DB_PASSWORD OUPAY_SAMPLE_IMPORT_OWNER_PASSWORD OUPAY_SAMPLE_IMPORT_CONFIRM_PLAN OUPAY_SAMPLE_IMPORT_ENABLED`.
10. A second dry run now prints `0 to create`: that is the proof it is idempotent.

## Identifying the sample records (read-only)

```sql
select code, name, status from branches        where merchant_id = '<id>' and code like 'DEMO%';
select code, name, active  from catalog_items  where merchant_id = '<id>' and code like 'DEMO-%';
select display_name, status from payment_entry_devices where merchant_id = '<id>' and display_name like 'DEMO - %';
select count(*) from stock_movements           where merchant_id = '<id>' and reference = 'R9B-SAMPLE-1';
select note, status from pos_drafts            where merchant_id = '<id>' and note like 'DEMO - %';
select email, role, status from staff_invitations where merchant_id = '<id>' and note like 'Sample account (R9B-SAMPLE-1)%';
select created_at, message from audit_log      where merchant_id = '<id>' and kind = 'SAMPLE_IMPORT_RUN';
```

## Cleanup plan (what can and cannot be removed)

The application's financial, inventory and audit records are **append-only by design**, so the sample data is **retired, not deleted**. There is no "undo import" command, and
this document does not promise one. Use the normal UI/API, as the owner:

| Record | What is possible | What stays on record |
| --- | --- | --- |
| Catalog items | **Deactivate** (Catalog, status). They disappear from the POS and checkout lists. | The item, its price versions and its history are permanent. |
| Branches | Set **inactive** (Branches). They can no longer take new assignments or sales. | The branch, its assignments, stock movements and audit are permanent. |
| Stock | Zero the balance with a normal **adjustment / write-off** movement with a reason. | Every opening and adjustment movement is permanent and immutable. |
| Payment points | **Suspend**, or **revoke** (final; the public QR/NFC link stops working). | The device and its audit history remain. |
| POS drafts | **Discard** (final, nothing was reserved or sold). | The discarded draft stays on record. |
| Staff | **Withdraw** a pending invitation, or **suspend/revoke** the membership. | The user, membership and audit remain. |
| Audit lines | Not removable. | `SAMPLE_IMPORT_RUN`, `BRANCH_CREATED`, etc. remain and show who and when. |

Rows are *never* deleted with SQL, `TRUNCATE` or scripts. If you ever need a database with **no** sample rows at all, restore from the Neon restore point you made in step 1
(this also discards every record made since). A re-run of the importer after a cleanup will **not** re-create retired records (they still exist by natural key).

## Verification

Automated tests (`rw.oupay.sample`): dataset definition; guards (profile, never prod/demo-seed, no endpoint, no direct writes, no money); dry run writes nothing; confirmation
binding (missing, wrong, stale, other merchant); authentication and owner-only authorisation; the real invitation flow; draft rules; **tenant isolation** (another merchant's
rows, users and audit unchanged; two merchants each keep their own copy); **preservation of user-created and user-edited data**; second-run idempotency.
