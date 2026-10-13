package rw.oupay.invoice;

import java.util.Set;

/**
 * Commercial lifecycle of the invoice document. Payment is tracked separately.
 * DRAFT to ISSUED or CANCELLED; ISSUED to VOIDED (owner, unpaid only). CANCELLED and VOIDED are final.
 * The same rules are enforced by a database trigger.
 */
public enum InvoiceStatus {
    DRAFT,
    ISSUED,
    CANCELLED,
    VOIDED;

    public Set<InvoiceStatus> allowedNext() {
        return switch (this) {
            case DRAFT -> Set.of(ISSUED, CANCELLED);
            case ISSUED -> Set.of(VOIDED);
            case CANCELLED, VOIDED -> Set.of();
        };
    }

    public boolean canTransitionTo(InvoiceStatus next) {
        return allowedNext().contains(next);
    }
}
