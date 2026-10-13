package rw.oupay.banking;

/**
 * Whether a provider offers an operation. UNCONFIRMED is the honest default for any real bank until
 * its integration documentation and approval say otherwise: nothing is ever assumed.
 */
public enum Capability {
    SUPPORTED,
    NOT_SUPPORTED,
    UNCONFIRMED
}
