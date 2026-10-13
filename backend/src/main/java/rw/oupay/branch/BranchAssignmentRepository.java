package rw.oupay.branch;

import java.util.List;
import java.util.UUID;
import org.springframework.data.jpa.repository.JpaRepository;

public interface BranchAssignmentRepository extends JpaRepository<BranchAssignment, UUID> {

    List<BranchAssignment> findByMerchantId(UUID merchantId);

    List<BranchAssignment> findByMerchantIdAndStatus(UUID merchantId, String status);

    List<BranchAssignment> findByMembershipIdAndStatus(UUID membershipId, String status);

    List<BranchAssignment> findByBranchIdAndStatus(UUID branchId, String status);

    boolean existsByMembershipIdAndBranchIdAndStatus(UUID membershipId, UUID branchId, String status);
}
