package rw.oupay.inventory;

/**
 * Why stock changed. Only these four exist today. RESERVE, RELEASE, SALE, RETURN and CORRECTION are designed for later
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
    ADJUST_OUT(false);

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
