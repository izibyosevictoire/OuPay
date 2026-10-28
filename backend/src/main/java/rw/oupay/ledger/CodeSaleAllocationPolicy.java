package rw.oupay.ledger;

import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import rw.oupay.invoice.Invoice;
import rw.oupay.invoice.SaleChannel;

/**
 * Whether bank money may be applied to a CODE sale, and by which route. The same rules the database enforces by trigger
 * ({@code guard_code_sale_allocation}, V15), checked here first so the caller gets a clear refusal instead of a constraint error, and so the
 * automatic matcher and the manual reconciliation use ONE definition:
 * <ul>
 *   <li>a DEMONSTRATION sale never receives bank money, by any route; only a LIVE sale can;</li>
 *   <li><b>every origin</b>: the money must have reached the sale's own settlement account; a final attribution CONFLICT is never overridden;
 *       a bank-reported code must have resolved to the sale's own code (an unresolved or different one is never ignored); a reference that
 *       names another code sale rules this one out;</li>
 *   <li><b>AUTOMATIC</b> additionally needs all the evidence: code resolved to the sale's code, the agent confirmed from the sale's snapshot
 *       (sale, code and account agree), the sale named by the exact reference and matched to the transaction, and the transaction's reference
 *       equal to the sale's own unique reference. Amount, time, payer, agent and a code alone are never enough;</li>
 *   <li><b>MANUAL</b> keeps those safeguards but does not need a reported code: an authorised person supplies the evidence, audited.</li>
 * </ul>
 * Traditional and simplified invoices are untouched.
 */
@Component
public class CodeSaleAllocationPolicy {

    private record Sale(UUID requestId, UUID codeId, UUID destinationId, String mode, String reference) {}

    private record Evidence(String status, String agent, UUID codeId, UUID destinationId, UUID referencedSaleId, UUID paymentRequestId,
                            String reportedCode, String reference) {}

    private final JdbcClient jdbc;

    public CodeSaleAllocationPolicy(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    /** True for an invoice that was billed through a collection code, whatever the mode of the sale. */
    public boolean isCodeSale(Invoice invoice) {
        return invoice.getSaleChannel() == SaleChannel.CODE;
    }

    /** The invoice's own flag, fixed when it was created and kept equal to the sale's mode by the database. */
    public boolean isDemonstration(Invoice invoice) {
        return invoice.isDemonstration();
    }

    /** @throws LedgerRuleException when this origin of allocation is not allowed for this invoice */
    public void requireAllowed(BankTransaction tx, Invoice invoice, PaymentAllocation.Origin origin) {
        String problem = problem(tx, invoice, origin);
        if (problem == null) {
            return;
        }
        throw isDemonstration(invoice) ? LedgerRuleException.codeSaleNotPayable(invoice.getInvoiceNumber(), true)
                : LedgerRuleException.codeSaleEvidence(invoice.getInvoiceNumber(), problem);
    }

    /** The first reason this allocation is not allowed, in plain words, or null when it is. Ordinary invoices always return null. */
    public String problem(BankTransaction tx, Invoice invoice, PaymentAllocation.Origin origin) {
        return problem(tx, invoice, origin, true);
    }

    /**
     * @param linkRequired false only for the matcher's own pre-check: it verifies everything EXCEPT the link between the transaction and the
     *                     sale's payment request, because making that link is exactly what a successful match does (the database trigger then
     *                     requires it for the allocation itself)
     */
    public String problem(BankTransaction tx, Invoice invoice, PaymentAllocation.Origin origin, boolean linkRequired) {
        if (!isCodeSale(invoice)) {
            return null;
        }
        if (isDemonstration(invoice)) {
            return "it is a demonstration sale, which takes no real payment";
        }
        Sale sale = jdbc.sql("select payment_request_id, collection_code_id, settlement_destination_id, presentation_mode, sale_reference "
                        + "from code_sales where invoice_id = :i and merchant_id = :m")
                .param("i", invoice.getId()).param("m", invoice.getMerchantId())
                .query((rs, n) -> new Sale(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getObject(3, UUID.class), rs.getString(4), rs.getString(5)))
                .optional().orElse(null);
        if (sale == null || !"LIVE".equals(sale.mode())) {
            return "only a live code sale can receive bank money";
        }
        Evidence e = jdbc.sql("select attribution_status, agent_attribution, collection_code_id, settlement_destination_id, referenced_code_sale_id, "
                        + "payment_request_id, reported_code, payment_reference from bank_transactions where id = :t and merchant_id = :m")
                .param("t", tx.getId()).param("m", invoice.getMerchantId())
                .query((rs, n) -> new Evidence(rs.getString(1), rs.getString(2), rs.getObject(3, UUID.class), rs.getObject(4, UUID.class),
                        rs.getObject(5, UUID.class), rs.getObject(6, UUID.class), rs.getString(7), rs.getString(8)))
                .optional().orElse(null);
        if (e == null) {
            return "the bank transaction and the code sale must belong to the same business";
        }
        if ("CONFLICT".equals(e.status())) {
            return "the bank evidence conflicts with itself (a final attribution conflict), so it needs investigation first";
        }
        if (e.destinationId() == null || !e.destinationId().equals(sale.destinationId())) {
            return "the money did not reach the settlement account of this code sale";
        }
        if (e.reportedCode() != null && (!"RESOLVED".equals(e.status()) || !sale.codeId().equals(e.codeId()))) {
            return "the bank-reported code does not resolve to the code of this sale";
        }
        if (e.referencedSaleId() != null && !e.referencedSaleId().equals(sale.requestId())) {
            return "the payment names a different code sale";
        }
        if (origin == PaymentAllocation.Origin.MANUAL) {
            return null;
        }
        if (!"RESOLVED".equals(e.status())) {
            return e.reportedCode() == null ? "the bank reported no collection code" : "the reported code is not resolved";
        }
        if (!"CONFIRMED_FROM_SALE_SNAPSHOT".equals(e.agent()) || !sale.codeId().equals(e.codeId())) {
            return "the sale, the reported code and the account do not all agree";
        }
        boolean linked = sale.requestId().equals(e.paymentRequestId()) || (!linkRequired && e.paymentRequestId() == null);
        if (!sale.requestId().equals(e.referencedSaleId()) || !linked || !sale.reference().equals(e.reference())) {
            return "the payment does not carry the exact sale reference";
        }
        return null;
    }
}
