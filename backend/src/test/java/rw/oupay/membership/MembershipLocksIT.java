package rw.oupay.membership;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.transaction.support.TransactionTemplate;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.World;

/** Regression: a locking read must return what is committed NOW, not a copy loaded earlier in the transaction. */
class MembershipLocksIT extends IntegrationTest {
    @Autowired TransactionTemplate tx;
    @Autowired MembershipRepository memberships;
    @Autowired MembershipLocks locks;

    @Test
    void lockingMembershipsReturnsFreshStateEvenIfTheyWereLoadedEarlierInTheTransaction() {
        World w = World.create(this);
        String seen = tx.execute(s -> {
            var early = memberships.findById(w.managerMembershipId).orElseThrow();
            assertThat(early.getRole().name()).isEqualTo("MANAGER");
            // Another transaction commits a change after our early read (same connection here, which is enough to model it).
            jdbc.update("update memberships set role = 'CASHIER' where id = ?", w.managerMembershipId);
            var all = locks.lockAll(w.merchantId);
            return all.stream().filter(x -> x.getId().equals(w.managerMembershipId)).findFirst().orElseThrow().getRole().name()
                    + "/" + early.getRole().name();
        });
        assertThat(seen).isEqualTo("CASHIER/CASHIER");
    }
}
