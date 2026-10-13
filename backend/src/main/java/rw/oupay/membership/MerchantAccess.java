package rw.oupay.membership;

import java.util.UUID;
import org.springframework.stereotype.Service;
import rw.oupay.auth.CurrentUser;
import rw.oupay.common.ApiException;
import rw.oupay.user.UserRepository;
import rw.oupay.user.UserStatus;

/**
 * THE authorisation gate. Every service method that touches business data starts with
 * {@link #require}. It does not trust the URL, the request body or the controller:
 *
 * <ul>
 *   <li>not signed in: 401</li>
 *   <li>no ACTIVE membership in that business (including a business that does not exist):
 *       404, indistinguishable from "no such business", so nothing is revealed</li>
 *   <li>member without the permission: 403</li>
 * </ul>
 *
 * Record-level rules (a cashier sees only invoices assigned to them) are applied by the services
 * with {@link Actor#hasFullScope}, inside the repository queries.
 */
@Service
public class MerchantAccess {

    private final MembershipRepository memberships;
    private final UserRepository users;

    public MerchantAccess(MembershipRepository memberships, UserRepository users) {
        this.memberships = memberships;
        this.users = users;
    }

    public Actor requireMember(UUID merchantId) {
        var principal = CurrentUser.require();
        var user = users.findById(principal.userId())
                .filter(u -> u.getStatus() == UserStatus.ACTIVE)
                .orElseThrow(ApiException::unauthenticated);
        var membership = memberships.findByUserIdAndMerchantId(user.getId(), merchantId)
                .filter(Membership::isActive)
                .orElseThrow(() -> ApiException.notFound("This business could not be found."));
        return new Actor(user, membership);
    }

    public Actor require(UUID merchantId, Permission permission) {
        Actor actor = requireMember(merchantId);
        if (!actor.can(permission)) {
            throw ApiException.forbidden("You do not have permission to do that.");
        }
        return actor;
    }
}
