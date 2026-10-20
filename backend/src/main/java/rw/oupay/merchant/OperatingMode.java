package rw.oupay.merchant;

/**
 * How a business works in OuPay. Unrelated to {@code Merchant.businessType}, which is the legal form.
 * Existing businesses, and any business without a settings row, are {@link #BUSINESS}.
 */
public enum OperatingMode {
    /** Full business capabilities. */
    BUSINESS,
    /** Streamlined amount-only payment collection. */
    SIMPLIFIED;

    public static final OperatingMode DEFAULT = BUSINESS;
}
