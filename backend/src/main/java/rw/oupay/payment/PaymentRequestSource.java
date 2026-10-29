package rw.oupay.payment;

import rw.oupay.invoice.SaleChannel;

/**
 * Where a payment request came from, recorded once at creation. A request for an invoice has the same source as that
 * invoice's {@link SaleChannel} (the database enforces it); a request with no invoice is {@link #OPEN}.
 *
 * <p>This is deliberately not a second, independent classification: it is either {@code OPEN} or the invoice's own
 * channel, kept on the request so collections can be filtered without joining. Requests created before provenance existed
 * have no stored value and are read as {@link #OPEN} (no invoice) or {@link #INVOICE}, see
 * {@link PaymentRequest#getSource()}.
 */
public enum PaymentRequestSource {
    /** An anonymous collection with no invoice (the public open-amount page). */
    OPEN,
    INVOICE,
    POS,
    SIMPLIFIED,
    CODE;

    /** The source of a request that collects for an invoice created through {@code channel}. */
    public static PaymentRequestSource forInvoice(SaleChannel channel) {
        return switch (channel) {
            case INVOICE -> INVOICE;
            case POS -> POS;
            case SIMPLIFIED -> SIMPLIFIED;
            case CODE -> CODE;
        };
    }
}
