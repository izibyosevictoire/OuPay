package rw.oupay.pos;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeSet;
import java.util.UUID;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.support.TransactionTemplate;
import rw.oupay.audit.AuditService;
import rw.oupay.measurement.MeasurementDimension;
import rw.oupay.reservation.StockReservationService;

/**
 * VERIFIED-PAYMENT INVENTORY FULFILMENT (R7c). When a LIVE POS sale is paid in full through bank money that R6d-B has RECONCILED (active
 * allocations covering the invoice), its ACTIVE reservation becomes FULFILLED and one SALE stock movement per reservation line deducts the
 * physical stock, in ONE transaction. Nothing is reserved here, nothing is released, and no stock ledger other than the R5c movements exists.
 *
 * <p><b>What it does NOT mean.</b> "Posted" says the stock ledger was updated. It is not proof that the goods were handed over (not tracked in
 * R7c), and an invoice being PAID never means "fulfilled": only a posting does.
 *
 * <h2>Where it runs</h2>
 * Never inside the bank-event transaction. {@link PosFulfilmentWorker} calls {@link #processDue} later, after the allocation has COMMITTED; the
 * allocation (R6d-B) is the only authority that a sale is paid, and this class only reads it. Each sale is posted in its OWN transaction, so one
 * sale's failure never blocks another's.
 *
 * <h2>Lock order</h2>
 * <ol>
 *   <li>the invoice row (FOR UPDATE): the lock a release and an allocation already take, so a posting and a release take turns, and then the
 *       ACTIVE allocation rows of the invoice (FOR SHARE), which is what makes a posting and a bank REVERSAL take turns (a reversal does not lock the
 *       invoice: it locks the bank transaction and updates its allocations, so those rows are the lock it can not avoid);</li>
 *   <li>the {@code pos_fulfilments} row (FOR UPDATE): concurrent workers take turns, and a second one finds the first one's result;</li>
 *   <li>the reservation row (FOR UPDATE);</li>
 *   <li>the stock balance rows of the sale's goods in ASCENDING item id (FOR UPDATE): the lock every stock movement and every billing takes;</li>
 *   <li>then the writes: reservation to FULFILLED, one SALE movement per line, one posting per line, the fulfilment to POSTED.</li>
 * </ol>
 * Billing locks (draft, balances ascending) and then only rows of the NEW invoice, which no posting can see yet; a release locks invoice then
 * reservation; an allocation locks the bank transaction then invoices; a stock movement locks only its balance. Each of them takes a prefix of this
 * order, or rows no posting can hold, so no cycle exists.
 *
 * <h2>Idempotency</h2>
 * One fulfilment per sale (primary key), one posting per reservation line (primary key), one movement per posting (unique), and every movement
 * carries a DETERMINISTIC operation id derived from its reservation line (unique per business): a crash, a retry or a second worker can never deduct a
 * line twice. The database also checks, at commit, that a FULFILLED reservation, its POSTED fulfilment and one posting per line exist together.
 *
 * <h2>When it does not post, it says so</h2>
 * A sale that was released before its payment was reconciled, that can not be covered by physical stock, whose payment was reversed after the posting,
 * or whose automatic attempts all failed becomes an OPEN, durable EXCEPTION for a person to resolve. Nothing is re-reserved, nothing is deducted
 * without an authorised decision, the verified payment and its allocations are untouched, and no stock movement is ever rewritten or deleted.
 */
@Service
public class PosFulfilmentService {

    private static final Logger log = LoggerFactory.getLogger(PosFulfilmentService.class);

    /** What one sale's processing did. */
    public enum Outcome { POSTED, EXCEPTION_OPENED, REVERSAL_RECORDED, NOT_ELIGIBLE, ALREADY_DONE }

    public record Summary(int posted, int exceptions, int reversals, int failed) {}

    private record Sale(UUID saleId, UUID merchantId, UUID invoiceId, UUID branchId, long total, String mode, String reference) {}

    private record Line(UUID id, UUID itemId, BigDecimal quantity, String enteredQuantity, String enteredUnit, String packageLabel) {}

    private final JdbcClient jdbc;
    private final TransactionTemplate transactions;
    private final StockReservationService reservations;
    private final AuditService audit;
    private final Clock clock;
    private final int maxAttempts;
    private final Duration backoffBase;

    public PosFulfilmentService(JdbcClient jdbc, TransactionTemplate transactions, StockReservationService reservations, AuditService audit, Clock clock,
                                @Value("${oupay.pos.fulfilment.max-attempts:5}") int maxAttempts,
                                @Value("${oupay.pos.fulfilment.backoff:PT1M}") Duration backoffBase) {
        this.jdbc = jdbc;
        this.transactions = transactions;
        this.reservations = reservations;
        this.audit = audit;
        this.clock = clock;
        this.maxAttempts = Math.max(1, maxAttempts);
        this.backoffBase = backoffBase.isNegative() ? Duration.ZERO : backoffBase;
    }

    // ---- the worker's entry point ----------------------------------------------------------------------------------------------

    /**
     * Processes every sale that is due: paid in full through active allocations and not yet posted (or due for a retry), and posted sales whose payment
     * has since been reversed. Safe to call from any number of workers at once.
     */
    public Summary processDue(int limit) {
        int posted = 0;
        int exceptions = 0;
        int reversals = 0;
        int failed = 0;
        for (UUID saleId : dueSales(limit)) {
            try {
                Outcome outcome = transactions.execute(status -> fulfil(saleId));
                if (outcome == Outcome.POSTED) {
                    posted++;
                } else if (outcome == Outcome.EXCEPTION_OPENED) {
                    exceptions++;
                } else if (outcome == Outcome.REVERSAL_RECORDED) {
                    reversals++;
                }
            } catch (RuntimeException e) {
                failed++;
                log.warn("POS fulfilment of sale {} failed: {}", saleId, e.toString());
                try {
                    transactions.executeWithoutResult(status -> recordFailure(saleId, e));
                } catch (RuntimeException inner) {
                    log.error("could not record the failure of the fulfilment of sale {}", saleId, inner);
                }
            }
        }
        return new Summary(posted, exceptions, reversals, failed);
    }

    private List<UUID> dueSales(int limit) {
        // (1) Paid in full by active allocations, with an ACTIVE or RELEASED reservation, and either never processed or due for a retry.
        List<UUID> due = new ArrayList<>(jdbc.sql("select s.payment_request_id from pos_sales s join stock_reservations r on r.invoice_id = s.invoice_id "
                        + "left join pos_fulfilments f on f.sale_id = s.payment_request_id "
                        + "where s.presentation_mode = 'LIVE' and r.status in ('ACTIVE', 'RELEASED') "
                        + "and (f.sale_id is null or (f.status = 'PENDING' and coalesce(f.next_attempt_at, :now) <= :now)) "
                        + "and (select coalesce(sum(pa.amount_rwf), 0) from payment_allocations pa where pa.invoice_id = s.invoice_id and pa.status = 'ACTIVE') >= s.total_rwf "
                        + "order by s.created_at limit :n")
                .param("now", Timestamp.from(clock.instant())).param("n", limit).query(UUID.class).list());
        // (2) Posted sales whose payment is no longer covered: a reversal after the stock was deducted.
        due.addAll(jdbc.sql("select s.payment_request_id from pos_fulfilments f join pos_sales s on s.payment_request_id = f.sale_id where f.status = 'POSTED' "
                        + "and (select coalesce(sum(pa.amount_rwf), 0) from payment_allocations pa where pa.invoice_id = s.invoice_id and pa.status = 'ACTIVE') < s.total_rwf "
                        + "and not exists (select 1 from pos_fulfilment_exceptions e where e.sale_id = s.payment_request_id and e.kind = 'PAYMENT_REVERSED_AFTER_POSTING' "
                        + "and e.status = 'OPEN') order by s.created_at limit :n").param("n", limit).query(UUID.class).list());
        return due;
    }

    // ---- one sale, one transaction ---------------------------------------------------------------------------------------------

    /** Posts (or explains why it can not post) ONE sale. Must run inside a transaction. */
    Outcome fulfil(UUID saleId) {
        Sale sale = jdbc.sql("select s.payment_request_id, s.merchant_id, s.invoice_id, s.branch_id, s.total_rwf, s.presentation_mode, c.sale_reference "
                        + "from pos_sales s join code_sales c on c.payment_request_id = s.payment_request_id and c.merchant_id = s.merchant_id "
                        + "where s.payment_request_id = :id").param("id", saleId)
                .query((rs, i) -> new Sale(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getObject(3, UUID.class), rs.getObject(4, UUID.class),
                        rs.getLong(5), rs.getString(6), rs.getString(7))).optional().orElse(null);
        if (sale == null || !"LIVE".equals(sale.mode())) {
            return Outcome.NOT_ELIGIBLE; // a demonstration has no real stock, payment or fulfilment
        }
        // 1. The invoice.
        jdbc.sql("select id from invoices where id = :i and merchant_id = :m for update").param("i", sale.invoiceId()).param("m", sale.merchantId())
                .query(UUID.class).single();
        long applied = appliedTo(sale);
        // 2. The fulfilment row, if there is one.
        Optional<String> status = jdbc.sql("select status from pos_fulfilments where sale_id = :id for update").param("id", saleId).query(String.class).optional();
        if (status.isPresent() && "POSTED".equals(status.get())) {
            return applied < sale.total() ? recordReversal(sale, applied) : Outcome.ALREADY_DONE;
        }
        if (status.isPresent() && "EXCEPTION".equals(status.get())) {
            return Outcome.ALREADY_DONE; // a person decides: never retried automatically
        }
        if (applied < sale.total()) {
            return Outcome.NOT_ELIGIBLE; // partial, unpaid or reversed before posting: nothing to do
        }
        Optional<UUID> reservationId = jdbc.sql("select id from stock_reservations where invoice_id = :i and merchant_id = :m").param("i", sale.invoiceId())
                .param("m", sale.merchantId()).query(UUID.class).optional();
        if (reservationId.isEmpty()) {
            return Outcome.NOT_ELIGIBLE; // a sale of services only: no goods, no stock movement
        }
        if (status.isEmpty()) {
            Instant now = clock.instant();
            jdbc.sql("insert into pos_fulfilments (sale_id, merchant_id, invoice_id, branch_id, reservation_id, status, attempts, created_at, updated_at) "
                            + "values (:id, :m, :i, :b, :r, 'PENDING', 0, :now, :now) on conflict (sale_id) do nothing")
                    .param("id", saleId).param("m", sale.merchantId()).param("i", sale.invoiceId()).param("b", sale.branchId()).param("r", reservationId.get())
                    .param("now", Timestamp.from(now)).update();
            jdbc.sql("select status from pos_fulfilments where sale_id = :id for update").param("id", saleId).query(String.class).single();
        }
        // 3. The reservation.
        String reservationStatus = jdbc.sql("select status from stock_reservations where id = :r for update").param("r", reservationId.get()).query(String.class).single();
        if ("RELEASED".equals(reservationStatus)) {
            // PAID after the owner released the stock: never re-reserved, never deducted without a decision. The payment and its allocations are untouched.
            return openException(sale, "RESERVATION_RELEASED", "The sale was paid in full after its stock reservation was released. Nothing was deducted and nothing was "
                    + "re-reserved: an owner must decide whether the goods can still be supplied.");
        }
        if (!"ACTIVE".equals(reservationStatus)) {
            throw new IllegalStateException("the reservation of sale " + saleId + " is " + reservationStatus + " but its fulfilment is not posted");
        }
        return post(sale, reservationId.get());
    }

    private Outcome post(Sale sale, UUID reservationId) {
        List<Line> lines = jdbc.sql("select id, item_id, quantity, entered_quantity, entered_unit, package_label from stock_reservation_lines where reservation_id = :r "
                        + "order by item_id, id").param("r", reservationId)
                .query((rs, i) -> new Line(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getBigDecimal(3), rs.getString(4), rs.getString(5), rs.getString(6)))
                .list();
        // 4. The balances, ascending. The reservation is still ACTIVE here, so every other reservation of these items is still counted.
        Map<UUID, StockReservationService.Position> positions = reservations.lockAndRead(sale.merchantId(), sale.branchId(),
                new TreeSet<>(lines.stream().map(Line::itemId).toList()));
        Map<UUID, BigDecimal> needed = new LinkedHashMap<>();
        for (Line line : lines) {
            needed.merge(line.itemId(), line.quantity(), BigDecimal::add);
        }
        for (Map.Entry<UUID, BigDecimal> need : needed.entrySet()) {
            StockReservationService.Position position = positions.get(need.getKey());
            if (position == null || position.physical().compareTo(need.getValue()) < 0) {
                // Physical stock can not cover what was reserved (the database makes this impossible through the normal paths): nothing is written.
                return openException(sale, "INSUFFICIENT_STOCK", "Physical stock can not cover this paid sale (" + PosService.plain(need.getValue())
                        + " needed, " + (position == null ? "no stock record" : PosService.plain(position.physical()) + " on hand") + "). Nothing was deducted.");
            }
        }
        Instant now = clock.instant();
        // 5. The reservation first (its quantities stop counting as reserved), then every movement: the balance guard compares the NEW physical stock
        //    with the reservations that remain.
        int updated = jdbc.sql("update stock_reservations set status = 'FULFILLED', fulfilled_at = :now, version = version + 1 where id = :r and status = 'ACTIVE'")
                .param("now", Timestamp.from(now)).param("r", reservationId).update();
        if (updated != 1) {
            throw new IllegalStateException("the reservation of sale " + sale.saleId() + " is no longer active");
        }
        Map<UUID, BigDecimal> running = new HashMap<>();
        positions.forEach((item, p) -> running.put(item, p.physical()));
        for (Line line : lines) {
            BigDecimal after = running.get(line.itemId()).subtract(line.quantity());
            UUID movementId = UUID.randomUUID();
            jdbc.sql("insert into stock_movements (id, merchant_id, branch_id, item_id, movement_type, quantity_delta, balance_after, entered_as, reason, reference, "
                            + "operation_id, request_sha256, actor_user_id, created_at) values (:id, :m, :b, :item, 'SALE', :delta, :after, :entered, :reason, :ref, :op, :sha, null, :now)")
                    .param("id", movementId).param("m", sale.merchantId()).param("b", sale.branchId()).param("item", line.itemId()).param("delta", line.quantity().negate())
                    .param("after", after).param("entered", abbreviate(enteredAs(line), 160))
                    .param("reason", abbreviate("Paid in full: reconciled bank payment of sale " + sale.reference(), 200)).param("ref", sale.reference())
                    .param("op", operationId(line.id())).param("sha", sha256("pos-fulfilment|" + line.id() + "|" + line.quantity().toPlainString() + "|" + sale.saleId()))
                    .param("now", Timestamp.from(now)).update();
            jdbc.sql("insert into pos_fulfilment_lines (reservation_line_id, sale_id, merchant_id, branch_id, item_id, movement_id, quantity, created_at) "
                            + "values (:l, :s, :m, :b, :item, :mv, :q, :now)")
                    .param("l", line.id()).param("s", sale.saleId()).param("m", sale.merchantId()).param("b", sale.branchId()).param("item", line.itemId())
                    .param("mv", movementId).param("q", line.quantity()).param("now", Timestamp.from(now)).update();
            running.put(line.itemId(), after);
        }
        jdbc.sql("update pos_fulfilments set status = 'POSTED', posted_at = :now, attempts = attempts + 1, last_attempt_at = :now, next_attempt_at = null, last_error = null, "
                        + "updated_at = :now where sale_id = :id").param("now", Timestamp.from(now)).param("id", sale.saleId()).update();
        event(sale, "POSTED", "Stock deducted for " + lines.size() + " reserved line(s): physical stock updated by SALE movements.", now);
        audit.record(sale.merchantId(), null, "POS_FULFILMENT_POSTED", "invoice", sale.invoiceId(),
                "Paid POS sale " + sale.reference() + ": " + lines.size() + " reserved line(s) deducted from physical stock (stock ledger only; handover is not tracked).");
        return Outcome.POSTED;
    }

    // ---- exceptions ----------------------------------------------------------------------------------------------------------

    private Outcome openException(Sale sale, String kind, String detail) {
        Instant now = clock.instant();
        jdbc.sql("insert into pos_fulfilment_exceptions (id, merchant_id, sale_id, kind, status, detail, opened_at) values (:id, :m, :s, :k, 'OPEN', :d, :now) "
                        + "on conflict do nothing").param("id", UUID.randomUUID()).param("m", sale.merchantId()).param("s", sale.saleId()).param("k", kind)
                .param("d", abbreviate(detail, 500)).param("now", Timestamp.from(now)).update();
        jdbc.sql("update pos_fulfilments set status = 'EXCEPTION', next_attempt_at = null, last_attempt_at = :now, last_error = :e, updated_at = :now where sale_id = :id")
                .param("now", Timestamp.from(now)).param("e", abbreviate(kind, 300)).param("id", sale.saleId()).update();
        event(sale, "EXCEPTION_OPENED", kind + ": " + detail, now);
        audit.record(sale.merchantId(), null, "POS_FULFILMENT_EXCEPTION", "invoice", sale.invoiceId(), "Paid POS sale " + sale.reference() + " needs attention: " + kind + ".");
        return Outcome.EXCEPTION_OPENED;
    }

    /** The payment was reversed after the stock was deducted. The SALE movements stay; stock is NOT restored (no goods came back). */
    private Outcome recordReversal(Sale sale, long applied) {
        boolean open = jdbc.sql("select count(*) from pos_fulfilment_exceptions where sale_id = :s and kind = 'PAYMENT_REVERSED_AFTER_POSTING' and status = 'OPEN'")
                .param("s", sale.saleId()).query(Long.class).single() > 0;
        if (open) {
            return Outcome.ALREADY_DONE;
        }
        Instant now = clock.instant();
        String detail = "The payment of this sale was reversed after its stock was deducted (RWF " + applied + " of " + sale.total() + " is still applied). The SALE movements "
                + "are kept and stock was NOT restored: restore it only through a return or a correction once the goods are actually back.";
        jdbc.sql("insert into pos_fulfilment_exceptions (id, merchant_id, sale_id, kind, status, detail, opened_at) values (:id, :m, :s, 'PAYMENT_REVERSED_AFTER_POSTING', 'OPEN', :d, :now) "
                        + "on conflict do nothing").param("id", UUID.randomUUID()).param("m", sale.merchantId()).param("s", sale.saleId()).param("d", abbreviate(detail, 500))
                .param("now", Timestamp.from(now)).update();
        event(sale, "EXCEPTION_OPENED", "PAYMENT_REVERSED_AFTER_POSTING: " + detail, now);
        audit.record(sale.merchantId(), null, "POS_FULFILMENT_EXCEPTION", "invoice", sale.invoiceId(),
                "Paid POS sale " + sale.reference() + " was reversed after its stock was deducted: PAYMENT_REVERSED_AFTER_POSTING.");
        return Outcome.REVERSAL_RECORDED;
    }

    /** After a failed attempt (its transaction rolled back): count it, back off, and after the last attempt make it an exception that needs attention. */
    void recordFailure(UUID saleId, RuntimeException failure) {
        Sale sale = jdbc.sql("select s.payment_request_id, s.merchant_id, s.invoice_id, s.branch_id, s.total_rwf, s.presentation_mode, c.sale_reference "
                        + "from pos_sales s join code_sales c on c.payment_request_id = s.payment_request_id where s.payment_request_id = :id").param("id", saleId)
                .query((rs, i) -> new Sale(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getObject(3, UUID.class), rs.getObject(4, UUID.class),
                        rs.getLong(5), rs.getString(6), rs.getString(7))).optional().orElse(null);
        if (sale == null) {
            return;
        }
        Instant now = clock.instant();
        UUID reservationId = jdbc.sql("select id from stock_reservations where invoice_id = :i").param("i", sale.invoiceId()).query(UUID.class).optional().orElse(null);
        if (reservationId == null) {
            return;
        }
        jdbc.sql("insert into pos_fulfilments (sale_id, merchant_id, invoice_id, branch_id, reservation_id, status, attempts, created_at, updated_at) "
                        + "values (:id, :m, :i, :b, :r, 'PENDING', 0, :now, :now) on conflict (sale_id) do nothing").param("id", saleId).param("m", sale.merchantId())
                .param("i", sale.invoiceId()).param("b", sale.branchId()).param("r", reservationId).param("now", Timestamp.from(now)).update();
        // The ROOT cause says what really failed (a wrapper only says that a statement did).
        Throwable root = org.springframework.core.NestedExceptionUtils.getMostSpecificCause(failure);
        String error = abbreviate(root.getClass().getSimpleName() + ": " + String.valueOf(root.getMessage()), 300);
        Integer attempts = jdbc.sql("update pos_fulfilments set attempts = attempts + 1, last_attempt_at = :now, last_error = :e, updated_at = :now, "
                        + "next_attempt_at = :next where sale_id = :id and status = 'PENDING' returning attempts")
                .param("now", Timestamp.from(now)).param("e", error).param("next", Timestamp.from(now.plus(backoffFor(1))))
                .param("id", saleId).query(Integer.class).optional().orElse(null);
        if (attempts == null) {
            return; // someone posted it, or it became an exception, in the meantime
        }
        // The real back-off depends on the attempt number.
        jdbc.sql("update pos_fulfilments set next_attempt_at = :next where sale_id = :id and status = 'PENDING'")
                .param("next", Timestamp.from(now.plus(backoffFor(attempts)))).param("id", saleId).update();
        event(sale, "ATTEMPT_FAILED", "Attempt " + attempts + " failed: " + error, now);
        if (attempts >= maxAttempts) {
            openException(sale, "PROCESSING_FAILED", "Posting this paid sale failed " + attempts + " times and is no longer retried automatically. Last error: " + error);
        }
    }

    private Duration backoffFor(int attempt) {
        long factor = 1L << Math.min(Math.max(attempt - 1, 0), 10);
        Duration wait = backoffBase.multipliedBy(factor);
        return wait.compareTo(Duration.ofHours(2)) > 0 ? Duration.ofHours(2) : wait;
    }

    // ---- helpers -----------------------------------------------------------------------------------------------------------------

    /**
     * What is applied to the invoice RIGHT NOW, and it stays applied until this transaction ends: the active allocation rows are locked FOR SHARE.
     * The invoice lock alone is NOT enough, because a bank reversal (R6d-B) locks the bank transaction and updates its allocations without taking the
     * invoice lock. A reversal that has already updated an allocation makes this wait for it and then see it REVERSED (no posting); a reversal that
     * comes later waits for this transaction (the posting happens first, and the next worker run records the reversal as an exception). Either way
     * the decision and the money it relied on can not change between the check and the commit.
     */
    private long appliedTo(Sale sale) {
        return jdbc.sql("select amount_rwf from payment_allocations where invoice_id = :i and merchant_id = :m and status = 'ACTIVE' for share")
                .param("i", sale.invoiceId()).param("m", sale.merchantId()).query(Long.class).list().stream().mapToLong(Long::longValue).sum();
    }

    private void event(Sale sale, String kind, String detail, Instant at) {
        jdbc.sql("insert into pos_fulfilment_events (merchant_id, sale_id, kind, detail, created_at) values (:m, :s, :k, :d, :at)").param("m", sale.merchantId())
                .param("s", sale.saleId()).param("k", kind).param("d", abbreviate(detail, 500)).param("at", Timestamp.from(at)).update();
    }

    private static String enteredAs(Line line) {
        return line.packageLabel() != null ? line.enteredQuantity() + " x " + line.packageLabel() : line.enteredQuantity() + " " + line.enteredUnit();
    }

    /** The durable identity of one deduction: the same reservation line always gives the same id, so it can be recorded once, whatever happens. */
    static UUID operationId(UUID reservationLineId) {
        return UUID.nameUUIDFromBytes(("oupay-pos-fulfilment:" + reservationLineId).getBytes(StandardCharsets.UTF_8));
    }

    private static String sha256(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is not available", e);
        }
    }

    private static String abbreviate(String text, int max) {
        return text.length() <= max ? text : text.substring(0, max - 3) + "...";
    }

    // ---- reading (no authorisation here: the callers authorise) -----------------------------------------------------------------

    /** The four facts of a sale fulfilment, as they are now. */
    public PosBillingDtos.FulfilmentView view(UUID merchantId, UUID saleId) {
        var head = jdbc.sql("select s.invoice_id, s.branch_id, s.total_rwf, s.presentation_mode from pos_sales s where s.payment_request_id = :id and s.merchant_id = :m")
                .param("id", saleId).param("m", merchantId)
                .query((rs, i) -> new Object[] {rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getLong(3), rs.getString(4)}).optional().orElseThrow();
        UUID invoiceId = (UUID) head[0];
        UUID branchId = (UUID) head[1];
        long total = (Long) head[2];
        boolean demo = "DEMONSTRATION".equals(head[3]);
        if (demo) {
            return new PosBillingDtos.FulfilmentView("NOT_APPLICABLE", 0, total, "NOT_APPLICABLE", null, 0, null, null, List.of(), List.of(), List.of(), "NOT_TRACKED",
                    PosBillingDtos.DEMO_FULFILMENT_NOTE);
        }
        var money = jdbc.sql("select coalesce(sum(amount_rwf) filter (where status = 'ACTIVE'), 0), count(*) filter (where status = 'REVERSED') from payment_allocations "
                        + "where invoice_id = :i and merchant_id = :m").param("i", invoiceId).param("m", merchantId)
                .query((rs, i) -> new long[] {rs.getLong(1), rs.getLong(2)}).single();
        long applied = money[0];
        String paymentState = applied >= total ? "PAID" : applied > 0 ? "PARTIAL" : money[1] > 0 ? "REVERSED" : "UNPAID";
        boolean hasReservation = jdbc.sql("select count(*) from stock_reservations where invoice_id = :i").param("i", invoiceId).query(Long.class).single() > 0;
        var row = jdbc.sql("select status, posted_at, attempts, next_attempt_at, last_error from pos_fulfilments where sale_id = :id").param("id", saleId)
                .query((rs, i) -> new Object[] {rs.getString(1), rs.getTimestamp(2), rs.getInt(3), rs.getTimestamp(4), rs.getString(5)}).optional().orElse(null);
        String inventoryState = !hasReservation ? "NOT_REQUIRED" : row == null || "PENDING".equals(row[0]) ? "NOT_POSTED" : (String) row[0];
        List<PosBillingDtos.FulfilmentLine> lines = new ArrayList<>();
        if ("POSTED".equals(inventoryState)) {
            record Posted(UUID item, String name, BigDecimal quantity, String dimension, UUID movement) {}
            List<Posted> posted = jdbc.sql("select l.item_id, i.name, l.quantity, i.measurement_dimension, l.movement_id from pos_fulfilment_lines l "
                            + "join catalog_items i on i.id = l.item_id and i.merchant_id = l.merchant_id where l.sale_id = :s order by l.created_at, l.reservation_line_id")
                    .param("s", saleId).query((rs, i) -> new Posted(rs.getObject(1, UUID.class), rs.getString(2), rs.getBigDecimal(3), rs.getString(4),
                            rs.getObject(5, UUID.class))).list();
            Map<UUID, StockReservationService.Position> positions = reservations.positions(merchantId, branchId, posted.stream().map(Posted::item).distinct().toList());
            for (Posted p : posted) {
                StockReservationService.Position position = positions.get(p.item());
                lines.add(new PosBillingDtos.FulfilmentLine(p.item(), p.name(), PosService.plain(p.quantity()), MeasurementDimension.valueOf(p.dimension()).canonicalUnit().code(),
                        p.movement(), position == null ? null : PosService.plain(position.physical()), position == null ? null : PosService.plain(position.available())));
            }
        }
        return new PosBillingDtos.FulfilmentView(paymentState, applied, total, inventoryState, row == null || row[1] == null ? null : ((Timestamp) row[1]).toInstant(),
                row == null ? 0 : (Integer) row[2], row == null || row[3] == null ? null : ((Timestamp) row[3]).toInstant(), row == null ? null : (String) row[4], lines,
                exceptionsOf(merchantId, saleId, false), eventsOf(merchantId, saleId), "NOT_TRACKED", PosBillingDtos.HANDOVER_NOTE);
    }

    private List<PosBillingDtos.FulfilmentEvent> eventsOf(UUID merchantId, UUID saleId) {
        return jdbc.sql("select kind, detail, created_at from pos_fulfilment_events where merchant_id = :m and sale_id = :s order by id").param("m", merchantId)
                .param("s", saleId).query((rs, i) -> new PosBillingDtos.FulfilmentEvent(rs.getString(1), rs.getString(2), rs.getTimestamp(3).toInstant())).list();
    }

    /** The exceptions of one sale, or (with merchantWide) every OPEN exception of the business, newest first. */
    public List<PosBillingDtos.FulfilmentIssue> exceptionsOf(UUID merchantId, UUID saleId, boolean merchantWide) {
        record Row(UUID id, UUID sale, String reference, String number, String kind, String status, String detail, Instant at) {}
        List<Row> rows = jdbc.sql("select e.id, e.sale_id, c.sale_reference, inv.invoice_number, e.kind, e.status, e.detail, e.opened_at from pos_fulfilment_exceptions e "
                        + "join code_sales c on c.payment_request_id = e.sale_id and c.merchant_id = e.merchant_id join invoices inv on inv.id = c.invoice_id and inv.merchant_id = c.merchant_id "
                        + "where e.merchant_id = :m and ((:wide = true and e.status = 'OPEN') or (:wide = false and e.sale_id = :s)) order by e.opened_at desc, e.id limit 200")
                .param("m", merchantId).param("wide", merchantWide).param("s", saleId == null ? new UUID(0, 0) : saleId)
                .query((rs, i) -> new Row(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3), rs.getString(4), rs.getString(5), rs.getString(6),
                        rs.getString(7), rs.getTimestamp(8).toInstant())).list();
        List<PosBillingDtos.FulfilmentIssue> result = new ArrayList<>();
        for (Row r : rows) {
            result.add(new PosBillingDtos.FulfilmentIssue(r.id(), r.sale(), r.reference(), r.number(), r.kind(), r.status(), r.detail(), r.at(),
                    merchantWide ? eventsOf(merchantId, r.sale()) : List.of()));
        }
        return result;
    }
}
