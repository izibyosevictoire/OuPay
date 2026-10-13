package rw.oupay.notification;

import java.time.Clock;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.common.ApiException;
import rw.oupay.common.Pagination;
import rw.oupay.invoice.Invoice;
import rw.oupay.ledger.BankTransaction;
import rw.oupay.membership.Actor;
import rw.oupay.membership.MembershipRepository;
import rw.oupay.membership.MembershipStatus;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.membership.Role;
import rw.oupay.user.UserRepository;
import rw.oupay.user.UserStatus;

/**
 * In-app notifications. They are created by the trusted event processor and by reconciliation
 * (never by the UI) and routed to the responsible cashier and the authorised managers. Each
 * person only ever reads their own. Creation is idempotent per (recipient, dedupe key), so a
 * replayed event or repeated operation can never produce a duplicate.
 */
@Service
public class NotificationService {

    public record NotificationDto(UUID id, UUID merchantId, UUID recipientUserId, NotificationKind kind, String title,
                                  String body, UUID relatedBankTransactionId, UUID relatedInvoiceId, String dedupeKey,
                                  boolean isSimulated, java.time.Instant readAt, java.time.Instant createdAt) {
        static NotificationDto of(Notification n) {
            return new NotificationDto(n.getId(), n.getMerchantId(), n.getRecipientUserId(), n.getKind(), n.getTitle(), n.getBody(),
                    n.getRelatedBankTransactionId(), n.getRelatedInvoiceId(), n.getDedupeKey(), n.isSimulated(), n.getReadAt(),
                    n.getCreatedAt());
        }
    }

    private final NotificationRepository notifications;
    private final MembershipRepository memberships;
    private final UserRepository users;
    private final MerchantAccess access;
    private final JdbcClient jdbc;
    private final Clock clock;

    public NotificationService(NotificationRepository notifications, MembershipRepository memberships, UserRepository users,
                               MerchantAccess access, JdbcClient jdbc, Clock clock) {
        this.notifications = notifications;
        this.memberships = memberships;
        this.users = users;
        this.access = access;
        this.jdbc = jdbc;
        this.clock = clock;
    }

    // ---- reads (a person's own notifications only) ---------------------------------------------

    @Transactional(readOnly = true)
    public Pagination.Page<NotificationDto> list(UUID merchantId, Integer limit, String cursor) {
        Actor actor = access.requireMember(merchantId);
        int size = Pagination.limit(limit);
        var position = Pagination.decode(cursor);
        var fetched = notifications.page(merchantId, actor.userId(), position.at(), position.id(), Pagination.fetch(size));
        return Pagination.page(fetched, size, Notification::getCreatedAt, Notification::getId, null).map(NotificationDto::of);
    }

    @Transactional
    public NotificationDto markRead(UUID merchantId, UUID notificationId) {
        Actor actor = access.requireMember(merchantId);
        // Someone else's notification looks like it does not exist.
        Notification n = notifications.findByIdAndMerchantIdAndRecipientUserId(notificationId, merchantId, actor.userId())
                .orElseThrow(() -> ApiException.notFound("This notification could not be found."));
        n.markRead(clock.instant());
        return NotificationDto.of(n);
    }

    @Transactional
    public void markAllRead(UUID merchantId) {
        Actor actor = access.requireMember(merchantId);
        notifications.markAllRead(merchantId, actor.userId(), clock.instant());
    }

    // ---- routing (called inside the ledger transaction) ----------------------------------------

    /** Partly or fully settled invoice: the responsible cashier and the managers. */
    public void invoiceAllocated(BankTransaction tx, Invoice invoice, long amountRwf, long remainingAfter) {
        boolean settled = remainingAfter == 0;
        send(tx.getMerchantId(), settled ? NotificationKind.INVOICE_SETTLED : NotificationKind.INVOICE_PARTIALLY_SETTLED,
                settled ? "Invoice " + invoice.getInvoiceNumber() + " settled" : "Invoice " + invoice.getInvoiceNumber() + " partly paid",
                settled ? rwf(amountRwf) + " bank-confirmed" + tag(tx) + ". The invoice is fully paid."
                        : rwf(amountRwf) + " bank-confirmed" + tag(tx) + ". " + rwf(remainingAfter) + " still to pay.",
                recipientsWithCashier(tx.getMerchantId(), invoice),
                (settled ? "settled:" : "partial:") + tx.getId() + ":" + invoice.getId() + ":" + remainingAfter, tx, invoice.getId());
    }

    /** Unmatched money is only ever announced to people who may reconcile it. */
    public void unmatched(BankTransaction tx) {
        send(tx.getMerchantId(), NotificationKind.PAYMENT_UNMATCHED, "Unmatched bank confirmation",
                rwf(tx.getAmountRwf()) + " from " + tx.getPayerDisplayName() + " was confirmed" + tag(tx)
                        + " but not matched to an invoice. It needs review.",
                managers(tx.getMerchantId()), "unmatched:" + tx.getId(), tx, null);
    }

    public void needsReview(BankTransaction tx, String reason) {
        send(tx.getMerchantId(), NotificationKind.NEEDS_REVIEW, "Transaction needs review",
                rwf(tx.getAmountRwf()) + " from " + tx.getPayerDisplayName() + tag(tx) + ": " + reason,
                managers(tx.getMerchantId()), "review:" + tx.getId() + ":" + reason, tx, null);
    }

    /** Confirmed against an open payment request: kept as a merchant collection. */
    public void collected(BankTransaction tx) {
        send(tx.getMerchantId(), NotificationKind.PAYMENT_MATCHED, "Payment received",
                rwf(tx.getAmountRwf()) + " bank-confirmed" + tag(tx) + " against a payment request, not yet applied to an invoice.",
                managers(tx.getMerchantId()), "collected:" + tx.getId(), tx, null);
    }

    public void reversed(BankTransaction tx, List<Invoice> affected) {
        Set<UUID> recipients = new LinkedHashSet<>(managers(tx.getMerchantId()));
        affected.forEach(i -> recipients.addAll(cashierOf(tx.getMerchantId(), i)));
        StringBuilder body = new StringBuilder(rwf(tx.getAmountRwf()) + " from " + tx.getPayerDisplayName() + tag(tx) + " was reversed.");
        if (!affected.isEmpty()) {
            body.append(" Affected: ").append(String.join(", ", affected.stream().map(Invoice::getInvoiceNumber).toList())).append('.');
        }
        send(tx.getMerchantId(), NotificationKind.PAYMENT_REVERSED, "Payment reversed by the bank", body.toString(),
                new ArrayList<>(recipients), "reversed:" + tx.getId(), tx, affected.isEmpty() ? null : affected.get(0).getId());
    }

    private void send(UUID merchantId, NotificationKind kind, String title, String body, List<UUID> recipients,
                      String dedupeKey, BankTransaction tx, UUID invoiceId) {
        for (UUID recipient : new LinkedHashSet<>(recipients)) {
            // ON CONFLICT DO NOTHING: a replay or a race can never create a second notification.
            jdbc.sql("insert into notifications (id, merchant_id, recipient_user_id, kind, title, body, related_bank_transaction_id, "
                            + "related_invoice_id, dedupe_key, is_simulated, created_at) "
                            + "values (:id, :m, :r, :k, :t, :b, :tx, :inv, :d, :sim, :now) "
                            + "on conflict (recipient_user_id, dedupe_key) do nothing")
                    .param("id", UUID.randomUUID()).param("m", merchantId).param("r", recipient).param("k", kind.name())
                    .param("t", title).param("b", body.length() > 500 ? body.substring(0, 500) : body)
                    .param("tx", tx.getId()).param("inv", invoiceId)
                    .param("d", dedupeKey.length() > 200 ? dedupeKey.substring(0, 200) : dedupeKey)
                    .param("sim", tx.isSimulated()).param("now", java.sql.Timestamp.from(clock.instant()))
                    .update();
        }
    }

    private List<UUID> managers(UUID merchantId) {
        return memberships.findByMerchantId(merchantId).stream()
                .filter(m -> m.getStatus() == MembershipStatus.ACTIVE && (m.getRole() == Role.OWNER || m.getRole() == Role.MANAGER))
                .filter(m -> users.findById(m.getUserId()).filter(u -> u.getStatus() == UserStatus.ACTIVE).isPresent())
                .map(m -> m.getUserId()).toList();
    }

    /** The cashier responsible for an invoice, if they still have active access. */
    private List<UUID> cashierOf(UUID merchantId, Invoice invoice) {
        return memberships.findByUserIdAndMerchantId(invoice.getAssignedToUserId(), merchantId)
                .filter(m -> m.getStatus() == MembershipStatus.ACTIVE)
                .filter(m -> users.findById(m.getUserId()).filter(u -> u.getStatus() == UserStatus.ACTIVE).isPresent())
                .map(m -> List.of(m.getUserId())).orElse(List.of());
    }

    private List<UUID> recipientsWithCashier(UUID merchantId, Invoice invoice) {
        List<UUID> all = new ArrayList<>(managers(merchantId));
        all.addAll(cashierOf(merchantId, invoice));
        return all;
    }

    static String rwf(long amount) {
        return String.format(Locale.ENGLISH, "RWF %,d", amount);
    }

    private static String tag(BankTransaction tx) {
        return tx.isSimulated() ? " (simulated)" : "";
    }
}
