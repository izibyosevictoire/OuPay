# Idempotency, retries and database errors

Design note for R2. It says what each protection is for, so that later milestones (billing, payment intents, stock)
put the permanent guarantees where they belong.

## 1. Five different protections. Do not confuse them.

| Layer | What it protects | Lives in | Lifetime | Status |
|---|---|---|---|---|
| **HTTP replay protection** | A client that lost a response, or retried while the first attempt was still running, gets the original result instead of a second operation | `idempotency_keys` (V7), `IdempotencyService` | **30 days, then pruned** | R2 |
| **Permanent business-operation uniqueness** | An operation that must never happen twice (a bill issued, a return recorded) | A uniqueness constraint or state machine on the business row itself | Forever | each milestone, see section 3 |
| **Bank-event deduplication** | The same provider event processed twice | `bank_events` unique `(provider_id, provider_event_id)`, `bank_transactions` unique `(provider_id, provider_transaction_id)` | Forever | existing (V3) |
| **Payment-allocation invariants** | Money applied twice, or an invoice overpaid | Trigger `guard_allocation_insert`, deferred trigger `check_allocation_invariant`, `ux_*` | Forever | existing (V3) |
| **Stock-movement uniqueness** | Stock deducted or returned twice | `UNIQUE (movement_type, source_type, source_id)` on `stock_movements` | Forever | future (R7, R10) |

**The HTTP table is a convenience, never the safety net.** If every idempotency record vanished, no duplicate payment,
allocation or stock movement could result, because each of those is stopped by its own permanent constraint.

## 2. How the HTTP replay works

`IdempotencyService.executeOnce(merchantId, scope, key, fingerprint, action, replay)` runs in **one transaction that it
opens itself** (a `TransactionTemplate`, not an annotation, so there is no self-invocation or proxy trap):

1. The caller must be an active member of the business (nothing is written for a stranger).
2. The key is claimed: `INSERT ... ON CONFLICT DO NOTHING` on `(merchant_id, scope, idem_key)`.
3. Claimed: the business `action` runs, then the record is completed with the identity of what it produced.
   Not claimed: the existing record is loaded. A different caller or a different request fingerprint gives
   `409 idempotency_key_reuse`; otherwise the `replay` function rebuilds the response.
4. Everything commits together, or everything rolls back.

Properties:

* **Atomic.** The record and the business change are one commit. A failure leaves neither; nothing is ever marked
  complete before the business transaction commits. A deferred trigger makes the database refuse a record that would
  commit without its result.
* **One execution under concurrency.** A second request with the same key waits on the primary-key index until the
  first transaction ends. First commits: the second replays. First rolls back: the second claims the key and runs.
* **Lost response or cancelled request.** The server finishes and commits whatever it started, so the retry replays
  the committed result.
* **Replay is authorised, never raw.** The record stores only the identity of the result (`result_entity_type`,
  `result_entity_id`). The caller's `replay` function must re-check permission and rebuild the response from the live
  entity. A caller who lost access gets 404, and a deleted entity gives the resource's normal not-found. Holding a key
  reveals nothing.
* **The fingerprint** is a SHA-256 of the canonical request: the operation name, the route parameters, and the body with
  sorted keys and normalised numbers. A reused key with different data is refused.
* **No nested use.** `executeOnce` refuses to run inside an existing transaction (`IllegalStateException`). If it joined an
  outer transaction it would return before anything is committed, and the outer transaction could still roll back the claim
  and the business change, so a caller could mistake an uncommitted result for a durable one. Call it from the outermost,
  non-transactional layer. That also lets `TransactionRetry` wrap it safely.

Using it from a controller or service:

```java
String fingerprint = idempotency.fingerprintOf("POS_BILL", Map.of("merchantId", merchantId, "saleId", saleId), body);
var outcome = idempotency.executeOnce(merchantId, "POS_BILL", idempotencyKeyHeader, fingerprint,
        () -> new Created<>(response, "invoice", invoice.getId()),          // the action: does its own permission check
        stored -> invoiceResponseFor(merchantId, stored.entityId()));       // the replay: re-checks permission, then rebuilds
```

## 3. What every later milestone must do (permanent uniqueness)

A billing, payment or stock endpoint is not finished with an `Idempotency-Key` alone. It also needs a permanent guard on
the business row, enforced by the database, that holds **even if the idempotency record has been pruned or never existed**:

| Operation | Permanent guard |
|---|---|
| Create a sale or simplified-checkout invoice | `invoices.client_request_id`: unique per `(merchant_id, client_request_id)` where not null (R3) |
| Bill (issue and reserve) | the invoice state machine (`DRAFT` to `ISSUED` happens once) and `UNIQUE (invoice_id)` on `stock_reservations` |
| Deduct stock for a paid sale | `UNIQUE (movement_type, source_type, source_id)` with the invoice item id as the source |
| Record a return | one movement per return line (`sale_return_lines.id` as the source), plus a unique client request id on the return |
| Manual stock adjustment, receipt, opening balance | one movement per client-supplied id (`source_type = 'MANUAL_REQUEST'`) |
| Apply a bank payment | existing event and allocation constraints |

Rules of thumb:

* A source identifier must identify a **line**, not a document. One sale may legitimately have several returns, so a
  uniqueness key built on the document would wrongly block the second one.
* Every such endpoint needs a test that **deletes the idempotency record and repeats the request**, and shows that no
  duplicate effect can occur.
* Never read `idempotency_keys` to make a business decision. Only `IdempotencyService` and `Housekeeping` touch the table
  (an architecture test enforces it).

## 4. Retention

* HTTP idempotency records are pruned by `Housekeeping` once they are **older than 30 days**. The period is a constant in
  code, not a merchant setting. Clients must not retry a request with the same key later than that.
* Pruning is bounded (500 rows per statement, at most 20 statements per run, oldest first through
  `ix_idempotency_keys_created`) and each statement commits on its own.
* `FOR UPDATE SKIP LOCKED` makes several application instances take different rows instead of waiting for each other.
* Only finished work can be pruned: a record of an operation still in flight is not visible to the pruning statement
  (it has not committed), and every committed record is complete.
* Pruning never touches bank events, ledger rows, audit rows or any durable business identifier.

## 5. Retrying contention (`TransactionRetry`)

PostgreSQL aborts a transaction on a deadlock (`40P01`) or a lock timeout (`55P03`). Nothing in an aborted transaction can be
repeated, but the **whole transaction** can be attempted again.

* Wrap the outermost call. The utility refuses to run inside a transaction, and every attempt is a fresh one.
* Only deadlocks and lock timeouts are retried, at most three times, with exponential delay (50 ms base, 500 ms cap) and
  jitter. The delay happens outside any transaction. The last failure is rethrown unchanged.
* Use it only for work that is safe to repeat: no irreversible external effect (e-mail, bank call), and either nothing
  changes on failure or a durable operation identity (section 3) prevents a double effect.
* No caller exists yet. The first billing or stock operation that needs it should adopt it.

## 6. Database errors in API responses

The response keeps the public shape `{ code, message, fields }`. Only the SQLSTATE is inspected, and no SQL, table name or
database message is ever returned.

| SQLSTATE | Meaning | Response |
|---|---|---|
| `40P01`, `55P03` | deadlock victim, lock timeout | `503 try_again` with `Retry-After: 1`. The transaction was rolled back, so the same request (with the same key) can be sent again. |
| `22003` | numeric value out of range | `500 service_unavailable`. The database cannot tell whether the client sent the value, so this is a server error by default. |
| `P0001` | a database rule refused the change | `409 ledger_rule_violation` (unchanged) |
| other integrity violations | | `409 conflict` (unchanged) |

Code that writes a **client-supplied** number says so with `DatabaseErrors.rejectingOverflowAsInput(write, message)`, which
turns an overflow into `422 validation`. An overflow in a sum or derived value stays a server error, because it is one.
