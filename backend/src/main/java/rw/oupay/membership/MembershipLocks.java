package rw.oupay.membership;

import jakarta.persistence.EntityManager;
import java.util.List;
import java.util.UUID;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Takes the business-wide membership lock AND returns fresh state.
 *
 * <p>A locking query alone is not enough: if the memberships were already loaded earlier in the same
 * transaction (the acting user's own membership always is, by {@link MerchantAccess}), Hibernate keeps the
 * stale in-memory copy even though the row lock was granted after another transaction changed it. Two owners
 * demoting each other at the same moment would then both pass the "another owner exists" check. Refreshing
 * every locked row makes every decision after this point rest on committed, current data.
 */
@Component
public class MembershipLocks {

    private final MembershipRepository memberships;
    private final EntityManager entityManager;

    public MembershipLocks(MembershipRepository memberships, EntityManager entityManager) {
        this.memberships = memberships;
        this.entityManager = entityManager;
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public List<Membership> lockAll(UUID merchantId) {
        List<Membership> locked = memberships.lockAllOfMerchant(merchantId);
        locked.forEach(entityManager::refresh);
        return locked;
    }
}
