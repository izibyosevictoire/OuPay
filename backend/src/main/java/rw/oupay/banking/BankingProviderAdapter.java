package rw.oupay.banking;

import java.time.Instant;
import java.util.Map;

/**
 * The boundary between OuPay and any bank. The ledger only ever sees {@link NormalizedBankEvent},
 * so adding a bank means adding an adapter, not touching reconciliation.
 *
 * <p>Operations a real bank may not offer are OPTIONAL and live in separate capability interfaces
 * ({@link AccountLinkingCapable}, {@link EventAuthenticating}). An adapter implements only what that
 * bank's documented API actually provides, and {@link #capabilities()} says so honestly. Callers
 * must check {@code instanceof} (and the capability) before use.
 *
 * <p>These adapters run on the trusted SERVER. Bank credentials never reach a browser.
 */
public interface BankingProviderAdapter {

    ProviderId providerId();

    String displayName();

    /** True for simulators: everything they produce must be labelled as simulated. */
    boolean isSimulated();

    ProviderCapabilities capabilities();

    /**
     * Turns a raw provider payload into the one shape the ledger understands. Pure. Throws
     * {@link InvalidProviderEventException} for anything untrustworthy; the caller must have
     * authenticated the payload FIRST.
     */
    NormalizedBankEvent normalizeTransactionEvent(String rawBody);

    /** Only for providers that offer merchant account linking. */
    interface AccountLinkingCapable {
        AccountLinkValidation validateAccountLink(String accountReference);
    }

    /**
     * Only for providers that sign or otherwise authenticate their events. The trusted endpoint
     * must call this BEFORE normalising, and reject anything not authentic.
     */
    interface EventAuthenticating {
        boolean isAuthentic(Map<String, String> headers, String rawBody);
    }

    enum EventStatus { PENDING, CONFIRMED, FAILED, REVERSED }

    record NormalizedBankEvent(
            ProviderId providerId,
            String providerEventId,
            String providerTransactionId,
            EventStatus status,
            /** Whole RWF. */
            long amountRwf,
            /** Exact reference reported by the bank, if any. Trusted only when it matches exactly. */
            String paymentReference,
            String payerDisplayName,
            Instant occurredAt,
            /** Opaque ID of the merchant account the money reached. */
            String providerAccountId,
            boolean simulated) {}

    record AccountLinkValidation(boolean valid, String providerAccountId, String maskedAccount, String failureReason) {}

    class InvalidProviderEventException extends RuntimeException {
        public InvalidProviderEventException(String message) {
            super(message);
        }
    }
}
