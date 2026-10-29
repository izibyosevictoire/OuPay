# OuPay 2.0 delivery roadmap

How to read the status column. These are **different things** and must not be confused:

| Status | Meaning |
| --- | --- |
| **Implemented and merged** | In `origin/develop` history. |
| **Locally committed** | Committed on the local `develop` branch only; not pushed. |
| **Uncommitted** | In the working tree only. |
| **CI-verified** | A GitHub Actions run of `mvn -B clean verify` against PostgreSQL has passed **for that code**. |
| **Externally blocked** | Cannot proceed until a third party (Equity) supplies documentation, approval or access. |
| **Not started** | No code exists. |

Nothing in this repository is recorded as CI-verified for R5a to R5c: they have never been pushed. For R1 to R4 the merge to
`origin/develop` is a fact visible in git history (for example PR #8 for R3), but this document does not assert a CI result for them;
confirm in GitHub Actions.

## Current state

| Milestone | What it is | Status | CI-verified | Notes |
| --- | --- | --- | --- | --- |
| R1 | Merchant operating mode (BUSINESS / SIMPLIFIED) | Implemented and merged | Confirm in CI | |
| R2 | Idempotency foundation | Implemented and merged | Confirm in CI | |
| R3 | Invoice provenance and payment-request lifetime | Implemented and merged (PR #8) | Confirm in CI | |
| R4 | Simplified merchant checkout; CI runs on `develop` | Implemented and merged | Confirm in CI | |
| R5a | Exact measurement and quantity foundation | **Locally committed** (`0593bf9`) | **No** | **Awaiting real Maven/PostgreSQL verification.** Verified only with a stub harness, never real Maven/JUnit |
| R5b | Unified goods and services catalog (V9) | **Locally committed** (`3d8ff41`) | **No** | **Awaiting real Maven/PostgreSQL verification.** Backend integration tests and V9 never run; frontend tests pass locally |
| R5c | Branch inventory foundation (V10) and corrections | **Uncommitted** | **No** | **Awaiting real Maven/PostgreSQL verification.** Under review; V10 triggers, JPA mapping and PostgreSQL tests unverified |
| R6a to R6e | Equity merchant-code collection | **Not started** | n/a | See below |
| R7 | Business POS with catalog, stock and codes | **Not started** | n/a | Depends on R5 and R6 |

Local verification that has actually been run: frontend typecheck, lint, build and Vitest (three known failures that also fail on the
unchanged baseline: `deployConfig`, `dashboardInvoices`, `InvoicesPage`), and strict Java compilation against framework stubs. **Not**
run anywhere yet: real Maven, Flyway migrations V9 and V10, PostgreSQL integration tests, SpotBugs.

## Gate before any further feature work

1. Review and commit R5c locally (when authorised).
2. A push, authorised by the user, and a green `mvn -B clean verify` with PostgreSQL 18 on GitHub Actions for R5a to R5c.
   Until then V9 and V10 remain unproven, and anything built on them is built on unverified ground.

## Equity merchant-code collection (approved sequence)

Architecture: [`equity-integration-architecture.md`](equity-integration-architecture.md). Questions for Equity:
[`equity-technical-questions.md`](equity-technical-questions.md).

| Milestone | Scope | Depends on | Blocked externally? |
| --- | --- | --- | --- |
| **R6a** | Collection-code registry and agent assignments: codes tied to the merchant settlement account, append-only assignment history, lifecycle with evidence-gated activation, simulated provisioning only | Equity answers 1.1 to 1.3 to fix the model; R5c gate | **Partly.** The model's shape depends on whether one account can have many codes. Build only after those answers or against an explicit fallback |
| **R6b** | Initial Equity KYC onboarding: configurable requirement sets, applications, consent, private documents, PII controls, honest statuses | Storage and retention decisions; Equity answers 5.x for submission | **Partly.** Collection can be built without Equity; submission cannot claim anything without a real channel |
| **R6c** | Code-based checkout and customer instructions ("Pay using Equity merchant code"); sale snapshots the code and assignment | R6a | **Yes** for exact instruction wording (answers 1.6, 2.x). Customer text only states confirmed capabilities |
| **R6d** | Bank-event attribution and exact reconciliation: code on transactions, authenticated-evidence auto-allocation, suggestions for manual reconciliation, legacy matching preserved | R6a, R6c; answers 2.1 to 2.3 | **Yes.** Auto-allocation depends on whether the bank returns the code and any sale reference |
| **R6e** | Real Equity integration: adapter(s) per confirmed capability behind flags | Equity documentation, sandbox and approval | **Yes.** Entirely blocked until Equity supplies documentation and approval |
| **R7** | Business POS integrated with catalog, stock and code-based payment | R5a to R5c verified; R6c to R6d | Indirectly |

### Internal development versus Equity-approved live activation

Two different things are tracked separately and must not be confused:

| | Internal code-registry development (R6a, R6c, R6d as code) | Equity-approved live activation |
| --- | --- | --- |
| What it is | OuPay's own tables, rules, screens and tests, exercised with **simulated** provisioning and the simulated provider | A code that Equity itself has issued or approved for a real merchant account, confirmed by bank evidence |
| Needs Equity? | Only for decisions that shape the model (answers 1.1 to 1.3) | **Yes**: documentation, approval, sandbox or production access, and an authorised integration |
| Can be "done" by OuPay alone? | Yes, as code and tests | **No** |
| What it may claim | That the registry enforces its rules (unique codes, append-only assignments, evidence-gated states) | Nothing is a real, usable Equity code until bank approval or trusted evidence is recorded |

Finishing the registry does **not** activate any real code, and simulated or internally generated codes are always labelled as such. A
code becomes live only through R6e's real integration or an authorised operator recording Equity's written confirmation with an
evidence reference. Production use of R6c and R6d stays disabled until that happens.

Rules that apply to every R6 step:

* Reuse existing bank connections, destinations, invoices, payment requests, bank events, transactions and allocations. No second ledger.
* Never activate an internally generated code as a real Equity code without bank approval or trusted evidence.
* Never say data was sent to Equity, or that an account is approved, without a real authorised integration or recorded evidence.
* Legacy payment matching is unchanged; any change to it is reviewed separately.
* Assignment history is append-only; no agent attribution from timestamps alone.

## Decisions still open

* Which Equity capabilities exist (the questionnaire).
* KYC document storage, retention and legal basis.
* How R5c's quantity and price rounding decisions (see `measurement.md`, `catalog.md`) connect to POS.
* Whether a zero opening-stock initialisation event is wanted (see `inventory.md`).
