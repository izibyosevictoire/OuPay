package rw.oupay.ledger;

import java.util.Set;

/** What the BANK reported. PENDING can settle either way; CONFIRMED can only be reversed; the rest is final. */
public enum BankTransactionStatus {
    PENDING,
    CONFIRMED,
    FAILED,
    REVERSED;

    public Set<BankTransactionStatus> allowedNext() {
        return switch (this) {
            case PENDING -> Set.of(CONFIRMED, FAILED, REVERSED);
            case CONFIRMED -> Set.of(REVERSED);
            case FAILED, REVERSED -> Set.of();
        };
    }

    public boolean canTransitionTo(BankTransactionStatus next) {
        return allowedNext().contains(next);
    }
}
