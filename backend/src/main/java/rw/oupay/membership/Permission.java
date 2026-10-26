package rw.oupay.membership;

import java.util.Map;
import java.util.Optional;

/**
 * The server-side permission matrix. It mirrors the frontend's {@code PERMISSION_DEFINITIONS}, but
 * this is the authoritative copy: the browser can be bypassed, this cannot.
 *
 * <p>{@link Scope#ALL} covers every record of the business; {@link Scope#LIMITED} is a reduced
 * view. For invoices, transactions and payment confirmations it means only records assigned to
 * the user.
 */
public enum Permission {
    DASHBOARD_VIEW("dashboard:view", all(), all(), limited()),
    PROFILE_VIEW("profile:view", all(), all(), limited()),
    PROFILE_EDIT("profile:edit", all(), none(), none()),
    INVOICES_VIEW("invoices:view", all(), all(), limited()),
    INVOICES_CREATE("invoices:create", all(), all(), all()),
    INVOICES_VOID("invoices:void", all(), none(), none()),
    TRANSACTIONS_VIEW("transactions:view", all(), all(), limited()),
    PAYMENTS_VIEW_CONFIRMATIONS("payments:view_confirmations", all(), all(), limited()),
    PAYMENTS_RECONCILE("payments:reconcile", all(), all(), none()),
    PAYMENT_PROFILES_VIEW("payment_profiles:view", all(), all(), limited()),
    PAYMENT_PROFILES_MANAGE("payment_profiles:manage", all(), all(), none()),
    BRANCHES_MANAGE("branches:manage", all(), all(), none()),
    CASHIERS_MANAGE("cashiers:manage", all(), all(), none()),
    MEMBERSHIP_MANAGE("membership:manage", all(), none(), none()),
    REPORTS_VIEW("reports:view", all(), all(), none()),
    BANKING_MANAGE("banking:manage", all(), none(), none()),
    /** Read the goods and services catalog. Cashiers get read-only access (they will sell from it). */
    CATALOG_VIEW("catalog:view", all(), all(), all()),
    /** Create and change catalog items, prices, availability and packages. Never granted to cashiers. */
    CATALOG_MANAGE("catalog:manage", all(), all(), none());

    public enum Scope { ALL, LIMITED }

    private final String key;
    private final Map<Role, Scope> grants;

    Permission(String key, Optional<Scope> owner, Optional<Scope> manager, Optional<Scope> cashier) {
        this.key = key;
        var map = new java.util.EnumMap<Role, Scope>(Role.class);
        owner.ifPresent(s -> map.put(Role.OWNER, s));
        manager.ifPresent(s -> map.put(Role.MANAGER, s));
        cashier.ifPresent(s -> map.put(Role.CASHIER, s));
        this.grants = map;
    }

    public String key() {
        return key;
    }

    /** Empty when the role has no access at all. */
    public Optional<Scope> scopeFor(Role role) {
        return Optional.ofNullable(grants.get(role));
    }

    private static Optional<Scope> all() {
        return Optional.of(Scope.ALL);
    }

    private static Optional<Scope> limited() {
        return Optional.of(Scope.LIMITED);
    }

    private static Optional<Scope> none() {
        return Optional.empty();
    }
}
