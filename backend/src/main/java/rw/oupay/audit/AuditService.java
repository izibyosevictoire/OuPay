package rw.oupay.audit;

import java.time.Clock;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.common.Pagination;

/**
 * Writes audit entries in the caller's transaction, so a change and its audit record commit or
 * roll back together. Messages must never contain secrets, tokens, passwords or full payloads.
 */
@Service
public class AuditService {

    public record Entry(Long id, String kind, UUID actorUserId, UUID bankTransactionId, UUID invoiceId, String message, java.time.Instant createdAt) {}

    private final AuditLogRepository repository;
    private final rw.oupay.membership.MerchantAccess access;
    private final Clock clock;

    public AuditService(AuditLogRepository repository, rw.oupay.membership.MerchantAccess access, Clock clock) {
        this.repository = repository;
        this.access = access;
        this.clock = clock;
    }

    /** The business's own audit trail (owners and managers). */
    /** Newest first, keyed by the (strictly increasing) id, so paging is stable while new entries are appended. */
    @Transactional(readOnly = true)
    public Pagination.Page<Entry> listForMerchant(UUID merchantId, Integer limit, String cursor) {
        access.require(merchantId, rw.oupay.membership.Permission.REPORTS_VIEW);
        int size = Pagination.limit(limit);
        long before = Long.MAX_VALUE;
        if (cursor != null && !cursor.isBlank()) {
            try {
                before = Long.parseLong(cursor);
            } catch (NumberFormatException e) {
                throw new rw.oupay.common.ApiException(org.springframework.http.HttpStatus.BAD_REQUEST, "bad_request", "The page cursor is not valid.");
            }
        }
        var fetched = repository.findByMerchantIdAndIdLessThanOrderByIdDesc(merchantId, before, Pagination.fetch(size));
        boolean more = fetched.size() > size;
        var items = (more ? fetched.subList(0, size) : fetched).stream()
                .map(e -> new Entry(e.getId(), e.getKind(), e.getActorUserId(), e.getBankTransactionId(), e.getInvoiceId(), e.getMessage(), e.getCreatedAt()))
                .toList();
        return new Pagination.Page<>(items, more ? String.valueOf(items.get(size - 1).id()) : null, null);
    }

    @Transactional
    public void record(UUID merchantId, UUID actorUserId, String kind, String entityType, UUID entityId, String message) {
        repository.save(new AuditLog(merchantId, actorUserId, kind, entityType, entityId, null, null, message, clock.instant()));
    }

    /** Ledger entries are indexed by bank transaction and invoice so they can be shown as a history. */
    @Transactional
    public void recordLedger(UUID merchantId, UUID actorUserId, String kind, UUID bankTransactionId, UUID invoiceId, String message) {
        repository.save(new AuditLog(merchantId, actorUserId, kind, "bank_transaction", bankTransactionId,
                bankTransactionId, invoiceId, message, clock.instant()));
    }
}
