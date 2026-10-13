package rw.oupay.dashboard;

import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.banking.ProviderId;
import rw.oupay.ledger.BankTransactionStatus;
import rw.oupay.ledger.LedgerMath;
import rw.oupay.ledger.ReconciliationDtos.BankTransactionView;
import rw.oupay.ledger.ReconciliationService;
import rw.oupay.membership.Actor;
import rw.oupay.membership.MembershipRepository;
import rw.oupay.membership.MembershipStatus;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.membership.Permission;
import rw.oupay.membership.Role;
import rw.oupay.user.UserRepository;
import rw.oupay.user.UserStatus;

/**
 * Dashboard figures derived from the SAME ledger that transactions, allocations and invoices use, so
 * nothing is counted twice and the dashboard can never disagree with the screens it summarises.
 * verified incoming = allocated + unmatched confirmed collections. Cashiers stay inside their own invoices.
 */
@Service
public class DashboardService {

    private static final ZoneId KIGALI = ZoneId.of("Africa/Kigali");
    private static final int DAYS_SHOWN = 7;

    public record Summary(long verifiedIncomingTotal, long allocatedTotal, long unappliedConfirmedTotal, int requiresReviewCount,
                          int confirmedTransactionCount, int activeCashierCount) {}

    public record DailyActivity(UUID merchantId, String date, long confirmedAmountInRwf, long pendingAmountInRwf) {}

    public record ProviderShare(ProviderId providerId, long amountInRwf) {}

    private final ReconciliationService reconciliation;
    private final MembershipRepository memberships;
    private final UserRepository users;
    private final MerchantAccess access;

    public DashboardService(ReconciliationService reconciliation, MembershipRepository memberships, UserRepository users,
                            MerchantAccess access) {
        this.reconciliation = reconciliation;
        this.memberships = memberships;
        this.users = users;
        this.access = access;
    }

    private List<BankTransactionView> scoped(UUID merchantId, Actor actor) {
        return reconciliation.views(merchantId, actor.hasFullScope(Permission.DASHBOARD_VIEW) ? null : actor.userId());
    }

    private static boolean verified(BankTransactionView t) {
        return t.status() == BankTransactionStatus.CONFIRMED && "INCOMING".equals(t.direction());
    }

    @Transactional(readOnly = true)
    public Summary summary(UUID merchantId) {
        Actor actor = access.require(merchantId, Permission.DASHBOARD_VIEW);
        boolean full = actor.hasFullScope(Permission.DASHBOARD_VIEW);
        List<BankTransactionView> views = scoped(merchantId, actor);
        List<BankTransactionView> confirmed = views.stream().filter(DashboardService::verified).toList();
        long allocated = views.stream().mapToLong(BankTransactionView::allocatedAmount).sum();
        long verifiedIncoming = full ? confirmed.stream().mapToLong(BankTransactionView::amount).sum() : allocated;
        long unapplied = full ? confirmed.stream().mapToLong(BankTransactionView::unappliedAmount).sum() : 0;
        int review = full ? (int) views.stream().filter(v -> LedgerMath.requiresReview(v.status(), v.reviewState(), v.reconciliationStatus())).count() : 0;
        long cashiers = memberships.findByMerchantId(merchantId).stream()
                .filter(m -> m.getRole() == Role.CASHIER && m.getStatus() == MembershipStatus.ACTIVE)
                .filter(m -> users.findById(m.getUserId()).filter(u -> u.getStatus() == UserStatus.ACTIVE).isPresent())
                .count();
        return new Summary(verifiedIncoming, full ? confirmed.stream().mapToLong(BankTransactionView::allocatedAmount).sum() : allocated,
                unapplied, review, confirmed.size(), (int) cashiers);
    }

    @Transactional(readOnly = true)
    public List<BankTransactionView> recent(UUID merchantId, int limit) {
        Actor actor = access.require(merchantId, Permission.DASHBOARD_VIEW);
        return scoped(merchantId, actor).stream().limit(Math.max(1, Math.min(limit, 50))).toList();
    }

    /** The week ends on the latest day with activity, so sample data stays visible. */
    @Transactional(readOnly = true)
    public List<DailyActivity> daily(UUID merchantId) {
        Actor actor = access.require(merchantId, Permission.DASHBOARD_VIEW);
        List<BankTransactionView> views = scoped(merchantId, actor).stream()
                .filter(t -> t.status() == BankTransactionStatus.CONFIRMED || t.status() == BankTransactionStatus.PENDING).toList();
        if (views.isEmpty()) {
            return List.of();
        }
        LocalDate latest = views.stream().map(t -> day(t.providerOccurredAt())).max(Comparator.naturalOrder()).orElseThrow();
        List<DailyActivity> days = new ArrayList<>();
        for (int offset = DAYS_SHOWN - 1; offset >= 0; offset--) {
            LocalDate date = latest.minusDays(offset);
            long confirmed = views.stream().filter(t -> day(t.providerOccurredAt()).equals(date) && t.status() == BankTransactionStatus.CONFIRMED)
                    .mapToLong(BankTransactionView::amount).sum();
            long pending = views.stream().filter(t -> day(t.providerOccurredAt()).equals(date) && t.status() == BankTransactionStatus.PENDING)
                    .mapToLong(BankTransactionView::amount).sum();
            days.add(new DailyActivity(merchantId, date + "T12:00:00Z", confirmed, pending));
        }
        return days;
    }

    @Transactional(readOnly = true)
    public List<ProviderShare> providers(UUID merchantId) {
        Actor actor = access.require(merchantId, Permission.DASHBOARD_VIEW);
        Map<ProviderId, Long> totals = new EnumMap<>(ProviderId.class);
        scoped(merchantId, actor).stream().filter(DashboardService::verified)
                .forEach(t -> totals.merge(t.provider(), t.amount(), Long::sum));
        return totals.entrySet().stream().map(e -> new ProviderShare(e.getKey(), e.getValue()))
                .sorted(Comparator.comparingLong(ProviderShare::amountInRwf).reversed()).toList();
    }

    private static LocalDate day(Instant instant) {
        return instant.atZone(KIGALI).toLocalDate();
    }

}
