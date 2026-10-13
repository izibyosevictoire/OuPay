package rw.oupay.payment;

import java.time.Clock;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.stereotype.Component;
import rw.oupay.invoice.Invoice;
import rw.oupay.invoice.InvoiceRepository;
import rw.oupay.ledger.BankTransaction;
import rw.oupay.ledger.BankTransactionRepository;
import rw.oupay.ledger.InvoiceBalanceReader;
import rw.oupay.ledger.PaymentAllocation;
import rw.oupay.ledger.PaymentAllocationRepository;

/** Builds the derived state of a request from the ledger: its linked transactions and invoice balance. */
@Component
public class PaymentRequestResolver {

    public record Resolved(PaymentRequest request, PaymentRequestState.State state, String invoiceNumber) {}

    private final BankTransactionRepository transactions;
    private final PaymentAllocationRepository allocations;
    private final InvoiceRepository invoices;
    private final InvoiceBalanceReader balances;
    private final Clock clock;

    public PaymentRequestResolver(BankTransactionRepository transactions, PaymentAllocationRepository allocations,
                                  InvoiceRepository invoices, InvoiceBalanceReader balances, Clock clock) {
        this.transactions = transactions;
        this.allocations = allocations;
        this.invoices = invoices;
        this.balances = balances;
        this.clock = clock;
    }

    public Resolved resolve(PaymentRequest request) {
        // Linked by an EXACT reference match, never by amount or time.
        List<BankTransaction> linked = transactions.findForRequest(request.getMerchantId(), request.getId(), request.getPublicReference());
        Set<UUID> withAllocation = allocations.findByTransactionIds(linked.stream().map(BankTransaction::getId).toList()).stream()
                .filter(PaymentAllocation::isActive).map(PaymentAllocation::getBankTransactionId).collect(Collectors.toSet());
        Invoice invoice = request.getInvoiceId() == null ? null : invoices.findById(request.getInvoiceId()).orElse(null);
        var facts = invoice == null ? null
                : new PaymentRequestState.InvoiceFacts(invoice.getStatus(), invoice.getGrandTotalRwf(), balances.allocated(invoice.getId()));
        var state = PaymentRequestState.derive(
                new PaymentRequestState.Request(request.getRequestedAmountRwf(), request.getExpiresAt(), request.getCancelledAt(),
                        request.getInstructionsOpenedAt() != null, request.getCustomerClaimedAt() != null),
                linked.stream().map(t -> new PaymentRequestState.LinkedTransaction(t.getStatus(), t.isIncoming(), t.getAmountRwf(),
                        withAllocation.contains(t.getId()))).toList(),
                facts, clock.instant());
        return new Resolved(request, state, invoice == null ? null : invoice.getInvoiceNumber());
    }
}
