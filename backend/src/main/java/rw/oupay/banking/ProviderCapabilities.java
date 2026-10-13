package rw.oupay.banking;

/** What a provider can do. Field names match the frontend's ProviderCapabilities. */
public record ProviderCapabilities(
        Capability transactionWebhooks,
        Capability webhookSignatureVerification,
        Capability merchantVerification,
        Capability accountLinking,
        Capability paymentInitiation,
        Capability realtimeNotifications,
        Capability ussdMerchantResolution,
        Capability paymentReferenceEcho) {

    /** A provider without an adapter: nothing is assumed. */
    public static ProviderCapabilities allUnconfirmed() {
        Capability u = Capability.UNCONFIRMED;
        return new ProviderCapabilities(u, u, u, u, u, u, u, u);
    }
}
