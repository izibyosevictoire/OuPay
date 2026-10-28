package rw.oupay.reports;

import java.time.OffsetDateTime;
import java.time.ZoneOffset;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.UUID;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.membership.Permission;

@Service
public class ReportsService {

    private static final ZoneId KIGALI = ZoneId.of("Africa/Kigali");
    private final JdbcClient jdbc;
    private final MerchantAccess access;

    public ReportsService(JdbcClient jdbc, MerchantAccess access) {
        this.jdbc = jdbc;
        this.access = access;
    }

    public record Summary(
            LocalDate from,
            LocalDate to,
            long issuedInvoiceCount,
            long issuedTotalRwf,
            long activeAllocatedToIssuedInvoicesRwf,
            long outstandingForIssuedInvoicesRwf,
            long confirmedIncomingDuringPeriodRwf,
            long unappliedConfirmedDuringPeriodRwf) {}

    @Transactional(readOnly = true)
    public Summary summary(UUID merchantId, LocalDate from, LocalDate to) {
        access.require(merchantId, Permission.REPORTS_VIEW);

        LocalDate today = LocalDate.now(KIGALI);
        LocalDate start = from == null ? today.withDayOfMonth(1) : from;
        LocalDate end = to == null ? today : to;

        if (start.isAfter(end) || !end.isBefore(start.plusYears(1))) {
            throw new ResponseStatusException(
                    HttpStatus.BAD_REQUEST,
                    "Report date range must be ordered and at most one year."
            );
        }

        OffsetDateTime startAt = start.atStartOfDay(KIGALI)
                .toInstant().atOffset(ZoneOffset.UTC);
        OffsetDateTime endExclusive = end.plusDays(1).atStartOfDay(KIGALI)
                .toInstant().atOffset(ZoneOffset.UTC);

        var invoices = jdbc.sql("""
                SELECT count(*) AS invoice_count,
                       coalesce(sum(i.grand_total_rwf), 0) AS issued_total,
                       coalesce(sum(
                           least(i.grand_total_rwf,
                                 greatest(i.grand_total_rwf
                                          - coalesce(a.allocated, 0), 0))
                       ), 0) AS outstanding,
                       coalesce(sum(coalesce(a.allocated, 0)), 0) AS allocated
                FROM invoices i
                LEFT JOIN (
                    SELECT merchant_id, invoice_id,
                           sum(amount_rwf) AS allocated
                    FROM payment_allocations
                    WHERE merchant_id = :merchantId
                      AND status = 'ACTIVE'
                    GROUP BY merchant_id, invoice_id
                ) a ON a.invoice_id = i.id
                   AND a.merchant_id = i.merchant_id
                WHERE i.merchant_id = :merchantId
                  AND i.status = 'ISSUED'
                  AND NOT i.is_demonstration
                  AND i.issued_at >= :startAt
                  AND i.issued_at < :endAt
                """)
                .param("merchantId", merchantId)
                .param("startAt", startAt)
                .param("endAt", endExclusive)
                .query((rs, rowNum) -> new long[] {
                        rs.getLong("invoice_count"),
                        rs.getLong("issued_total"),
                        rs.getLong("allocated"),
                        rs.getLong("outstanding")
                })
                .single();

        var collections = jdbc.sql("""
                SELECT
                    coalesce(sum(t.amount_rwf), 0) AS confirmed_total,
                    coalesce(sum(
                        greatest(t.amount_rwf - coalesce(a.allocated, 0), 0)
                    ), 0) AS unapplied_total
                FROM bank_transactions t
                LEFT JOIN (
                    SELECT merchant_id, bank_transaction_id,
                           sum(amount_rwf) AS allocated
                    FROM payment_allocations
                    WHERE merchant_id = :merchantId
                      AND status = 'ACTIVE'
                    GROUP BY merchant_id, bank_transaction_id
                ) a ON a.bank_transaction_id = t.id
                   AND a.merchant_id = t.merchant_id
                WHERE t.merchant_id = :merchantId
                  AND t.direction = 'INCOMING'
                  AND t.status = 'CONFIRMED'
                  AND t.provider_occurred_at >= :startAt
                  AND t.provider_occurred_at < :endAt
                """)
                .param("merchantId", merchantId)
                .param("startAt", startAt)
                .param("endAt", endExclusive)
                .query((rs, rowNum) -> new long[] {
                        rs.getLong("confirmed_total"),
                        rs.getLong("unapplied_total")
                })
                .single();

        return new Summary(
                start,
                end,
                invoices[0],
                invoices[1],
                invoices[2],
                invoices[3],
                collections[0],
                collections[1]
        );
    }
}
