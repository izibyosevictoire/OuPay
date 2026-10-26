# Collection-code registry and agent assignments (R6a)

An **internal** registry of merchant collection codes and of who holds them. Architecture and open questions:
[`equity-integration-architecture.md`](equity-integration-architecture.md), [`equity-technical-questions.md`](equity-technical-questions.md).

**Nothing here creates or claims a real Equity till number.** Equity's capabilities are unconfirmed. A code is a record of what a
merchant asked for and, only once real bank evidence is recorded, of what the bank issued. There is no payment flow, no customer
instruction, and no bank-event attribution in R6a (those are R6c and R6d). Existing payment profiles, QR links, invoices, bank events and
allocations are untouched.

## Three identifiers (never confused)

| | What | Where |
| --- | --- | --- |
| `internalRef` (`CC-XXXXXXXX`) | **OuPay's own identifier, for people and support. Never a payment code and never a working Equity till number.** | `collection_codes.internal_ref` |
| `externalCode` | The code the **bank** issued. `NULL` until evidence is recorded, then never changes. | `collection_codes.external_code` |
| Sale reference / bank transaction reference | Per sale / per payment (existing, unchanged) | `payment_requests`, `bank_transactions` |

## Four different facts about a code

| Fact | Meaning | How it is known |
| --- | --- | --- |
| **Bank-provisioned** (`bankProvisioned`) | The bank approved the code: status `ACTIVE`, a bank-issued code and approval evidence are recorded, and it is **not simulated** | Status plus evidence in the database |
| **Assigned** (`currentAssignment`) | A person or collection point holds it: exactly one open assignment | The assignment table |
| **Eligible for collection now** (`payable`) | Everything below is true **at this moment** | Computed live on every read, never stored |
| **Simulated** (`simulated`) | A code on a simulated settlement account. **Never** eligible and never shown as a payment instruction, whatever else is true | Copied from the account when requested, immutable |

**Eligible for collection now** requires all of:

1. the code is real (not simulated) and bank-provisioned (`ACTIVE` with a bank-issued code and evidence);
2. it has an open assignment;
3. its settlement account's bank connection is `CONNECTED`;
4. the branch of the assignment, if any, is `ACTIVE`;
5. for a member assignee: the membership **and** the user are `ACTIVE`, and (with a branch) the member is still **actively assigned to that
   branch**. A collection point has no person, so only 1 to 4 apply.

When any condition fails the API returns `payable: false` and `eligibilityIssues` (`SIMULATED`, `NOT_BANK_APPROVED`, `NOT_ASSIGNED`,
`SETTLEMENT_ACCOUNT_NOT_CONNECTED`, `BRANCH_INACTIVE`, `ASSIGNEE_NOT_ACTIVE`, `ASSIGNEE_NOT_AT_BRANCH`). An open assignment **record** alone
therefore never keeps a code usable: a suspended or revoked agent, a deactivated branch or a disconnected account removes eligibility
immediately, while the assignment **history is neither deleted nor rewritten**. A code has at most one open assignment, so it can never be
eligible for two agents at once. The agent's own `/mine` view shows the bank-issued code **only** while the code is eligible, and a
suspended or revoked member cannot call it at all.

## Model (Flyway V11, additive)

* `collection_codes`: merchant, provider, **settlement destination** (a `payment_destination`, referenced through the composite key
  `(destination, merchant, provider)`, so a code can only sit on its own merchant's account and that account's provider), optional
  branch, label, status, the owner-declared bank-request reference, **approval evidence**, a durable `client_request_id` + request
  fingerprint, audit metadata, optimistic `version`, and `is_simulated`.
* `collection_code_assignments`: dated, append-only history: code, member **or** collection point, branch, `valid_from`, `valid_to`,
  assigned-by, ended-by, end reason, and a **snapshot** of the person's name, role and the branch at assignment time.
* The only change to an existing table is one added unique key on `payment_destinations (id, merchant_id, provider_id)`.

### What PostgreSQL enforces by itself

* **Same-merchant settlement account and provider**; same-merchant branch and member (composite keys).
* **`ACTIVE` needs a bank-issued code and recorded evidence**: a bank event, or an operator approval by **two different people**. The
  bank-issued code and the evidence exist together or not at all and can never change afterwards, nor can the owner-declared request reference.
* **A bank-issued code is unique in its provider's namespace for ever** (every status, case-insensitive): a deactivated code stays
  reserved, so it can never be ambiguously re-attributed to another merchant or code.
* **Lifecycle** only along legal steps (trigger); `DEACTIVATED` and `REJECTED` are final; identity can never change; a code is never deleted.
* **Assignments:** at most **one open assignment per code**; periods never overlap; a rejected, deactivated or suspended code cannot be
  assigned; a member must be `ACTIVE` in the same business; a code with a branch is only assigned at that branch, which must be active, and
  a member must be actively assigned to it; an assignment can only be **ended once** (adding the end time, who and why) and is never rewritten
  or deleted; a code with an open assignment cannot be deactivated or rejected until it is ended.

## Lifecycle and statuses

`REQUESTED` → `REQUEST_DECLARED` → `ACTIVE` ⇄ `SUSPENDED` → `DEACTIVATED`; `REQUESTED`/`REQUEST_DECLARED` → `REJECTED`; any non-final → `DEACTIVATED`.

| Status | Means | Does **not** mean |
| --- | --- | --- |
| `REQUESTED` | The merchant asked OuPay for a code | Anything was sent to the bank |
| `REQUEST_DECLARED` | The **owner says** a request was made to the bank, and recorded the reference they were given | That Equity received, is reviewing or agreed to it. It is a merchant declaration, **unverified** by OuPay |
| `ACTIVE` | The **bank** approved it and the evidence is recorded | Anything a merchant can set |
| `SUSPENDED`, `DEACTIVATED`, `REJECTED` | Withdrawn / final / refused | |

No merchant-facing endpoint sets `ACTIVE`, records a bank-issued code, or marks a code approved or resumed.

| Step | Who | Evidence |
| --- | --- | --- |
| Request a code (`REQUESTED`) | Owner (`collection_codes:manage`) | None. Nothing is sent to the bank. |
| Declare a request to the bank (`REQUEST_DECLARED`) | Owner | A reference **declared by the owner**; not verified, not an acknowledgement |
| Approve (`ACTIVE`), resume | **`CollectionCodeApprovalService`, switched off** | See below |
| Reject | The same service (reduces capability, so not gated) | A reason |
| Suspend, deactivate | Owner | A reason (deactivation ends the open assignment atomically) |

## Bank approval: unavailable for production

`CollectionCodeApprovalService` is the only place a code becomes bank-approved, and **it is off**:

* It refuses `approve` and `resume` (`501 not_implemented`) unless `oupay.collection-codes.approval-enabled=true`. The default is `false`, and the
  application **refuses to start** with it `true` under **any profile other than `test`** (an allow-list, so production, staging, dev and a bare deployment are all refused). Only the integration tests switch it on.
* **Why:** OuPay has no operator authentication and cannot yet verify a bank event. Two different user ids are not two independent decisions, and
  a caller naming `BANK_EVENT` is not proof the bank said anything. Approval stays unavailable for production until the real Equity integration (R6e)
  verifies authenticated bank evidence, or a separately reviewed operator process authenticates its operators and records their independent
  decisions. No operator console is built in R6a.
* It has **no controller**: no merchant, owner, manager or cashier can reach it, so an owner cannot fabricate approval by typing an evidence
  reference. There is no simulated approve endpoint.
* When enabled (tests): the code must be `REQUEST_DECLARED`; the bank-issued code is non-blank, differs from OuPay's reference and is not used by
  any code of the provider ever; evidence is present; a bank event names no person; an operator approval names two different existing people who
  **do not belong to the business that owns the code**. The evidence reference is kept out of the audit message.
* A simulated settlement account can be approved in tests but the code is never eligible.

## Agent assignment guarantees

* One open assignment per code (index); concurrent assignments serialise on the code row lock and the loser gets `409 already_assigned`.
* **Reassignment** ends the current assignment and creates the next in **one transaction**, the periods meeting exactly. A failed reassignment
  (for example an ineligible target) leaves the current agent in place. The caller states which assignment they saw (`expectedAssignmentId`);
  a stale view is `409 assignment_changed`.
* **Eligibility to be assigned:** an `ACTIVE` member with an active user; with a branch, an active branch the member is actively assigned to (the
  invoice-assignee rule). A suspended, revoked or invited member cannot receive a new assignment.
* **Staff changes never rewrite history.** The snapshot is what was true at assignment time; the open assignment also reports the person's current
  membership status. Automatic ending on a staff change is not part of R6a (see questions); eligibility already ends immediately.

## API (base `/api/v1/merchants/{merchantId}/collection-codes`)

| Method and path | Permission | Notes |
| --- | --- | --- |
| `GET /options` | `collection_codes:view` | Settlement accounts (masked), branches, assignable members. |
| `GET ""?limit&cursor&status&branchId&q` | view | Keyset page, newest first. |
| `POST ""` | `manage` | `clientOperationId` (durable, idempotent), settlement account, label, optional branch. `201`, or `200 replayed:true`; authorisation is rechecked on a replay. |
| `GET /{id}`, `GET /{id}/assignments` | view | Detail; full history (keyset, newest first). |
| `POST /{id}/assignments`, `/assignments/end`, `/reassign` | `assign` | Managers only for codes of branches they are assigned to; branchless codes are the owner's. |
| `POST /{id}/submission` | `manage` | Declares a request to the bank (`REQUEST_DECLARED`). |
| `POST /{id}/suspend`, `/deactivate` | `manage` | Reason and `expectedVersion`. |
| `GET /mine` | any **active** member | The caller's own current code only. |

Permissions (smallest compatible extension): `collection_codes:view` (owner, manager), `collection_codes:assign` (owner; manager limited to their
assigned branches), `collection_codes:manage` (owner only, like bank linkage). Cashiers have no permission and use `/mine`. Not mode-gated.

## Data exposure

* **Settlement account:** only the label and the masked identifier. Provider account ids, credentials and tokens are never returned.
* **Approval evidence reference and the owner-declared bank-request reference:** returned **only** to people who manage codes (owners). Managers see
  who approved (`source`) and when, not the reference; cashiers see neither. Neither appears in the audit trail.
* **Approving operators' user ids** are never returned. No identity-document data exists in this module.
* The bank-issued code is shown to owners and managers once bank-approved, and to an agent only while eligible.

## Audit

`COLLECTION_CODE_REQUESTED`, `_BANK_REQUEST_RECORDED`, `_APPROVED`, `_REJECTED`, `_SUSPENDED`, `_RESUMED`, `_DEACTIVATED`, `_ASSIGNED`, `_REASSIGNED`,
`_ASSIGNMENT_ENDED`, written in the same transaction as the change (a failing audit rolls the whole operation back).

## Concurrency and idempotency

Lock order: (1) for a new request, the advisory lock of (business, client request id); (2) the row lock of the code. Every write is one transaction.
A repeat of a request returns the same code; a different request under the same id is `409 client_request_id_reuse`.

## Known limits

* No real Equity integration, no bank-event attribution, no customer instructions (R6c to R6e); approval is switched off.
* No operator console or operator authentication.
* Staff suspension does not automatically end their assignment; eligibility ends at once and the API flags it.
* Provider ids are the existing three; a real Equity provider id needs a reviewed constraint widening (R6e).
