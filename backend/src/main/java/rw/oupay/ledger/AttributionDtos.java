package rw.oupay.ledger;

import java.time.Instant;
import java.util.UUID;

/**
 * Read-only views of how a bank transaction was attributed (R6d-A). Never carries a banking secret, approval evidence, an internal code
 * reference, another business's code, or any identifier of a person: an agent appears only by the name in an immutable sale snapshot.
 */
public final class AttributionDtos {

    private AttributionDtos() {}

    /** The merchant's own code the reported value resolved to. */
    public record CodeRef(UUID id, String label, UUID branchId) {}

    /**
     * @param reportedCode      what the bank reported, or null. Masked ({@code ••••77}) unless the reader may see it
     * @param attributionStatus RESOLVED, UNRESOLVED, CONFLICT, NOT_REPORTED, or NOT_EVALUATED for a transaction that predates attribution
     * @param attributionBasis  CODE_REPORTED, ACCOUNT_ONLY, UNATTRIBUTED, or null when not evaluated
     * @param agentAttribution  A CONCLUSION, kept apart from the evidence: CONFIRMED_FROM_SALE_SNAPSHOT (sale, reported code and account agree),
     *                          SALE_NAMED_UNCONFIRMED (the exact sale is named but the bank reported no code) or UNRESOLVED. Never inferred
     * @param agentName         only when the agent is CONFIRMED and the money is verified; a named but unconfirmed sale never names an agent
     * @param saleReference     the exact CODE sale reference the payment carries, or null. A reference is NOT a match
     * @param matchedToSale     true only when verified money has actually been applied (allocated) to that sale
     */
    public record AttributionView(UUID merchantId, UUID transactionId, String providerTransactionId, BankTransactionStatus transactionStatus,
                                  long amountRwf, Instant occurredAt, String reportedCode, boolean reportedCodeMasked, CodeRef collectionCode,
                                  String attributionStatus, String attributionBasis, String agentAttribution, String agentName,
                                  String saleReference, boolean matchedToSale, ReviewState reviewState, Instant createdAt) {}
}
