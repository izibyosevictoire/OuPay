package rw.oupay.collection;

import java.util.Set;

/**
 * The internal lifecycle of a collection code. {@code ACTIVE} means the BANK approved it and approval evidence is recorded; it is never
 * a statement OuPay makes on its own. The same transition table is enforced by a database trigger (V11).
 */
public enum CollectionCodeStatus {
    /** The merchant asked OuPay for a code. Nothing has been sent to the bank. */
    REQUESTED,
    /** The owner recorded that a request was made to the bank, with its reference. Not verified by OuPay. */
    REQUEST_DECLARED,
    /** The bank approved it; evidence is recorded and the bank-issued code is known. */
    ACTIVE,
    SUSPENDED,
    /** Final. A deactivated code is never reassigned, and its bank-issued code stays reserved for ever. */
    DEACTIVATED,
    /** Final. */
    REJECTED;

    public Set<CollectionCodeStatus> next() {
        return switch (this) {
            case REQUESTED -> Set.of(REQUEST_DECLARED, REJECTED, DEACTIVATED);
            case REQUEST_DECLARED -> Set.of(ACTIVE, REJECTED, DEACTIVATED);
            case ACTIVE -> Set.of(SUSPENDED, DEACTIVATED);
            case SUSPENDED -> Set.of(ACTIVE, DEACTIVATED);
            case DEACTIVATED, REJECTED -> Set.of();
        };
    }

    public boolean canMoveTo(CollectionCodeStatus target) {
        return next().contains(target);
    }

    /** A code can be given to an agent only while it still can be used. */
    public boolean assignable() {
        return this == REQUESTED || this == REQUEST_DECLARED || this == ACTIVE;
    }
}
