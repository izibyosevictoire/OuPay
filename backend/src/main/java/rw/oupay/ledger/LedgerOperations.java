package rw.oupay.ledger;

import java.time.Clock;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.invoice.Invoice;
import rw.oupay.invoice.InvoiceRepository;
import rw.oupay.invoice.InvoiceStatus;
import rw.oupay.notification.NotificationService;

/**
 * The only code allowed to change allocations. Used by the trusted event processor and by
 * authorised manual reconciliation; both go through the same rules, so one transaction can never be
 * counted twice and an invoice can never be overpaid.
 *
 * <p>Every method requires an ENCLOSING database transaction and expects the caller to have already
 * locked the bank transaction row and then the invoice rows (lock order: transaction, invoices in id
 * order). The PostgreSQL triggers re-check the same rules as the last line of defence.
 */
@Component
public class LedgerOperations {

    private final PaymentAllocationRepository allocations;
    private final CodeSaleAllocationPolicy codeSales;
    private final BankTransactionRepository transactions;
    private final InvoiceBalanceReader balances;
    private final InvoiceRepository invoices;
    private final AuditService audit;
    private final NotificationService notifications;
    private final FinancialMetrics metrics;
    private final Clock clock;

    public LedgerOperations(PaymentAllocationRepository allocations, CodeSaleAllocationPolicy codeSales, BankTransactionRepository transactions,
                            InvoiceBalanceReader balances, InvoiceRepository invoices, AuditService audit,
                            NotificationService notifications, FinancialMetrics metrics, Clock clock) {
        this.allocations = allocations;
        this.codeSales = codeSales;
        this.transactions = transactions;
        this.balances = balances;
        this.invoices = invoices;
        this.audit = audit;
        this.notifications = notifications;
        this.metrics = metrics;
        this.clock = clock;
    }

    public long allocatedOfTransaction(UUID transactionId) {
        return allocations.findByBankTransactionId(transactionId).stream()
                .filter(PaymentAllocation::isActive).mapToLong(PaymentAllocation::getAmountRwf).sum();
    }

    public long remainingOf(Invoice invoice) {
        return LedgerMath.summarize(invoice.getGrandTotalRwf(), balances.allocated(invoice.getId())).remainingBalance();
    }

    /**
     * Applies confirmed money to an invoice: the money must be CONFIRMED, the invoice ISSUED, and the
     * amount must fit both what is left of the transaction and what the invoice still owes.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public PaymentAllocation allocate(BankTransaction tx, Invoice invoice, long amount, PaymentAllocation.Origin origin,
                                      UUID actorUserId, String note) {
        if (tx.getStatus() != BankTransactionStatus.CONFIRMED || !tx.isIncoming()) {
            throw LedgerRuleException.notConfirmed();
        }
        if (!invoice.getMerchantId().equals(tx.getMerchantId()) || invoice.getStatus() != InvoiceStatus.ISSUED) {
            throw LedgerRuleException.invoiceNotPayable(invoice.getInvoiceNumber());
        }
        // A demonstration code sale never takes bank money, and no code sale is matched automatically (the database trigger says the same).
        codeSales.requireAllowed(invoice, origin);
        if (amount <= 0) {
            throw new LedgerRuleException("validation", "The amount must be a positive whole number of francs.");
        }
        long remaining = remainingOf(invoice);
        if (amount > remaining) {
            throw LedgerRuleException.exceedsRemaining(invoice.getInvoiceNumber(), remaining);
        }
        if (amount > tx.getAmountRwf() - allocatedOfTransaction(tx.getId())) {
            throw LedgerRuleException.exceedsUnapplied();
        }
        PaymentAllocation allocation = new PaymentAllocation(UUID.randomUUID(), tx.getMerchantId(), tx.getId(), invoice.getId(),
                amount, origin, actorUserId, clock.instant());
        // The database trigger re-checks the same rules under its own row locks.
        allocations.saveAndFlush(allocation);
        tx.touch(clock.instant());
        audit.recordLedger(tx.getMerchantId(), actorUserId, origin == PaymentAllocation.Origin.MANUAL ? "MANUAL_ALLOCATED" : "AUTO_ALLOCATED",
                tx.getId(), invoice.getId(),
                (origin == PaymentAllocation.Origin.MANUAL ? "Manually" : "Automatically") + " applied RWF " + amount + " to invoice "
                        + invoice.getInvoiceNumber() + "." + (note == null || note.isBlank() ? "" : " Note: " + note));
        metrics.allocated(origin.name(), amount, tx.getMerchantId(), tx.getId(), invoice.getId());
        return allocation;
    }

    /** Reverses one allocation (it stops counting), restoring the invoice balance. History stays. */
    @Transactional(propagation = Propagation.MANDATORY)
    public PaymentAllocation reverse(PaymentAllocation allocation, PaymentAllocation.ReversalKind kind, String reason, UUID actorUserId) {
        if (!allocation.isActive()) {
            throw LedgerRuleException.allocationNotActive();
        }
        allocation.reverse(kind, reason, actorUserId, clock.instant());
        allocations.saveAndFlush(allocation);
        transactions.findById(allocation.getBankTransactionId()).ifPresent(t -> t.touch(clock.instant()));
        audit.recordLedger(allocation.getMerchantId(), actorUserId, "ALLOCATION_REVERSED", allocation.getBankTransactionId(),
                allocation.getInvoiceId(), "Reversed the allocation of RWF " + allocation.getAmountRwf() + " (" + reason + ").");
        metrics.reversed(kind.name(), allocation.getAmountRwf(), allocation.getMerchantId(), allocation.getBankTransactionId(),
                allocation.getInvoiceId());
        return allocation;
    }

    /** A bank reversal: every active allocation of the transaction is reversed, then people are told. */
    @Transactional(propagation = Propagation.MANDATORY)
    public void reverseAllOf(BankTransaction tx) {
        List<PaymentAllocation> active = allocations.findByBankTransactionId(tx.getId()).stream().filter(PaymentAllocation::isActive).toList();
        List<Invoice> affected = new java.util.ArrayList<>();
        for (PaymentAllocation a : active) {
            reverse(a, PaymentAllocation.ReversalKind.BANK_REVERSAL, "The bank reversed the transaction.", null);
            invoices.findById(a.getInvoiceId()).ifPresent(affected::add);
        }
        audit.recordLedger(tx.getMerchantId(), null, "BANK_REVERSAL", tx.getId(), null,
                "The bank reversed this transaction; its allocations were reversed and invoice balances restored.");
        notifications.reversed(tx, affected);
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void flagForReview(BankTransaction tx, String reason) {
        tx.flagForReview(reason, clock.instant());
        audit.recordLedger(tx.getMerchantId(), null, "FLAGGED_FOR_REVIEW", tx.getId(), null, reason);
        metrics.flaggedForReview(tx.getMerchantId(), tx.getId());
        notifications.needsReview(tx, reason);
    }
}
