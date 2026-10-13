package rw.oupay.membership;

/**
 * Who may do what to whom (server-side copy of the frontend's staffPolicy):
 * <ul>
 *   <li>{@code membership:manage} (owners): every action on every member. Role changes live here.</li>
 *   <li>{@code cashiers:manage} (managers): operational actions on CASHIER members only. Never roles,
 *       never other managers or owners.</li>
 * </ul>
 */
public final class StaffPolicy {

    public enum Action { INVITE, CHANGE_ROLE, ASSIGN_BRANCHES, SUSPEND, REACTIVATE, REVOKE }

    private StaffPolicy() {}

    public static boolean canPerform(Actor actor, Action action, Role targetRole) {
        if (actor.can(Permission.MEMBERSHIP_MANAGE)) {
            return true;
        }
        if (actor.can(Permission.CASHIERS_MANAGE)) {
            return action != Action.CHANGE_ROLE && targetRole == Role.CASHIER;
        }
        return false;
    }

    private static int rank(Role role) {
        return switch (role) {
            case CASHIER -> 0;
            case MANAGER -> 1;
            case OWNER -> 2;
        };
    }

    public static boolean isEscalation(Role from, Role to) {
        return rank(to) > rank(from);
    }
}
