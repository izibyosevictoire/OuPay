package rw.oupay.banking;

/**
 * Providers OuPay can talk to. {@code EQUITY_MOCK} is a SIMULATION for local development: it is not
 * Equity Bank's API. The others are placeholders for approved future partners and have no adapter.
 */
public enum ProviderId {
    EQUITY_MOCK,
    MTN_MOMO,
    AIRTEL_MONEY
}
