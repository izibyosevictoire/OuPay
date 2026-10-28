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
     * @param saleInvoiceId     that sale's invoice (the business's own), so a screen can link to it. Same visibility as the sale reference
     * @param stage             where this payment stands, from the facts below (never a status of its own): NOT_CONFIRMED, AWAITING_MATCHING
     *                          (verified funds, nothing resolved or matched), CODE_RESOLVED, SALE_MATCHED, ALLOCATED, FULLY_PAID, or CONFLICT
     * @param codeResolved      the reported code resolved to one of the business's own codes (attribution)
     * @param saleReferenceNamed the payment carries the exact reference of a code sale
     * @param saleReferenceMatched that sale's payment request is linked to this transaction (the automatic match was made)
     * @param allocatedToSaleRwf the amount of THIS transaction actually applied (allocated) to that sale's invoice: the only fact that is money
     * @param allocationOrigin  HOW this transaction's money was applied to that sale: AUTO_REFERENCE (matched on complete bank evidence), MANUAL
     *                          (an authorised person, with a recorded reason; the bank evidence may be incomplete and the agent stays unconfirmed),
     *                          MIXED, or null when nothing is applied. A sale can be financially paid while its code and agent are unconfirmed
     * @param saleFullyPaid     the sale's invoice has no remaining balance, from all its active allocations
     */
    public record AttributionView(UUID merchantId, UUID transactionId, String providerTransactionId, BankTransactionStatus transactionStatus,
                                  long amountRwf, Instant occurredAt, String reportedCode, boolean reportedCodeMasked, CodeRef collectionCode,
                                  String attributionStatus, String attributionBasis, String agentAttribution, String agentName,
                                  String saleReference, UUID saleInvoiceId, String stage, boolean codeResolved, boolean saleReferenceNamed, boolean saleReferenceMatched,
                                  long allocatedToSaleRwf, String allocationOrigin, boolean saleFullyPaid, ReviewState reviewState, Instant createdAt) {}
}
