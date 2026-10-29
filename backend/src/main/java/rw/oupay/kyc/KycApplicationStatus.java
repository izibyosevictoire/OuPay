package rw.oupay.kyc;

/**
 * Where an Equity KYC application stands. Only DRAFT to COLLECTED is ever a merchant's own step; every other status exists only
 * because evidence of what the bank did was recorded (see {@link KycEvidenceService}), and the database refuses them without it.
 */
public enum KycApplicationStatus {
    /** Being filled in by the owner. */
    DRAFT,
    /** Submitted to OuPay for review. NOT received, reviewed or approved by Equity. */
    COLLECTED,
    /** Evidence shows it was really handed to the bank. */
    HANDED_OFF,
    /** The bank asked for more information (with evidence). */
    MORE_INFO_REQUESTED,
    /** The bank approved it (with evidence). Final. */
    APPROVED,
    /** The bank did not approve it (with evidence). Final, kept as history. */
    REJECTED
}
