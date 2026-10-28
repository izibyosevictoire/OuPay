package rw.oupay.ledger;

import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.util.Locale;
import java.util.Optional;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.banking.BankConnection;
import rw.oupay.banking.BankConnectionRepository;
import rw.oupay.banking.BankingProviderAdapter.NormalizedBankEvent;
import rw.oupay.common.TokenHashing;
import rw.oupay.invoice.Invoice;
import rw.oupay.invoice.InvoiceRepository;
import rw.oupay.invoice.InvoiceStatus;
import rw.oupay.invoice.SaleChannel;
import rw.oupay.notification.NotificationService;
import rw.oupay.payment.PaymentRequest;
import rw.oupay.payment.PaymentRequestRepository;
import rw.oupay.payment.PaymentRequestSource;

/**
 * THE TRUSTED BANK-EVENT PROCESSOR.
 *
 * <p>It is reachable only from the authenticated, provider-specific integration boundary (and from
 * tests). There is deliberately NO public or merchant-facing API that calls it: a customer, a
 * cashier or the frontend can never confirm a payment.
 *
 * <p>Guarantees, all inside ONE database transaction per event:
 * <ul>
 *   <li><b>Idempotent:</b> (provider, event id) is unique, so a replay is recorded and ignored, and
 *       two concurrent deliveries serialise on the unique index.</li>
 *   <li><b>One transaction per (provider, provider transaction id):</b> re-deliveries under new event
 *       ids never create a second transaction or count money twice.</li>
 *   <li><b>Ordering:</b> a status change applies only if it is newer than the applied one and is a
 *       legal transition; a stale event never overwrites newer state.</li>
 *   <li><b>Exact reference only:</b> never matched by amount, time, payer name or branch.</li>
 *   <li><b>No overpayment:</b> at most the remaining balance is applied; the rest is flagged.</li>
 *   <li><b>Lock order:</b> transaction row first, then invoice rows, so concurrent processing and
 *       manual reconciliation cannot deadlock or double-allocate.</li>
 * </ul>
 */
@Service
public class BankEventProcessor {

    private static final Logger log = LoggerFactory.getLogger(BankEventProcessor.class);

    public enum Outcome { APPLIED, DUPLICATE, STALE, REJECTED }

    public record Result(Outcome outcome, UUID transactionId, String reason) {}

    private final JdbcClient jdbc;
    private final BankConnectionRepository connections;
    private final BankTransactionRepository transactions;
    private final PaymentRequestRepository requests;
    private final InvoiceRepository invoices;
    private final LedgerOperations ledger;
    private final AttributionRecorder attribution;
    private final NotificationService notifications;
    private final AuditService audit;
    private final FinancialMetrics metrics;
    private final Clock clock;

    public BankEventProcessor(JdbcClient jdbc, BankConnectionRepository connections, BankTransactionRepository transactions,
                              PaymentRequestRepository requests, InvoiceRepository invoices, LedgerOperations ledger, AttributionRecorder attribution,
                              NotificationService notifications, AuditService audit, FinancialMetrics metrics, Clock clock) {
        this.jdbc = jdbc;
        this.connections = connections;
        this.transactions = transactions;
        this.requests = requests;
        this.invoices = invoices;
        this.ledger = ledger;
        this.attribution = attribution;
        this.notifications = notifications;
        this.audit = audit;
        this.metrics = metrics;
        this.clock = clock;
    }

    /**
     * @param rawPayload the payload as received. It is hashed, then stored REDACTED (see {@link EventPayloadRedactor}),
     *                   immutably, before anything else happens.
     */
    @Transactional
    public Result process(NormalizedBankEvent event, String rawPayload) {
        Result result = processInternal(event, rawPayload);
        metrics.bankEvent(event.providerId().name(), result.outcome().name(), merchantOf(event), result.transactionId());
        return result;
    }

    private UUID merchantOf(NormalizedBankEvent event) {
        return jdbc.sql("select merchant_id from bank_events where provider_id = :p and provider_event_id = :e")
                .param("p", event.providerId().name()).param("e", event.providerEventId()).query(UUID.class).optional().orElse(null);
    }

    private Result processInternal(NormalizedBankEvent event, String rawPayload) {
        Instant now = clock.instant();
        String payloadHash = TokenHashing.sha256Hex(rawPayload);

        // 1. Idempotency. The unique index makes this the single point that decides "seen before".
        int inserted = jdbc.sql("insert into bank_events (id, provider_id, provider_event_id, provider_transaction_id, outcome, raw_payload, payload_sha256, received_at) "
                        + "values (:id, :p, :e, :t, 'RECEIVED', :raw, :hash, :now) on conflict (provider_id, provider_event_id) do nothing")
                .param("id", UUID.randomUUID()).param("p", event.providerId().name()).param("e", event.providerEventId())
                .param("t", event.providerTransactionId()).param("raw", EventPayloadRedactor.redact(rawPayload)).param("hash", payloadHash)
                .param("now", Timestamp.from(now)).update();
        if (inserted == 0) {
            Optional<UUID> knownMerchant = jdbc.sql("select merchant_id from bank_events where provider_id = :p and provider_event_id = :e")
                    .param("p", event.providerId().name()).param("e", event.providerEventId()).query(UUID.class).optional();
            UUID txId = findTransactionId(event).orElse(null);
            // Same event id, different content: a replay with a tampered body (or a provider bug). Never applied; always recorded.
            boolean mismatch = jdbc.sql("select payload_sha256 is not null and payload_sha256 <> :h from bank_events where provider_id = :p and provider_event_id = :e")
                    .param("h", payloadHash).param("p", event.providerId().name()).param("e", event.providerEventId())
                    .query(Boolean.class).optional().orElse(false);
            if (mismatch) {
                knownMerchant.ifPresent(m -> audit.recordLedger(m, null, "REPLAY_PAYLOAD_MISMATCH", txId, null,
                        "A repeated provider event id arrived with different content and was ignored."));
                metrics.replayMismatch(event.providerId().name(), knownMerchant.orElse(null));
            }
            knownMerchant.ifPresent(m -> audit.recordLedger(m, null, "DUPLICATE_EVENT_IGNORED", txId, null,
                    "Ignored a repeated provider event."));
            return new Result(Outcome.DUPLICATE, txId, "This event was already processed.");
        }

        // 2. The account the money reached decides the merchant. An unknown or non-live link is refused.
        Optional<BankConnection> connection = connections.findByProviderIdAndProviderAccountIdAndStatus(
                event.providerId(), event.providerAccountId(), BankConnection.Status.CONNECTED);
        if (connection.isEmpty()) {
            finish(event, null, Outcome.REJECTED, "The bank account is not linked to an active connection.");
            return new Result(Outcome.REJECTED, null, "The bank account is not linked to an active connection.");
        }
        UUID merchantId = connection.get().getMerchantId();

        // 3. One transaction per (provider, provider transaction id).
        boolean created = jdbc.sql("insert into bank_transactions (id, merchant_id, bank_connection_id, provider_id, provider_transaction_id, "
                        + "last_provider_event_id, direction, amount_rwf, currency, payment_reference, payer_display_name, provider_occurred_at, "
                        + "status_applied_at, received_at, status, is_simulated, review_state, created_at, updated_at, version, "
                        + "reported_code, origin_provider_event_id) "
                        + "values (:id, :m, :c, :p, :t, :e, 'INCOMING', :amount, 'RWF', :ref, :payer, :occ, :occ, :now, :status, :sim, 'NONE', :now, :now, 0, "
                        + ":reported, :e) "
                        + "on conflict (provider_id, provider_transaction_id) do nothing")
                .param("id", UUID.randomUUID()).param("m", merchantId).param("c", connection.get().getId())
                .param("p", event.providerId().name()).param("t", event.providerTransactionId()).param("e", event.providerEventId())
                .param("amount", event.amountRwf()).param("ref", event.paymentReference()).param("payer", event.payerDisplayName())
                .param("occ", Timestamp.from(event.occurredAt())).param("now", Timestamp.from(now))
                .param("status", event.status().name()).param("sim", event.simulated()).param("reported", event.reportedCode()).update() == 1;

        // Lock the row (waits for a concurrent creator to commit): from here on this event owns the transaction.
        BankTransaction tx = transactions.lockByProviderTransaction(event.providerId(), event.providerTransactionId()).orElseThrow();
        if (!tx.getMerchantId().equals(merchantId) || !tx.getBankConnectionId().equals(connection.get().getId())) {
            finish(event, merchantId, Outcome.REJECTED, "The transaction belongs to a different account.");
            return new Result(Outcome.REJECTED, tx.getId(), "The transaction belongs to a different account.");
        }

        if (created) {
            audit.recordLedger(merchantId, null, "TRANSACTION_CREATED", tx.getId(), null,
                    (event.simulated() ? "Simulated " : "") + event.status().name().toLowerCase(Locale.ROOT) + " payment of RWF "
                            + event.amountRwf() + " received.");
            finish(event, merchantId, Outcome.APPLIED, null);
            if (tx.getStatus() == BankTransactionStatus.CONFIRMED) {
                reconcileConfirmed(tx);
            }
            attribute(tx, event);
            return new Result(Outcome.APPLIED, tx.getId(), null);
        }
        return applyToKnown(event, merchantId, tx);
    }

    /** The same transaction again: validate it, then apply only a legal, newer status change. */
    private Result applyToKnown(NormalizedBankEvent event, UUID merchantId, BankTransaction tx) {
        BankTransactionStatus next = BankTransactionStatus.valueOf(event.status().name());
        if (tx.getAmountRwf() != event.amountRwf()) {
            finish(event, merchantId, Outcome.REJECTED, "The amount does not match the recorded transaction.");
            audit.recordLedger(merchantId, null, "EVENT_RECEIVED", tx.getId(), null,
                    "Rejected an event whose amount (RWF " + event.amountRwf() + ") differs from the recorded RWF " + tx.getAmountRwf() + ".");
            return new Result(Outcome.REJECTED, tx.getId(), "The amount does not match the recorded transaction.");
        }
        if (next == tx.getStatus()) {
            finish(event, merchantId, Outcome.DUPLICATE, "The transaction is already in this status.");
            audit.recordLedger(merchantId, null, "DUPLICATE_EVENT_IGNORED", tx.getId(), null, "Ignored an event that repeats the current status.");
            return new Result(Outcome.DUPLICATE, tx.getId(), "The transaction is already in this status.");
        }
        boolean isNewer = !event.occurredAt().isBefore(tx.getStatusAppliedAt());
        if (!isNewer || !tx.getStatus().canTransitionTo(next)) {
            finish(event, merchantId, Outcome.STALE, "The event is older than, or cannot follow, the current status.");
            audit.recordLedger(merchantId, null, "STALE_EVENT_IGNORED", tx.getId(), null,
                    "Ignored an out-of-date " + next.name().toLowerCase(Locale.ROOT) + " event; the transaction stays "
                            + tx.getStatus().name().toLowerCase(Locale.ROOT) + ".");
            return new Result(Outcome.STALE, tx.getId(), "The event is older than, or cannot follow, the current status.");
        }
        BankTransactionStatus previous = tx.getStatus();
        tx.applyStatus(next, event.providerEventId(), event.occurredAt(), event.paymentReference(), clock.instant());
        transactions.saveAndFlush(tx);
        audit.recordLedger(merchantId, null, "STATUS_CHANGED", tx.getId(), null,
                "Status changed from " + previous.name().toLowerCase(Locale.ROOT) + " to " + next.name().toLowerCase(Locale.ROOT) + ".");
        finish(event, merchantId, Outcome.APPLIED, null);
        if (next == BankTransactionStatus.CONFIRMED) {
            reconcileConfirmed(tx);
        }
        if (next == BankTransactionStatus.REVERSED && previous == BankTransactionStatus.CONFIRMED) {
            ledger.reverseAllOf(tx);
        }
        attribute(tx, event);
        return new Result(Outcome.APPLIED, tx.getId(), null);
    }

    /**
     * Records what the bank reported about the code (R6d-A). Evidence only: it never allocates and never changes a status. Money that cannot
     * be attributed, or whose evidence contradicts itself, is flagged for a person when it is confirmed and has not been applied anywhere.
     */
    private void attribute(BankTransaction tx, NormalizedBankEvent event) {
        var result = attribution.record(tx, event.reportedCode());
        if (result.needsReview() && tx.getStatus() == BankTransactionStatus.CONFIRMED && tx.getReviewState() == ReviewState.NONE
                && ledger.allocatedOfTransaction(tx.getId()) == 0) {
            ledger.flagForReview(tx, result.note());
        }
    }

    /** Reference matching on a CONFIRMED transaction. Exact references only. */
    private void reconcileConfirmed(BankTransaction tx) {
        UUID merchantId = tx.getMerchantId();
        String reference = tx.getPaymentReference();
        if (reference == null) {
            // No reference to trust: stays unmatched and surfaces for review.
            audit.recordLedger(merchantId, null, "EVENT_RECEIVED", tx.getId(), null, "Confirmed with no payment reference, so nothing was matched.");
            notifications.unmatched(tx);
            return;
        }
        Optional<PaymentRequest> request = requests.findByMerchantIdAndPublicReference(merchantId, reference);
        // CODE sales are never matched here: not by their sale reference, not by their invoice number, and not by amount, time or agent either.
        // Money that names one stays CONFIRMED and UNMATCHED and goes to review, until bank attribution (R6d) has real evidence to use.
        boolean codeSale = request.map(r -> r.getSource() == PaymentRequestSource.CODE).orElse(false)
                || (request.isEmpty() && invoices.findByMerchantIdAndInvoiceNumber(merchantId, reference)
                        .map(i -> i.getSaleChannel() == SaleChannel.CODE).orElse(false));
        if (codeSale) {
            ledger.flagForReview(tx, "The reference " + reference + " names a code sale. Code sales are not matched to bank money automatically yet, "
                    + "so this payment stays confirmed and unmatched for review.");
            return;
        }
        if (request.isPresent() && !request.get().getId().equals(tx.getPaymentRequestId())) {
            tx.linkRequest(request.get().getId(), clock.instant());
            transactions.saveAndFlush(tx);
            audit.recordLedger(merchantId, null, "REFERENCE_MATCHED", tx.getId(), null,
                    "The reference " + reference + " exactly matches a payment request.");
        }
        // An invoice request names its invoice; otherwise the exact invoice number may be the reference.
        Optional<UUID> invoiceId = request.flatMap(r -> Optional.ofNullable(r.getInvoiceId()))
                .or(() -> invoices.findByMerchantIdAndInvoiceNumber(merchantId, reference).map(Invoice::getId));
        if (invoiceId.isEmpty()) {
            if (request.isPresent()) {
                // An open request with no invoice: confirmed money stays a merchant collection.
                notifications.collected(tx);
                return;
            }
            ledger.flagForReview(tx, "The reference does not match any invoice or payment request.");
            notifications.unmatched(tx);
            return;
        }
        Invoice invoice = invoices.lockByIdAndMerchantId(invoiceId.get(), merchantId).orElseThrow();
        long remaining = ledger.remainingOf(invoice);
        if (invoice.getStatus() != InvoiceStatus.ISSUED) {
            ledger.flagForReview(tx, "Invoice " + invoice.getInvoiceNumber() + " is " + invoice.getStatus().name().toLowerCase(Locale.ROOT)
                    + " and cannot receive payments.");
            return;
        }
        if (remaining == 0) {
            ledger.flagForReview(tx, "Invoice " + invoice.getInvoiceNumber() + " is already fully paid; this looks like an overpayment.");
            return;
        }
        // Overpayment protection: apply no more than the invoice owes, flag the rest.
        long toApply = Math.min(tx.getAmountRwf(), remaining);
        ledger.allocate(tx, invoice, toApply, PaymentAllocation.Origin.AUTO_REFERENCE, null, null);
        notifications.invoiceAllocated(tx, invoice, toApply, remaining - toApply);
        if (toApply < tx.getAmountRwf()) {
            ledger.flagForReview(tx, "Overpayment: RWF " + (tx.getAmountRwf() - toApply) + " could not be applied to " + invoice.getInvoiceNumber() + ".");
        }
    }

    private Optional<UUID> findTransactionId(NormalizedBankEvent event) {
        return jdbc.sql("select id from bank_transactions where provider_id = :p and provider_transaction_id = :t")
                .param("p", event.providerId().name()).param("t", event.providerTransactionId()).query(UUID.class).optional();
    }

    /** The single permitted edit of a raw event: RECEIVED to its final outcome. */
    private void finish(NormalizedBankEvent event, UUID merchantId, Outcome outcome, String reason) {
        jdbc.sql("update bank_events set outcome = :o, outcome_reason = :r, merchant_id = :m, processed_at = :now "
                        + "where provider_id = :p and provider_event_id = :e and outcome = 'RECEIVED'")
                .param("o", outcome.name()).param("r", reason).param("m", merchantId).param("now", Timestamp.from(clock.instant()))
                .param("p", event.providerId().name()).param("e", event.providerEventId()).update();
        if (outcome != Outcome.APPLIED) {
            // Never log payloads, payer names or references: ids and outcomes only.
            log.info("Bank event {} for provider {} finished as {}", event.providerEventId(), event.providerId(), outcome);
        }
    }
}
