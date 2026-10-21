package rw.oupay.payment;

import java.time.Duration;

/**
 * How a payment request is created, supplied by TRUSTED server code only: today just its lifetime. The expiry itself is
 * always computed on the server from its own clock, as {@code now + lifetime}; nothing a client sends can set it, and the
 * public customer pages never reach this type.
 *
 * <p>Expiry means only "this request is no longer collecting". It is not evidence that no bank payment happened: money
 * the bank confirmed stays confirmed and is still reconciled after expiry.
 *
 * @param lifetime how long the request stays open: at least {@link #MINIMUM_LIFETIME}, at most {@link #MAXIMUM_LIFETIME}
 */
public record PaymentRequestOptions(Duration lifetime) {

    /** The lifetime of a traditional invoice's payment request. Unchanged by checkout flows. */
    public static final Duration TRADITIONAL_INVOICE_LIFETIME = Duration.ofDays(7);
    public static final Duration MINIMUM_LIFETIME = Duration.ofMinutes(1);
    /** A request can be shorter than a traditional invoice's, never longer. */
    public static final Duration MAXIMUM_LIFETIME = TRADITIONAL_INVOICE_LIFETIME;

    public PaymentRequestOptions {
        if (lifetime == null || lifetime.compareTo(MINIMUM_LIFETIME) < 0 || lifetime.compareTo(MAXIMUM_LIFETIME) > 0) {
            throw new IllegalArgumentException("A payment request must stay open for between " + MINIMUM_LIFETIME.toMinutes()
                    + " minute and " + MAXIMUM_LIFETIME.toDays() + " days.");
        }
    }

    /** Seven days: what invoice payment requests have always had. */
    public static PaymentRequestOptions traditionalInvoice() {
        return new PaymentRequestOptions(TRADITIONAL_INVOICE_LIFETIME);
    }

    /** An explicitly shorter (or equal) lifetime for a checkout flow. */
    public static PaymentRequestOptions ofLifetime(Duration lifetime) {
        return new PaymentRequestOptions(lifetime);
    }
}
