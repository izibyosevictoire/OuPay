package rw.oupay.membership;

import java.util.Optional;
import java.util.UUID;
import rw.oupay.user.User;

/** The signed-in user acting inside one business, with the role they hold there. */
public record Actor(User user, Membership membership) {

    public UUID userId() {
        return user.getId();
    }

    public UUID merchantId() {
        return membership.getMerchantId();
    }

    public Role role() {
        return membership.getRole();
    }

    public Optional<Permission.Scope> scope(Permission permission) {
        return permission.scopeFor(role());
    }

    /** True when the actor may see every record of the business (not only their own). */
    public boolean hasFullScope(Permission permission) {
        return scope(permission).filter(s -> s == Permission.Scope.ALL).isPresent();
    }

    public boolean can(Permission permission) {
        return scope(permission).isPresent();
    }
}
