package rw.oupay.ledger;

import java.time.Clock;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditLog;
import rw.oupay.audit.AuditLogRepository;
import rw.oupay.audit.AuditService;
import rw.oupay.banking.BankConnectionRepository;
import rw.oupay.common.ApiException;
import rw.oupay.common.Pagination;
import rw.oupay.invoice.Invoice;
import rw.oupay.invoice.InvoiceRepository;
import rw.oupay.invoice.InvoiceStatus;
import rw.oupay.membership.Actor;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.membership.Permission;
import rw.oupay.notification.NotificationService;

/**
 * Merchant-facing view of the ledger and the ONLY ways a person may change it.
 *
 * <p>There is deliberately NO method that creates a bank transaction, confirms a payment or marks an
 * invoice paid: bank confirmation can only come from the trusted provider boundary
 * ({@link BankEventProcessor}). People can only (a) apply already-confirmed money to invoices,
 * (b) correct an allocation, and (c) record that they reviewed something.
 *
 * <p>Cashiers see only transactions applied to invoices assigned to them, with no unapplied or
 * unmatched figures: the restriction is applied here, in the service, not in the controller.
 */
@Service
public class ReconciliationService {

    private final BankTransactionRepository transactions;
    private final PaymentAllocationRepository allocations;
    private final InvoiceRepository invoices;
    private final BankConnectionRepository connections;
    private final AuditLogRepository auditLog;
    private final LedgerOperations ledger;
    private final CodeSaleAllocationPolicy codeSalePolicy;
    private final NotificationService notifications;
    private final MerchantAccess access;
    private final AuditService audit;
    private final Clock clock;

    public ReconciliationService(BankTransactionRepository transactions, PaymentAllocationRepository allocations,
                                 InvoiceRepository invoices, BankConnectionRepository connections, AuditLogRepository auditLog,
                                 LedgerOperations ledger, CodeSaleAllocationPolicy codeSalePolicy, NotificationService notifications, MerchantAccess access,
                                 AuditService audit, Clock clock) {
        this.transactions = transactions;
        this.allocations = allocations;
        this.invoices = invoices;
        this.connections = connections;
        this.auditLog = auditLog;
        this.ledger = ledger;
        this.codeSalePolicy = codeSalePolicy;
        this.notifications = notifications;
        this.access = access;
        this.audit = audit;
        this.clock = clock;
    }

    // ---- reads ---------------------------------------------------------------------------------

    @Transactional(readOnly = true)
    public Pagination.Page<ReconciliationDtos.BankTransactionView> listTransactions(UUID merchantId, Integer limit, String cursor) {
        Actor actor = access.require(merchantId, Permission.TRANSACTIONS_VIEW);
        UUID restrict = scopeUser(actor, Permission.TRANSACTIONS_VIEW);
        int size = Pagination.limit(limit);
        var position = Pagination.decode(cursor);
        List<BankTransaction> fetched = restrict == null
                ? transactions.pageForMerchant(merchantId, position.at(), position.id(), Pagination.fetch(size))
                : transactions.pageForAssignee(merchantId, restrict, position.at(), position.id(), Pagination.fetch(size));
        var page = Pagination.page(fetched, size, BankTransaction::getProviderOccurredAt, BankTransaction::getId, null);
        return new Pagination.Page<>(buildViews(merchantId, page.items(), restrict), page.nextCursor(), null);
    }

    @Transactional(readOnly = true)
    public ReconciliationDtos.Details details(UUID merchantId, UUID transactionId) {
        Actor actor = access.require(merchantId, Permission.TRANSACTIONS_VIEW);
        return detailsOf(merchantId, transactionId, scopeUser(actor, Permission.TRANSACTIONS_VIEW));
    }

    @Transactional(readOnly = true)
    public Pagination.Page<ReconciliationDtos.AllocationView> listAllocations(UUID merchantId, Integer limit, String cursor) {
        Actor actor = access.require(merchantId, Permission.PAYMENTS_VIEW_CONFIRMATIONS);
        UUID restrict = scopeUser(actor, Permission.PAYMENTS_VIEW_CONFIRMATIONS);
        int size = Pagination.limit(limit);
        var position = Pagination.decode(cursor);
        List<PaymentAllocation> fetched = restrict == null
                ? allocations.pageForMerchant(merchantId, position.at(), position.id(), Pagination.fetch(size))
                : allocations.pageForAssignee(merchantId, restrict, position.at(), position.id(), Pagination.fetch(size));
        var page = Pagination.page(fetched, size, PaymentAllocation::getCreatedAt, PaymentAllocation::getId, null);
        return new Pagination.Page<>(toAllocationViews(merchantId, page.items(), restrict), page.nextCursor(), null);
    }

    @Transactional(readOnly = true)
    public List<ReconciliationDtos.PayableInvoice> payableInvoices(UUID merchantId) {
        access.require(merchantId, Permission.PAYMENTS_RECONCILE);
        // A demonstration code sale takes no real payment, so it is never offered as something bank money can be applied to.
        List<Invoice> issued = invoices.findAllForMerchant(merchantId).stream().filter(i -> i.getStatus() == InvoiceStatus.ISSUED)
                .filter(i -> !codeSalePolicy.isDemonstration(i)).toList();
        Map<UUID, Long> allocated = allocatedByInvoice(issued.stream().map(Invoice::getId).toList());
        return issued.stream()
                .map(i -> new ReconciliationDtos.PayableInvoice(i.getId(), i.getInvoiceNumber(), i.getCustomerName(), i.getGrandTotalRwf(),
                        LedgerMath.summarize(i.getGrandTotalRwf(), allocated.getOrDefault(i.getId(), 0L)).remainingBalance()))
                .filter(p -> p.remainingBalance() > 0)
                .sorted(Comparator.comparing(ReconciliationDtos.PayableInvoice::invoiceNumber))
                .toList();
    }

    /** At least ten characters and more than a repeated character: "ok", "..........", "aaaaaaaaaa" are not reasons. */
    static void requireMeaningfulReason(String note) {
        String reason = note == null ? "" : note.trim();
        if (reason.length() < 10 || reason.chars().distinct().count() < 4) {
            throw new ApiException(org.springframework.http.HttpStatus.UNPROCESSABLE_CONTENT, "reconciliation_reason_required",
                    "Applying money to a code sale by hand needs a reason of at least ten characters (for example what evidence you checked).");
        }
    }

    // ---- writes (authorised people only; never confirm a payment) ------------------------------

    /**
     * Applies confirmed, unapplied money to one or more invoices. Rejected with allocation_conflict if
     * anyone changed the transaction or an invoice balance since the caller loaded them, and never
     * allowed to exceed what is owed or what is unapplied. Everything is validated BEFORE anything is
     * applied, inside one database transaction, so a failing line can never leave a half-applied split.
     */
    @Transactional
    public ReconciliationDtos.Details allocateManually(UUID merchantId, ReconciliationDtos.ManualAllocationRequest request) {
        Actor actor = access.require(merchantId, Permission.PAYMENTS_RECONCILE);
        // Lock order: the transaction first, then invoices in id order (same as the event processor).
        BankTransaction tx = transactions.lockByIdAndMerchantId(request.bankTransactionId(), merchantId)
                .orElseThrow(() -> ApiException.notFound("This transaction could not be found."));
        if (tx.getVersion() != request.expectedTransactionVersion()) {
            throw ApiException.conflict("allocation_conflict",
                    "This transaction changed since you opened it. Reload it and check the figures again.");
        }
        Set<UUID> distinct = new HashSet<>();
        for (var line : request.allocations()) {
            if (!distinct.add(line.invoiceId())) {
                throw ApiException.validation("An invoice can only appear once.");
            }
        }
        List<UUID> sortedIds = request.allocations().stream().map(ReconciliationDtos.AllocationLine::invoiceId).sorted().toList();
        Map<UUID, Invoice> locked = new java.util.LinkedHashMap<>();
        for (UUID id : sortedIds) {
            locked.put(id, invoices.lockByIdAndMerchantId(id, merchantId).orElseThrow(() -> ApiException.notFound("An invoice could not be found.")));
        }

        // A person applying money to a CODE sale replaces the bank evidence that automatic matching would have had, so they must say why. The reason
        // is written, with their identity, to the immutable audit trail in the SAME transaction as the allocation (no reason, no allocation).
        // Ordinary invoices keep their existing, optional note.
        if (locked.values().stream().anyMatch(codeSalePolicy::isCodeSale)) {
            // What can never be allowed, whatever the reason (a demonstration, contradicting bank evidence), is refused FIRST, so a reason is
            // never asked for something that is not available at all.
            for (Invoice invoice : locked.values()) {
                if (codeSalePolicy.isCodeSale(invoice)) {
                    codeSalePolicy.requireAllowed(tx, invoice, PaymentAllocation.Origin.MANUAL);
                }
            }
            requireMeaningfulReason(request.note());
        }

        long unapplied = LedgerMath.unapplied(tx.getStatus(), tx.isIncoming(), tx.getAmountRwf(), ledger.allocatedOfTransaction(tx.getId()));
        long total = 0;
        for (var line : request.allocations()) {
            Invoice invoice = locked.get(line.invoiceId());
            long remaining = ledger.remainingOf(invoice);
            if (remaining != line.expectedRemainingBalance()) {
                throw ApiException.conflict("allocation_conflict",
                        "Invoice " + invoice.getInvoiceNumber() + " changed since you opened it. Reload and check its balance.");
            }
            if (invoice.getStatus() != InvoiceStatus.ISSUED) {
                throw LedgerRuleException.invoiceNotPayable(invoice.getInvoiceNumber());
            }
            codeSalePolicy.requireAllowed(tx, invoice, PaymentAllocation.Origin.MANUAL);
            if (line.amount() <= 0) {
                throw ApiException.validation("Amounts must be positive whole numbers of francs.");
            }
            if (line.amount() > remaining) {
                throw LedgerRuleException.exceedsRemaining(invoice.getInvoiceNumber(), remaining);
            }
            total = Math.addExact(total, line.amount());
        }
        if (total > unapplied) {
            throw LedgerRuleException.exceedsUnapplied();
        }

        for (UUID id : sortedIds) {
            var line = request.allocations().stream().filter(l -> l.invoiceId().equals(id)).findFirst().orElseThrow();
            Invoice invoice = locked.get(id);
            long remainingBefore = ledger.remainingOf(invoice);
            ledger.allocate(tx, invoice, line.amount(), PaymentAllocation.Origin.MANUAL, actor.userId(), request.note());
            notifications.invoiceAllocated(tx, invoice, line.amount(), remainingBefore - line.amount());
        }
        if (LedgerMath.unapplied(tx.getStatus(), tx.isIncoming(), tx.getAmountRwf(), ledger.allocatedOfTransaction(tx.getId())) == 0
                && tx.getReviewState() == ReviewState.NEEDS_REVIEW) {
            tx.markReviewed(request.note(), clock.instant());
        }
        transactions.flush();
        return detailsOf(merchantId, tx.getId(), null);
    }

    /** Corrects a wrong allocation. History is kept; the invoice balance is restored. */
    @Transactional
    public ReconciliationDtos.Details reverseAllocation(UUID merchantId, UUID allocationId, String reason) {
        Actor actor = access.require(merchantId, Permission.PAYMENTS_RECONCILE);
        PaymentAllocation found = allocations.findById(allocationId).filter(a -> a.getMerchantId().equals(merchantId))
                .orElseThrow(() -> ApiException.notFound("This allocation could not be found."));
        // Same lock order as everywhere else: the transaction row first.
        transactions.lockByIdAndMerchantId(found.getBankTransactionId(), merchantId).orElseThrow();
        PaymentAllocation allocation = allocations.findById(allocationId).orElseThrow();
        ledger.reverse(allocation, PaymentAllocation.ReversalKind.MANUAL_CORRECTION, reason.trim(), actor.userId());
        transactions.flush();
        return detailsOf(merchantId, allocation.getBankTransactionId(), null);
    }

    /** Records that a person looked at a flagged or unmatched transaction. Moves no money. */
    @Transactional
    public ReconciliationDtos.Details markReviewed(UUID merchantId, UUID transactionId, String note, long expectedVersion) {
        Actor actor = access.require(merchantId, Permission.PAYMENTS_RECONCILE);
        BankTransaction tx = transactions.lockByIdAndMerchantId(transactionId, merchantId)
                .orElseThrow(() -> ApiException.notFound("This transaction could not be found."));
        if (tx.getVersion() != expectedVersion) {
            throw ApiException.conflict("allocation_conflict", "This transaction changed since you opened it. Reload it first.");
        }
        long allocated = ledger.allocatedOfTransaction(tx.getId());
        var status = LedgerMath.reconciliationStatus(tx.getStatus(), tx.getAmountRwf(), allocated, tx.getPaymentRequestId() != null);
        if (!LedgerMath.requiresReview(tx.getStatus(), tx.getReviewState(), status)) {
            throw ApiException.invalidState("invalid_state", "This transaction does not need review.");
        }
        tx.markReviewed(note.trim(), clock.instant());
        audit.recordLedger(merchantId, actor.userId(), "MARKED_REVIEWED", tx.getId(), null, "Reviewed: " + note.trim());
        transactions.flush();
        return detailsOf(merchantId, transactionId, null);
    }

    // ---- read models ---------------------------------------------------------------------------

    /** Null for full scope; the user id a cashier's reads must be restricted to otherwise. */
    private UUID scopeUser(Actor actor, Permission permission) {
        return actor.hasFullScope(permission) ? null : actor.userId();
    }

    private Map<UUID, Long> allocatedByInvoice(List<UUID> ids) {
        Map<UUID, Long> result = new java.util.HashMap<>();
        for (UUID id : ids) {
            result.put(id, allocations.findActiveByInvoice(id).stream().mapToLong(PaymentAllocation::getAmountRwf).sum());
        }
        return result;
    }

    /** Every transaction of the business (dashboard aggregates). The paged endpoints use {@link #pageTransactions}. */
    public List<ReconciliationDtos.BankTransactionView> views(UUID merchantId, UUID restrictToUserId) {
        return buildViews(merchantId, transactions.findAllForMerchant(merchantId), restrictToUserId);
    }

    /** Builds read models for exactly these transactions: allocations and invoices are loaded for them only. */
    private List<ReconciliationDtos.BankTransactionView> buildViews(UUID merchantId, List<BankTransaction> txs, UUID restrictToUserId) {
        if (txs.isEmpty()) {
            return List.of();
        }
        Map<UUID, List<PaymentAllocation>> byTransaction = allocations.findByTransactionIds(txs.stream().map(BankTransaction::getId).toList()).stream()
                .collect(Collectors.groupingBy(PaymentAllocation::getBankTransactionId));
        Set<UUID> invoiceIds = byTransaction.values().stream().flatMap(List::stream).map(PaymentAllocation::getInvoiceId).collect(Collectors.toSet());
        Map<UUID, Invoice> invoicesById = invoiceIds.isEmpty() ? Map.of()
                : invoices.findAllByIdsAndMerchant(invoiceIds, merchantId).stream().collect(Collectors.toMap(Invoice::getId, Function.identity()));
        Map<UUID, String> accounts = connections.findByMerchantIdOrderByCreatedAtAsc(merchantId).stream()
                .collect(Collectors.toMap(c -> c.getId(), c -> c.getProviderAccountId() == null ? "" : c.getProviderAccountId()));
        List<ReconciliationDtos.BankTransactionView> result = new ArrayList<>();
        for (BankTransaction tx : txs) {
            List<PaymentAllocation> own = byTransaction.getOrDefault(tx.getId(), List.of());
            if (restrictToUserId != null) {
                own = own.stream().filter(a -> restrictToUserId.equals(invoicesById.get(a.getInvoiceId()).getAssignedToUserId())).toList();
                // A cashier never sees money that is not applied to one of their invoices.
                if (own.isEmpty()) {
                    continue;
                }
            }
            result.add(toView(tx, own, invoicesById, accounts.getOrDefault(tx.getBankConnectionId(), ""), restrictToUserId != null));
        }
        return result;
    }

    private ReconciliationDtos.BankTransactionView toView(BankTransaction tx, List<PaymentAllocation> own, Map<UUID, Invoice> invoicesById,
                                                          String account, boolean scoped) {
        long activeSum = own.stream().filter(PaymentAllocation::isActive).mapToLong(PaymentAllocation::getAmountRwf).sum();
        List<ReconciliationDtos.InvoiceLink> links = own.stream()
                .map(a -> new ReconciliationDtos.InvoiceLink(a.getInvoiceId(), invoicesById.get(a.getInvoiceId()).getInvoiceNumber(),
                        a.getAmountRwf(), a.getStatus()))
                .toList();
        // Verified by allocation to their invoice, never read off the bank event.
        List<String> cashiers = own.stream().filter(PaymentAllocation::isActive)
                .map(a -> invoicesById.get(a.getInvoiceId()).getAssignedToName()).distinct().toList();
        return new ReconciliationDtos.BankTransactionView(tx.getId(), tx.getMerchantId(), account, tx.getProviderId(),
                tx.getProviderTransactionId(), tx.getLastProviderEventId(), tx.getDirection(), tx.getAmountRwf(), "RWF",
                tx.getPaymentReference(), tx.getPayerDisplayName(), tx.getProviderOccurredAt(), tx.getReceivedAt(), tx.getStatus(),
                tx.getCreatedAt(), tx.getUpdatedAt(), tx.isSimulated(), tx.getStatusAppliedAt(), tx.getPaymentRequestId(),
                tx.getReviewState(), tx.getReviewReason(), tx.getReviewNote(), tx.getVersion(), activeSum,
                // For a scoped (cashier) view the unapplied figure would reveal other people's money.
                scoped ? 0 : LedgerMath.unapplied(tx.getStatus(), tx.isIncoming(), tx.getAmountRwf(), activeSum),
                LedgerMath.reconciliationStatus(tx.getStatus(), tx.getAmountRwf(), activeSum, tx.getPaymentRequestId() != null),
                links, cashiers);
    }

    /** Allocation read models for exactly these allocations (invoices and transactions loaded for them only). */
    private List<ReconciliationDtos.AllocationView> toAllocationViews(UUID merchantId, List<PaymentAllocation> list, UUID restrictToUserId) {
        if (list.isEmpty()) {
            return List.of();
        }
        Map<UUID, Invoice> invoicesById = invoices.findAllByIdsAndMerchant(
                list.stream().map(PaymentAllocation::getInvoiceId).collect(Collectors.toSet()), merchantId).stream()
                .collect(Collectors.toMap(Invoice::getId, Function.identity()));
        Map<UUID, BankTransaction> txById = transactions.findAllById(list.stream().map(PaymentAllocation::getBankTransactionId).collect(Collectors.toSet()))
                .stream().collect(Collectors.toMap(BankTransaction::getId, Function.identity()));
        return list.stream()
                .filter(a -> restrictToUserId == null || restrictToUserId.equals(invoicesById.get(a.getInvoiceId()).getAssignedToUserId()))
                .map(a -> {
                    Invoice invoice = invoicesById.get(a.getInvoiceId());
                    BankTransaction tx = txById.get(a.getBankTransactionId());
                    return new ReconciliationDtos.AllocationView(a.getId(), a.getMerchantId(), a.getBankTransactionId(), a.getInvoiceId(),
                            a.getAmountRwf(), a.getStatus(), a.getOrigin(), a.getCreatedByUserId(), a.getCreatedAt(), a.getReversedAt(),
                            a.getReversedByUserId(), a.getReversalKind(), a.getReversalReason(), invoice.getInvoiceNumber(),
                            invoice.getCustomerName(), tx.getPaymentReference(), tx.getAmountRwf(), tx.isSimulated());
                })
                .toList();
    }

    private ReconciliationDtos.Details detailsOf(UUID merchantId, UUID transactionId, UUID restrictToUserId) {
        BankTransaction tx = transactions.findByIdAndMerchantId(transactionId, merchantId)
                .orElseThrow(() -> ApiException.notFound("This transaction could not be found."));
        var transaction = buildViews(merchantId, List.of(tx), restrictToUserId).stream().findFirst()
                .orElseThrow(() -> ApiException.notFound("This transaction could not be found."));
        var txAllocations = toAllocationViews(merchantId,
                allocations.findByBankTransactionId(transactionId).stream().sorted(Comparator.comparing(PaymentAllocation::getCreatedAt).reversed()).toList(),
                restrictToUserId);
        Set<UUID> ownInvoices = txAllocations.stream().map(ReconciliationDtos.AllocationView::invoiceId).collect(Collectors.toSet());
        // Cashiers see the audit entries of their own invoices only; staff-level history stays private.
        List<ReconciliationDtos.AuditEntry> history = auditLog.findByMerchantIdAndBankTransactionIdOrderByIdAsc(merchantId, transactionId).stream()
                .filter(e -> restrictToUserId == null || (e.getInvoiceId() != null && ownInvoices.contains(e.getInvoiceId())))
                .map(ReconciliationService::toEntry).toList();
        return new ReconciliationDtos.Details(transaction, txAllocations, history);
    }

    private static ReconciliationDtos.AuditEntry toEntry(AuditLog e) {
        return new ReconciliationDtos.AuditEntry(e.getId(), e.getMerchantId(), e.getBankTransactionId(), e.getInvoiceId(), e.getKind(),
                e.getActorUserId(), e.getMessage(), e.getCreatedAt());
    }
}
