package rw.oupay.reservation;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.util.Collection;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeSet;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

/**
 * Branch-scoped STOCK RESERVATIONS (R7b). Three quantities are kept apart, always in the item's canonical unit, exactly:
 * <pre>
 *   physical  = inventory_balances.quantity_on_hand   (moved ONLY by R5c stock movements, the append-only ledger)
 *   reserved  = sum of the lines of ACTIVE reservations
 *   available = physical - reserved
 * </pre>
 * A reservation never changes physical stock and posts no stock movement; fulfilment (the SALE movement) belongs to R7c.
 *
 * <p><b>Locking.</b> Everything that changes stock or reservations for a branch and item serialises on that item's balance row (the lock
 * every R5c movement already takes). {@link #lockAndRead} takes the balance rows of a set of items in ASCENDING item order, so two carts
 * that overlap can never deadlock with each other, and a reservation and a stock adjustment can not both succeed against the same
 * remaining stock. The database re-checks it (V17): a reservation line is inserted only if the available stock covers it, and a balance
 * can not fall below what is reserved.
 *
 * <p>This class does no authorisation: its callers (the POS billing service, the inventory service) authorise first.
 */
@Service
public class StockReservationService {

    /** Physical and reserved stock of one item at one branch (canonical unit). */
    public record Position(UUID itemId, BigDecimal physical, BigDecimal reserved) {
        public BigDecimal available() {
            return physical.subtract(reserved);
        }
    }

    /** One line to reserve: one invoice line of goods, with the canonical quantity and what was entered. */
    public record Line(UUID invoiceItemId, UUID itemId, String measurementDimension, BigDecimal quantity, String enteredQuantity, String enteredUnit,
                       String packageLabel) {}

    public record ReservationLine(UUID invoiceItemId, UUID itemId, String itemName, BigDecimal quantity, String enteredQuantity, String enteredUnit,
                                  String packageLabel) {}

    public record Reservation(UUID id, UUID invoiceId, UUID branchId, String status, Instant createdAt, Instant expiryReviewAt, Instant fulfilledAt,
                              Instant releasedAt, String releaseReason, long version, List<ReservationLine> lines) {}

    private final JdbcClient jdbc;
    private final Clock clock;

    public StockReservationService(JdbcClient jdbc, Clock clock) {
        this.jdbc = jdbc;
        this.clock = clock;
    }

    /** The current positions, without locking (informational: a preview, a list). Items with no stock record at the branch are absent. */
    @Transactional(readOnly = true)
    public Map<UUID, Position> positions(UUID merchantId, UUID branchId, Collection<UUID> itemIds) {
        return read(merchantId, branchId, itemIds, false);
    }

    /**
     * Locks the balance rows of the items (ascending item id) and returns their positions. Must run inside the caller's transaction: the
     * locks are held until it ends, which is what makes check-then-reserve atomic.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public Map<UUID, Position> lockAndRead(UUID merchantId, UUID branchId, Collection<UUID> itemIds) {
        return read(merchantId, branchId, itemIds, true);
    }

    private Map<UUID, Position> read(UUID merchantId, UUID branchId, Collection<UUID> itemIds, boolean lock) {
        Map<UUID, Position> positions = new HashMap<>();
        if (itemIds.isEmpty()) {
            return positions;
        }
        // Ascending order is THE lock order: it is applied here, in one statement, for every caller.
        TreeSet<UUID> ordered = new TreeSet<>(itemIds);
        Map<UUID, BigDecimal> physical = new HashMap<>();
        jdbc.sql("select b.item_id, b.quantity_on_hand from inventory_balances b where b.merchant_id = :m and b.branch_id = :b and b.item_id in (:ids) "
                        + "order by b.item_id" + (lock ? " for update of b" : ""))
                .param("m", merchantId).param("b", branchId).param("ids", ordered)
                .query((rs, i) -> Map.entry(rs.getObject("item_id", UUID.class), rs.getBigDecimal("quantity_on_hand")))
                .list().forEach(e -> physical.put(e.getKey(), e.getValue()));
        // Reserved stock is read in a SEPARATE statement, after the locks are held: a statement that waited for a lock keeps the snapshot it
        // started with, which would not show a reservation committed while it waited. This one starts after the lock, so it does.
        Map<UUID, BigDecimal> reserved = new HashMap<>();
        if (!physical.isEmpty()) {
            jdbc.sql("select l.item_id, sum(l.quantity) as q from stock_reservation_lines l join stock_reservations r on r.id = l.reservation_id "
                            + "where l.merchant_id = :m and l.branch_id = :b and r.status = 'ACTIVE' and l.item_id in (:ids) group by l.item_id")
                    .param("m", merchantId).param("b", branchId).param("ids", physical.keySet())
                    .query((rs, i) -> Map.entry(rs.getObject("item_id", UUID.class), rs.getBigDecimal("q")))
                    .list().forEach(e -> reserved.put(e.getKey(), e.getValue()));
        }
        physical.forEach((item, onHand) -> positions.put(item, new Position(item, onHand, reserved.getOrDefault(item, BigDecimal.ZERO))));
        return positions;
    }

    /** The reserved quantity of one item at one branch right now (used to refuse a stock adjustment that would strand a reservation). */
    @Transactional(readOnly = true)
    public BigDecimal activeReserved(UUID merchantId, UUID branchId, UUID itemId) {
        return jdbc.sql("select active_reserved_quantity(:m, :b, :i)").param("m", merchantId).param("b", branchId).param("i", itemId)
                .query(BigDecimal.class).single();
    }

    /** Reserved quantities for many balances at once (one query): key is "branchId:itemId". */
    @Transactional(readOnly = true)
    public Map<String, BigDecimal> reservedFor(UUID merchantId, Collection<UUID> branchIds, Collection<UUID> itemIds) {
        Map<String, BigDecimal> reserved = new HashMap<>();
        if (branchIds.isEmpty() || itemIds.isEmpty()) {
            return reserved;
        }
        jdbc.sql("select l.branch_id, l.item_id, sum(l.quantity) as q from stock_reservation_lines l join stock_reservations r on r.id = l.reservation_id "
                        + "where l.merchant_id = :m and r.status = 'ACTIVE' and l.branch_id in (:bs) and l.item_id in (:is) group by l.branch_id, l.item_id")
                .param("m", merchantId).param("bs", branchIds).param("is", itemIds)
                .query((rs, i) -> Map.entry(rs.getObject("branch_id", UUID.class) + ":" + rs.getObject("item_id", UUID.class), rs.getBigDecimal("q")))
                .list().forEach(e -> reserved.put(e.getKey(), e.getValue()));
        return reserved;
    }

    /**
     * Creates the ONE reservation of an invoice and its lines. The caller has already locked the balances ({@link #lockAndRead}) and
     * checked availability; the database checks again, line by line. A second reservation for the same invoice is impossible (unique).
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public UUID reserve(UUID merchantId, UUID branchId, UUID invoiceId, UUID actorUserId, Instant expiryReviewAt, List<Line> lines) {
        UUID id = UUID.randomUUID();
        Instant now = clock.instant();
        jdbc.sql("insert into stock_reservations (id, merchant_id, branch_id, invoice_id, status, created_by_user_id, created_at, expiry_review_at, version) "
                        + "values (:id, :m, :b, :inv, 'ACTIVE', :u, :now, :review, 0)")
                .param("id", id).param("m", merchantId).param("b", branchId).param("inv", invoiceId).param("u", actorUserId)
                .param("now", Timestamp.from(now)).param("review", Timestamp.from(expiryReviewAt.isBefore(now) ? now : expiryReviewAt)).update();
        for (Line line : lines) {
            jdbc.sql("insert into stock_reservation_lines (id, reservation_id, merchant_id, branch_id, invoice_item_id, item_id, item_type, measurement_dimension, "
                            + "quantity, entered_quantity, entered_unit, package_label, created_at) "
                            + "values (:id, :r, :m, :b, :ii, :item, 'GOODS', :dim, :q, :eq, :eu, :pl, :now)")
                    .param("id", UUID.randomUUID()).param("r", id).param("m", merchantId).param("b", branchId).param("ii", line.invoiceItemId())
                    .param("item", line.itemId()).param("dim", line.measurementDimension()).param("q", line.quantity()).param("eq", line.enteredQuantity())
                    .param("eu", line.enteredUnit()).param("pl", line.packageLabel()).param("now", Timestamp.from(now)).update();
        }
        return id;
    }

    @Transactional(readOnly = true)
    public Optional<Reservation> forInvoice(UUID merchantId, UUID invoiceId) {
        return jdbc.sql("select id, branch_id, status, created_at, expiry_review_at, fulfilled_at, released_at, release_reason, version "
                        + "from stock_reservations where invoice_id = :i and merchant_id = :m")
                .param("i", invoiceId).param("m", merchantId).query((rs, n) -> {
                    UUID id = rs.getObject("id", UUID.class);
                    List<ReservationLine> lines = jdbc.sql("select l.invoice_item_id, l.item_id, i.name, l.quantity, l.entered_quantity, l.entered_unit, l.package_label "
                                    + "from stock_reservation_lines l join catalog_items i on i.id = l.item_id and i.merchant_id = l.merchant_id "
                                    + "where l.reservation_id = :r order by l.created_at, l.id")
                            .param("r", id).query((r2, k) -> new ReservationLine(r2.getObject(1, UUID.class), r2.getObject(2, UUID.class), r2.getString(3),
                                    r2.getBigDecimal(4), r2.getString(5), r2.getString(6), r2.getString(7))).list();
                    Timestamp fulfilled = rs.getTimestamp("fulfilled_at");
                    Timestamp released = rs.getTimestamp("released_at");
                    return new Reservation(id, invoiceId, rs.getObject("branch_id", UUID.class), rs.getString("status"), rs.getTimestamp("created_at").toInstant(),
                            rs.getTimestamp("expiry_review_at").toInstant(), fulfilled == null ? null : fulfilled.toInstant(),
                            released == null ? null : released.toInstant(), rs.getString("release_reason"), rs.getLong("version"), lines);
                }).optional();
    }

    /** Releases an ACTIVE reservation (final). The caller has authorised and applied the release policy. */
    @Transactional(propagation = Propagation.MANDATORY)
    public boolean release(UUID merchantId, UUID reservationId, UUID actorUserId, String reason) {
        return jdbc.sql("update stock_reservations set status = 'RELEASED', released_at = :now, released_by_user_id = :u, release_reason = :why, version = version + 1 "
                        + "where id = :id and merchant_id = :m and status = 'ACTIVE'")
                .param("now", Timestamp.from(clock.instant())).param("u", actorUserId).param("why", reason).param("id", reservationId).param("m", merchantId)
                .update() == 1;
    }
}
