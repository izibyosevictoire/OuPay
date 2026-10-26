package rw.oupay.collection;

/** Where the evidence that the bank approved a code came from. */
public enum ApprovalSource {
    /** A verified, authenticated bank event or API response (arrives with the real integration, R6e). */
    BANK_EVENT,
    /** A trusted operator citing real written evidence from the bank, with a second person checking. */
    OPERATOR
}
