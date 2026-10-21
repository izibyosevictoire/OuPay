package rw.oupay.invoice;

import java.util.UUID;

/**
 * How an invoice is being created, supplied by TRUSTED server code only (never by a request body or a controller).
 * It carries the invoice's provenance and, for checkout flows, the durable identity of the original sale-creation
 * request. That identity is unique per business in the database, so the same request can never create a second invoice,
 * whatever happens to any HTTP replay record.
 *
 * @param channel         where the invoice comes from
 * @param clientRequestId the durable identity of the creating request. Required for {@link SaleChannel#POS} and
 *                        {@link SaleChannel#SIMPLIFIED}; optional for traditional invoices, which have none
 */
public record InvoiceCreation(SaleChannel channel, UUID clientRequestId) {

    private static final UUID NIL = new UUID(0L, 0L);

    public InvoiceCreation {
        if (channel == null) {
            throw new IllegalArgumentException("An invoice needs a sale channel.");
        }
        if (channel != SaleChannel.INVOICE && clientRequestId == null) {
            throw new IllegalArgumentException("A " + channel + " sale needs a durable client request id.");
        }
        if (NIL.equals(clientRequestId)) {
            throw new IllegalArgumentException("The client request id must be a real identifier.");
        }
    }

    /** The traditional manual invoice: no client request identity. This is what the existing endpoints use. */
    public static InvoiceCreation manual() {
        return new InvoiceCreation(SaleChannel.INVOICE, null);
    }
}
