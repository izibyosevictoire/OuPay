package rw.oupay.collection;

import java.time.Instant;
import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

public interface CollectionCodeAssignmentRepository extends JpaRepository<CollectionCodeAssignment, UUID> {

    /** The single open assignment of a code, if any (a partial unique index guarantees there is at most one). */
    Optional<CollectionCodeAssignment> findByCodeIdAndMerchantIdAndValidToIsNull(UUID codeId, UUID merchantId);

    /** The most recent period of a code (open or ended). */
    Optional<CollectionCodeAssignment> findFirstByCodeIdAndMerchantIdOrderByValidFromDescIdDesc(UUID codeId, UUID merchantId);

    @Query("select a from CollectionCodeAssignment a where a.merchantId = :merchantId and a.codeId in :codeIds and a.validTo is null")
    List<CollectionCodeAssignment> findOpenForCodes(UUID merchantId, Collection<UUID> codeIds);

    /** The codes a person holds right now, newest assignment first. */
    @Query("select a from CollectionCodeAssignment a where a.merchantId = :merchantId and a.assigneeUserId = :userId and a.validTo is null"
            + " order by a.validFrom desc, a.id desc")
    List<CollectionCodeAssignment> findOpenForUser(UUID merchantId, UUID userId);

    /** Keyset history page for one code, newest first, total order (valid_from, id). */
    @Query("select a from CollectionCodeAssignment a where a.merchantId = :merchantId and a.codeId = :codeId"
            + " and (a.validFrom < :at or (a.validFrom = :at and a.id < :id)) order by a.validFrom desc, a.id desc")
    List<CollectionCodeAssignment> history(UUID merchantId, UUID codeId, Instant at, UUID id, Pageable pageable);
}
