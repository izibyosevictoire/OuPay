package rw.oupay.inventory;

/**
 * Why stock changed. RESERVE, RELEASE, RETURN and CORRECTION are designed for later
 * milestones: each will need its own sign rule in the database, so each arrives with its own migration rather than being
 * allowed (and meaningless) now.
 */
public enum MovementType {
    /** The first stock ever recorded for an item at a branch. Once per branch and item, and before any other movement. */
    OPENING(true),
    /** Stock received from outside (a delivery). */
    RECEIVE(true),
    /** A manual correction that adds stock; always carries a reason. */
    ADJUST_IN(true),
    /** A manual correction that removes stock (loss, damage, count difference); always carries a reason. */
    ADJUST_OUT(false),
    /**
     * Stock deducted for a sale that was paid in full through reconciled bank money (R7c). Posted by the system, never by a person: it has no
     * actor and always names the sale. It records the stock LEDGER only; it does not prove the goods were handed to the customer.
     */
    SALE(false);

    private final boolean adds;

    MovementType(boolean adds) {
        this.adds = adds;
    }

    public boolean adds() {
        return adds;
    }

    public boolean requiresReason() {
        return this == ADJUST_IN || this == ADJUST_OUT;
    }
}
