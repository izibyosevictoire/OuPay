package rw.oupay.invoice;

/**
 * Where an invoice came from, recorded once at creation and never changed.
 * <ul>
 *   <li>{@link #INVOICE}: traditional manual invoicing;</li>
 *   <li>{@link #POS}: point-of-sale billing;</li>
 *   <li>{@link #SIMPLIFIED}: amount-only billing.</li>
 * </ul>
 * Invoices created before provenance existed have no stored value and are read as {@link #INVOICE}
 * (see {@link Invoice#getSaleChannel()}). Only trusted server code chooses a channel: no API accepts one.
 */
public enum SaleChannel {
    INVOICE,
    POS,
    SIMPLIFIED
}
