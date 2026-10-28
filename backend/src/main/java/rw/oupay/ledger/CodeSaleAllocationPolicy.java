package rw.oupay.ledger;

import org.springframework.stereotype.Component;
import rw.oupay.invoice.Invoice;
import rw.oupay.invoice.SaleChannel;

/**
 * Whether bank money may be applied to a CODE sale. The same rule the database enforces by trigger (V13), checked here first so the
 * caller gets a clear refusal instead of a constraint error:
 * <ul>
 *   <li>a DEMONSTRATION sale never receives bank money, by any route;</li>
 *   <li>a CODE sale is never matched AUTOMATICALLY (reference, invoice number, amount, time or agent) until bank attribution (R6d) exists
 *       and Equity has confirmed what a code payment carries;</li>
 *   <li>a LIVE sale may still be applied MANUALLY by an authorised person.</li>
 * </ul>
 * Traditional and simplified invoices are untouched.
 */
@Component
public class CodeSaleAllocationPolicy {

    /** True for an invoice that was billed through a collection code, whatever the mode of the sale. */
    public boolean isCodeSale(Invoice invoice) {
        return invoice.getSaleChannel() == SaleChannel.CODE;
    }

    /** The invoice's own flag, fixed when it was created and kept equal to the sale's mode by the database. */
    public boolean isDemonstration(Invoice invoice) {
        return invoice.isDemonstration();
    }

    /** @throws LedgerRuleException when this origin of allocation is not allowed for this invoice */
    public void requireAllowed(Invoice invoice, PaymentAllocation.Origin origin) {
        if (!isCodeSale(invoice)) {
            return;
        }
        if (isDemonstration(invoice)) {
            throw LedgerRuleException.codeSaleNotPayable(invoice.getInvoiceNumber(), true);
        }
        if (origin != PaymentAllocation.Origin.MANUAL) {
            throw LedgerRuleException.codeSaleNotPayable(invoice.getInvoiceNumber(), false);
        }
    }
}
