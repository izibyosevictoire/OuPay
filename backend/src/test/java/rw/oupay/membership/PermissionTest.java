package rw.oupay.membership;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.Test;
import rw.oupay.invoice.InvoiceStatus;
import rw.oupay.membership.Permission.Scope;

class PermissionTest {

    private static Scope scope(Permission permission, Role role) {
        return permission.scopeFor(role).orElse(null);
    }

    @Test
    void theMatrixMatchesTheDocumentedRoles() {
        // Expected, written out independently of the enum.
        Map<Permission, Scope[]> expected = new java.util.EnumMap<>(Permission.class);
        Scope all = Scope.ALL;
        Scope lim = Scope.LIMITED;
        expected.put(Permission.DASHBOARD_VIEW, new Scope[] {all, all, lim});
        expected.put(Permission.PROFILE_VIEW, new Scope[] {all, all, lim});
        expected.put(Permission.PROFILE_EDIT, new Scope[] {all, null, null});
        expected.put(Permission.INVOICES_VIEW, new Scope[] {all, all, lim});
        expected.put(Permission.INVOICES_CREATE, new Scope[] {all, all, all});
        expected.put(Permission.INVOICES_VOID, new Scope[] {all, null, null});
        expected.put(Permission.TRANSACTIONS_VIEW, new Scope[] {all, all, lim});
        expected.put(Permission.PAYMENTS_VIEW_CONFIRMATIONS, new Scope[] {all, all, lim});
        expected.put(Permission.PAYMENTS_RECONCILE, new Scope[] {all, all, null});
        expected.put(Permission.PAYMENT_PROFILES_VIEW, new Scope[] {all, all, lim});
        expected.put(Permission.PAYMENT_PROFILES_MANAGE, new Scope[] {all, all, null});
        expected.put(Permission.BRANCHES_MANAGE, new Scope[] {all, all, null});
        expected.put(Permission.CASHIERS_MANAGE, new Scope[] {all, all, null});
        expected.put(Permission.MEMBERSHIP_MANAGE, new Scope[] {all, null, null});
        expected.put(Permission.REPORTS_VIEW, new Scope[] {all, all, null});
        expected.put(Permission.BANKING_MANAGE, new Scope[] {all, null, null});
        expected.put(Permission.CATALOG_VIEW, new Scope[] {all, all, all});
        expected.put(Permission.CATALOG_MANAGE, new Scope[] {all, all, null});
        expected.put(Permission.INVENTORY_VIEW, new Scope[] {all, all, lim});
        expected.put(Permission.INVENTORY_RECEIVE, new Scope[] {all, lim, null});
        expected.put(Permission.INVENTORY_ADJUST, new Scope[] {all, lim, null});
        expected.put(Permission.COLLECTION_CODES_VIEW, new Scope[] {all, all, null});
        expected.put(Permission.COLLECTION_CODES_ASSIGN, new Scope[] {all, lim, null});
        expected.put(Permission.COLLECTION_CODES_MANAGE, new Scope[] {all, null, null});
        // Equity KYC holds a representative's identity details and the consent over them: the owner's alone.
        expected.put(Permission.KYC_MANAGE, new Scope[] {all, null, null});

        assertThat(expected.keySet()).containsExactlyInAnyOrder(Permission.values());
        expected.forEach((permission, scopes) -> {
            assertThat(scope(permission, Role.OWNER)).as("%s owner", permission).isEqualTo(scopes[0]);
            assertThat(scope(permission, Role.MANAGER)).as("%s manager", permission).isEqualTo(scopes[1]);
            assertThat(scope(permission, Role.CASHIER)).as("%s cashier", permission).isEqualTo(scopes[2]);
        });
    }

    @Test
    void cashiersNeverGetFullScopeOverRecordsOfOthersOrAnyMoneyMovingPower() {
        for (Permission p : new Permission[] {Permission.PAYMENTS_RECONCILE, Permission.BANKING_MANAGE, Permission.MEMBERSHIP_MANAGE,
                Permission.INVOICES_VOID, Permission.PAYMENT_PROFILES_MANAGE, Permission.PROFILE_EDIT, Permission.CATALOG_MANAGE,
                Permission.INVENTORY_RECEIVE, Permission.INVENTORY_ADJUST, Permission.COLLECTION_CODES_VIEW, Permission.COLLECTION_CODES_ASSIGN,
                Permission.COLLECTION_CODES_MANAGE, Permission.KYC_MANAGE}) {
            assertThat(p.scopeFor(Role.CASHIER)).as(p.key()).isEmpty();
        }
        for (Permission p : new Permission[] {Permission.INVOICES_VIEW, Permission.TRANSACTIONS_VIEW, Permission.PAYMENTS_VIEW_CONFIRMATIONS}) {
            assertThat(p.scopeFor(Role.CASHIER)).as(p.key()).contains(Scope.LIMITED);
        }
    }

    @Test
    void invoiceLifecycleAllowsOnlyTheDocumentedTransitions() {
        assertThat(InvoiceStatus.DRAFT.allowedNext()).containsExactlyInAnyOrder(InvoiceStatus.ISSUED, InvoiceStatus.CANCELLED);
        assertThat(InvoiceStatus.ISSUED.allowedNext()).containsExactly(InvoiceStatus.VOIDED);
        assertThat(InvoiceStatus.CANCELLED.allowedNext()).isEmpty();
        assertThat(InvoiceStatus.VOIDED.allowedNext()).isEmpty();
        assertThat(InvoiceStatus.ISSUED.canTransitionTo(InvoiceStatus.CANCELLED)).isFalse();
        assertThat(InvoiceStatus.ISSUED.canTransitionTo(InvoiceStatus.DRAFT)).isFalse();
    }
}
