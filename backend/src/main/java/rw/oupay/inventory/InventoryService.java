package rw.oupay.inventory;

import jakarta.persistence.EntityManager;
import java.math.BigDecimal;
import java.math.RoundingMode;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.Collection;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import java.util.regex.Pattern;
import java.util.stream.Collectors;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.branch.Branch;
import rw.oupay.branch.BranchAssignment;
import rw.oupay.branch.BranchAssignmentRepository;
import rw.oupay.branch.BranchRepository;
import rw.oupay.catalog.CatalogItem;
import rw.oupay.catalog.CatalogItemRepository;
import rw.oupay.catalog.CatalogItemType;
import rw.oupay.catalog.CatalogPackage;
import rw.oupay.catalog.CatalogPackageRepository;
import rw.oupay.common.ApiException;
import rw.oupay.common.DatabaseErrors;
import rw.oupay.common.Pagination;
import rw.oupay.idempotency.IdempotencyService;
import rw.oupay.measurement.MeasuredQuantity;
import rw.oupay.measurement.MeasurementException;
import rw.oupay.measurement.MeasurementUnit;
import rw.oupay.measurement.PackageConversion;
import rw.oupay.measurement.QuantityPrecision;
import rw.oupay.membership.Actor;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.reservation.StockReservationService;
import rw.oupay.membership.Permission;
import rw.oupay.merchant.MerchantSettingsService;
import rw.oupay.merchant.OperatingMode;
import rw.oupay.user.User;
import rw.oupay.user.UserRepository;

/**
 * Branch-level physical stock of GOODS: balances and an append-only movement history. A service never has stock.
 *
 * <h2>Transaction ownership</h2>
 * Every write is ONE transaction owned by the service method: the movement (which the database applies to the balance in the same
 * statement), and the audit entry commit or roll back together. Nothing outside the database happens inside it (no e-mail, no HTTP call), so the whole transaction
 * can be retried safely. A failed operation (insufficient stock, an invalid conversion, a refused constraint) leaves no
 * balance row, no movement and no audit entry behind.
 *
 * <h2>Lock order</h2>
 * Always the same, so two operations can never wait for each other in a cycle:
 * <ol>
 *   <li>the transaction-scoped advisory lock of (business, operation id): repeats of one operation take turns;</li>
 *   <li>the row lock of the balance (business, branch, item) ({@code SELECT ... FOR UPDATE}): every change of one balance
 *       takes turns. One operation touches exactly one balance, so there is never a second row lock to order against.</li>
 * </ol>
 * The authorisation, conversion and fingerprint work happens BEFORE either lock, so nothing slow is done while holding them.
 *
 * <h2>Durable idempotency</h2>
 * Each write carries a client-generated {@code clientOperationId}. At most one movement can ever exist per (business, id): a
 * unique index. The server fingerprints the operation (R2's canonical fingerprint of the business, the actor, the movement type,
 * the branch, the item, the exact CANONICAL quantity, the reason and the reference). A repeat with an identical fingerprint
 * returns the recorded movement (it never adds stock again); any other request under the same id is a 409
 * {@code operation_id_reuse}. This does not depend on any R2 HTTP idempotency record, so it holds long after those are pruned.
 *
 * <h2>Authorisation</h2>
 * {@link MerchantAccess} first (404 for a stranger, 403 without the permission), then BUSINESS mode (409
 * {@code inventory_unavailable}). Receiving needs {@code inventory:receive}; opening stock and adjusting need
 * {@code inventory:adjust}; both are denied to cashiers. A caller without full scope (a manager) may write only at branches they
 * are actively assigned to; a cashier's view is likewise limited to their branches.
 */
@Service
public class InventoryService {

    private static final Pattern POSITIVE_DECIMAL = Pattern.compile("[0-9]+(\\.[0-9]+)?");
    private static final int MAX_AUDIT_MESSAGE = 480;
    private static final String UNIQUE_VIOLATION = "23505";

    /** The result of a write, and whether this call recorded it (false: the same operation had already been recorded). */
    public record Outcome(InventoryDtos.MovementResult result, boolean created) {}

    /** The common part of the three write requests. */
    private record Entry(UUID operationId, UUID branchId, UUID itemId, String amount, String unit, UUID packageId, String packageCount,
                         String reference, String reason) {}

    /** A quantity the server has converted: canonical, positive, exact. */
    private record Resolved(BigDecimal canonical, String enteredAs) {}

    private final StockReservationService reservations;
    private final InventoryBalanceRepository balances;
    private final StockMovementRepository movements;
    private final CatalogItemRepository items;
    private final CatalogPackageRepository packages;
    private final BranchRepository branches;
    private final BranchAssignmentRepository assignments;
    private final UserRepository users;
    private final MerchantAccess access;
    private final MerchantSettingsService settings;
    private final AuditService audit;
    private final IdempotencyService fingerprints;
    private final JdbcClient jdbc;
    private final EntityManager entityManager;
    private final Clock clock;

    public InventoryService(InventoryBalanceRepository balances, StockMovementRepository movements, CatalogItemRepository items,
                            CatalogPackageRepository packages, BranchRepository branches, BranchAssignmentRepository assignments,
                            UserRepository users, MerchantAccess access, MerchantSettingsService settings, AuditService audit,
                            IdempotencyService fingerprints, JdbcClient jdbc, EntityManager entityManager, Clock clock,
                            StockReservationService reservations) {
        this.reservations = reservations;
        this.balances = balances;
        this.movements = movements;
        this.items = items;
        this.packages = packages;
        this.branches = branches;
        this.assignments = assignments;
        this.users = users;
        this.access = access;
        this.settings = settings;
        this.audit = audit;
        this.fingerprints = fingerprints;
        this.jdbc = jdbc;
        this.entityManager = entityManager;
        this.clock = clock;
    }

    // ---------------------------------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------------------------------

    /** The branches the caller may see, and where they may record stock. */
    @Transactional(readOnly = true)
    public InventoryDtos.Options options(UUID merchantId) {
        Actor actor = require(merchantId, Permission.INVENTORY_VIEW);
        Set<UUID> assigned = assignedBranchIds(actor);
        boolean fullView = actor.hasFullScope(Permission.INVENTORY_VIEW);
        List<InventoryDtos.BranchOption> options = new ArrayList<>();
        for (Branch branch : branches.findByMerchantIdOrderByNameAsc(merchantId)) {
            if (!fullView && !assigned.contains(branch.getId())) {
                continue;
            }
            boolean writable = branch.isActive()
                    && (canWriteAt(actor, Permission.INVENTORY_RECEIVE, branch.getId(), assigned)
                    || canWriteAt(actor, Permission.INVENTORY_ADJUST, branch.getId(), assigned));
            options.add(new InventoryDtos.BranchOption(branch.getId(), branch.getName(), branch.getCode(), branch.getStatus(), writable));
        }
        return new InventoryDtos.Options(options);
    }

    @Transactional(readOnly = true)
    public Pagination.Page<InventoryDtos.BalanceDto> balances(UUID merchantId, Integer limit, String cursor, UUID branchId,
                                                              UUID itemId, String query) {
        Actor actor = require(merchantId, Permission.INVENTORY_VIEW);
        Visible visible = visibleBranches(actor);
        if (visible.restrict() && visible.allowed().isEmpty()) {
            return new Pagination.Page<>(List.of(), null, null);
        }
        int size = Pagination.limit(limit);
        Pagination.Position position = Pagination.decode(cursor);
        String text = query == null ? "" : query.trim();
        if (text.length() > 100) {
            throw ApiException.validation("The search text is too long.");
        }
        List<InventoryBalance> fetched = balances.page(merchantId, position.at(), position.id(), branchId == null,
                branchId == null ? ZERO_ID : branchId, itemId == null, itemId == null ? ZERO_ID : itemId, visible.restrict(),
                visible.allowed().isEmpty() ? List.of(ZERO_ID) : visible.allowed(), text.isEmpty(),
                "%" + escapeLike(text.toLowerCase(Locale.ROOT)) + "%", Pagination.fetch(size));
        Pagination.Page<InventoryBalance> page = Pagination.page(fetched, size, InventoryBalance::getCreatedAt, InventoryBalance::getId, null);
        Lookup lookup = lookup(page.items().stream().map(InventoryBalance::getItemId).collect(Collectors.toSet()),
                page.items().stream().map(InventoryBalance::getBranchId).collect(Collectors.toSet()), Set.of());
        Map<String, BigDecimal> reserved = reservations.reservedFor(merchantId, page.items().stream().map(InventoryBalance::getBranchId).collect(Collectors.toSet()),
                page.items().stream().map(InventoryBalance::getItemId).collect(Collectors.toSet()));
        return page.map(b -> toDto(b, lookup.item(b.getItemId()), lookup.branch(b.getBranchId()), reserved.getOrDefault(b.getBranchId() + ":" + b.getItemId(), BigDecimal.ZERO)));
    }

    @Transactional(readOnly = true)
    public Pagination.Page<InventoryDtos.MovementDto> movements(UUID merchantId, Integer limit, String cursor, UUID branchId,
                                                                UUID itemId, MovementType type) {
        Actor actor = require(merchantId, Permission.INVENTORY_VIEW);
        Visible visible = visibleBranches(actor);
        if (visible.restrict() && visible.allowed().isEmpty()) {
            return new Pagination.Page<>(List.of(), null, null);
        }
        int size = Pagination.limit(limit);
        Pagination.Position position = Pagination.decode(cursor);
        List<StockMovement> fetched = movements.page(merchantId, position.at(), position.id(), branchId == null,
                branchId == null ? ZERO_ID : branchId, itemId == null, itemId == null ? ZERO_ID : itemId, type == null,
                type == null ? MovementType.OPENING : type, visible.restrict(),
                visible.allowed().isEmpty() ? List.of(ZERO_ID) : visible.allowed(), Pagination.fetch(size));
        Pagination.Page<StockMovement> page = Pagination.page(fetched, size, StockMovement::getCreatedAt, StockMovement::getId, null);
        Lookup lookup = lookup(page.items().stream().map(StockMovement::getItemId).collect(Collectors.toSet()),
                page.items().stream().map(StockMovement::getBranchId).collect(Collectors.toSet()),
                page.items().stream().map(StockMovement::getActorUserId).collect(Collectors.toSet()));
        return page.map(m -> toDto(m, lookup.item(m.getItemId()), lookup.branch(m.getBranchId()), lookup.actorName(m.getActorUserId())));
    }

    // ---------------------------------------------------------------------------------------------
    // Writes
    // ---------------------------------------------------------------------------------------------

    @Transactional
    public Outcome recordOpening(UUID merchantId, InventoryDtos.OpeningRequest r) {
        return record(merchantId, MovementType.OPENING, Permission.INVENTORY_ADJUST,
                new Entry(r.clientOperationId(), r.branchId(), r.itemId(), r.amount(), r.unit(), r.packageId(), r.packageCount(),
                        r.reference(), r.reason()));
    }

    @Transactional
    public Outcome receive(UUID merchantId, InventoryDtos.ReceiveRequest r) {
        return record(merchantId, MovementType.RECEIVE, Permission.INVENTORY_RECEIVE,
                new Entry(r.clientOperationId(), r.branchId(), r.itemId(), r.amount(), r.unit(), r.packageId(), r.packageCount(),
                        r.reference(), r.reason()));
    }

    @Transactional
    public Outcome adjust(UUID merchantId, InventoryDtos.AdjustRequest r) {
        MovementType type = "IN".equals(r.direction()) ? MovementType.ADJUST_IN : MovementType.ADJUST_OUT;
        return record(merchantId, type, Permission.INVENTORY_ADJUST,
                new Entry(r.clientOperationId(), r.branchId(), r.itemId(), r.amount(), r.unit(), r.packageId(), r.packageCount(),
                        r.reference(), r.reason()));
    }

    private Outcome record(UUID merchantId, MovementType type, Permission permission, Entry entry) {
        // 1. Everything that needs no lock: who may do this, where, to what, and the exact quantity.
        Actor actor = require(merchantId, permission);
        Branch branch = branches.findByIdAndMerchantId(entry.branchId(), merchantId)
                .orElseThrow(() -> ApiException.notFound("This branch could not be found."));
        requireEligible(actor, permission, branch);
        CatalogItem item = items.findByIdAndMerchantId(entry.itemId(), merchantId)
                .orElseThrow(() -> ApiException.notFound("This item could not be found."));
        if (item.getItemType() != CatalogItemType.GOODS) {
            throw new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "invalid_item", "Services do not have stock.");
        }
        String reason = blankToNull(entry.reason());
        if (type.requiresReason() && reason == null) {
            throw ApiException.validation("A reason is required for an adjustment.");
        }
        String reference = blankToNull(entry.reference());
        Resolved quantity = resolve(item, merchantId, entry, type);
        BigDecimal delta = (type.adds() ? quantity.canonical() : quantity.canonical().negate()).setScale(QuantityPrecision.SCALE, RoundingMode.UNNECESSARY);
        String fingerprint = fingerprintOf(merchantId, actor, type, branch.getId(), item.getId(), delta, reason, reference);

        // 2. Lock 1: repeats of the same operation take turns. A repeat finds the committed movement and returns it.
        serialiseOperation(merchantId, entry.operationId());
        var existing = movements.findByMerchantIdAndOperationId(merchantId, entry.operationId());
        if (existing.isPresent()) {
            return replayOf(existing.get(), fingerprint, item, branch);
        }
        if (!branch.isActive()) {
            throw ApiException.invalidState("branch_inactive", "Stock can only be recorded at an active branch.");
        }

        // 3. Lock 2: the balance row. Created empty if this is the first stock of the item at the branch (a rolled-back failure
        //    takes that empty row with it).
        ensureBalance(merchantId, branch.getId(), item, clock.instant().truncatedTo(ChronoUnit.MICROS));
        InventoryBalance balance = balances.lockByKey(merchantId, branch.getId(), item.getId()).orElseThrow();
        // The time of the movement is taken AFTER the lock is held, so the order of movements follows the order the balance really changed in.
        Instant now = clock.instant().truncatedTo(ChronoUnit.MICROS);
        if (type == MovementType.OPENING && movements.existsByMerchantIdAndBranchIdAndItemId(merchantId, branch.getId(), item.getId())) {
            throw ApiException.conflict("opening_already_recorded",
                    "Stock has already been recorded for this item at this branch. Receive or adjust stock instead.");
        }
        BigDecimal after = balance.getQuantityOnHand().add(delta);
        if (after.signum() < 0) {
            throw ApiException.conflict("insufficient_stock", "There is not enough stock at this branch to remove that quantity.");
        }
        // R7b: stock reserved for sales already billed can not be removed. The balance row lock is held, so no reservation can be added
        // meanwhile (the reservation takes the same lock); the database refuses it too (V17) if anything ever bypassed this check.
        BigDecimal reserved = reservations.activeReserved(merchantId, branch.getId(), item.getId());
        if (delta.signum() < 0 && after.compareTo(reserved) < 0) {
            throw ApiException.conflict("stock_reserved", "Part of this stock is reserved for sales that were already billed. At most "
                    + balance.getQuantityOnHand().subtract(reserved).stripTrailingZeros().toPlainString() + " " + item.getMeasurementDimension().canonicalUnit().code()
                    + " can be removed until they are fulfilled or released.");
        }
        QuantityPrecision.requireStorable(after);
        after = after.setScale(QuantityPrecision.SCALE, RoundingMode.UNNECESSARY);

        // 4. Inserting the movement IS the balance change: the database trigger (V10) re-checks that it continues exactly from the
        //    locked balance and moves the balance in the same statement. Nothing here updates the balance, so a movement and its
        //    balance change cannot be separated.
        StockMovement movement;
        try {
            movement = movements.saveAndFlush(new StockMovement(merchantId, branch.getId(), item.getId(), type, delta, after,
                    quantity.enteredAs(), reason, reference, entry.operationId(), fingerprint, actor.userId(), now));
        } catch (DataIntegrityViolationException e) {
            if (DatabaseErrors.sqlState(e).filter(UNIQUE_VIOLATION::equals).isPresent()) {
                throw operationReused();
            }
            throw e;
        }
        entityManager.refresh(balance);
        entityManager.refresh(movement);  // the database keeps created_at strictly increasing per balance; report what is stored
        audit.record(merchantId, actor.userId(), auditKind(type), "inventory_movement", movement.getId(),
                abbreviate(auditMessage(type, item, branch, delta, after, reason)));
        return new Outcome(new InventoryDtos.MovementResult(toDto(movement, item, branch, actor.user().getFullName()),
                toDto(balance, item, branch, reservations.activeReserved(merchantId, branch.getId(), item.getId())), false), true);
    }

    private Outcome replayOf(StockMovement existing, String fingerprint, CatalogItem item, Branch branch) {
        if (!fingerprint.equals(existing.getRequestSha256())) {
            throw operationReused();
        }
        InventoryBalance balance = balances.findByMerchantIdAndBranchIdAndItemId(existing.getMerchantId(), existing.getBranchId(),
                existing.getItemId()).orElseThrow();
        String actorName = users.findById(existing.getActorUserId()).map(User::getFullName).orElse("Unknown");
        return new Outcome(new InventoryDtos.MovementResult(toDto(existing, item, branch, actorName),
                toDto(balance, item, branch, reservations.activeReserved(existing.getMerchantId(), branch.getId(), item.getId())), true), false);
    }

    // ---------------------------------------------------------------------------------------------
    // Rules
    // ---------------------------------------------------------------------------------------------

    /** Converts what the user entered to the exact canonical quantity. Nothing is rounded; an invalid entry throws before any lock. */
    private Resolved resolve(CatalogItem item, UUID merchantId, Entry entry, MovementType type) {
        boolean byAmount = !isBlank(entry.amount()) || !isBlank(entry.unit());
        boolean byPackage = entry.packageId() != null || !isBlank(entry.packageCount());
        if (byAmount == byPackage) {
            throw ApiException.validation("Enter either a quantity and a unit, or a package and a count.");
        }
        BigDecimal canonical;
        String enteredAs;
        if (byAmount) {
            if (isBlank(entry.amount()) || isBlank(entry.unit())) {
                throw ApiException.validation("Enter both a quantity and a unit.");
            }
            MeasurementUnit unit = MeasurementUnit.fromCode(entry.unit());
            if (unit.dimension() != item.getMeasurementDimension()) {
                throw new MeasurementException(MeasurementException.Reason.DIMENSION_MISMATCH, "That unit does not measure this item.");
            }
            canonical = MeasuredQuantity.parse(entry.amount(), unit).canonicalAmount();
            enteredAs = entry.amount().trim() + " " + unit.code();
        } else {
            if (entry.packageId() == null || isBlank(entry.packageCount())) {
                throw ApiException.validation("Enter both a package and a count.");
            }
            CatalogPackage pack = packages.findByIdAndItemIdAndMerchantId(entry.packageId(), item.getId(), merchantId)
                    .orElseThrow(() -> ApiException.notFound("This package could not be found."));
            if (!pack.isActive()) {
                throw new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "package_inactive", "That package is no longer in use.");
            }
            String count = entry.packageCount().trim();
            if (!POSITIVE_DECIMAL.matcher(count).matches()) {
                throw new MeasurementException(MeasurementException.Reason.INVALID_QUANTITY, "That is not a valid quantity.");
            }
            canonical = new PackageConversion(item.getMeasurementDimension(), pack.getQuantityPerPackage())
                    .toQuantity(new BigDecimal(count)).amount();
            enteredAs = count + " x " + pack.getLabel();
        }
        if (canonical.signum() <= 0) {
            throw new MeasurementException(MeasurementException.Reason.OUT_OF_RANGE, type == MovementType.OPENING
                    ? "Opening stock must be greater than zero. A branch with no stock needs no opening entry."
                    : "The quantity must be greater than zero.");
        }
        return new Resolved(canonical, enteredAs);
    }

    private String fingerprintOf(UUID merchantId, Actor actor, MovementType type, UUID branchId, UUID itemId, BigDecimal delta,
                                 String reason, String reference) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("actor", actor.userId());
        body.put("branchId", branchId);
        body.put("itemId", itemId);
        body.put("movementType", type.name());
        body.put("quantityDelta", delta.toPlainString());
        body.put("reason", reason == null ? "" : reason);
        body.put("reference", reference == null ? "" : reference);
        return fingerprints.fingerprintOf("STOCK_MOVEMENT", Map.of("merchantId", merchantId), body);
    }

    /** Lock 1. Released when the transaction ends. Different ids never wait for each other (a hash collision only waits briefly). */
    private void serialiseOperation(UUID merchantId, UUID operationId) {
        jdbc.sql("select pg_advisory_xact_lock(hashtextextended(:key, 0))")
                .param("key", "stock-operation:" + merchantId + ":" + operationId)
                .query((rs, row) -> Boolean.TRUE).single();
    }

    /**
     * Creates the empty balance if nobody has yet. The insert ignores a conflict, so two simultaneous first operations never fail
     * on a duplicate key: the loser reads the winner's row and then waits for its lock.
     */
    private void ensureBalance(UUID merchantId, UUID branchId, CatalogItem item, Instant now) {
        jdbc.sql("insert into inventory_balances (id, merchant_id, branch_id, item_id, item_type, measurement_dimension, "
                        + "quantity_on_hand, created_at, updated_at, version) values (:id, :m, :b, :i, 'GOODS', :dimension, 0, :now, :now, 0) "
                        + "on conflict (merchant_id, branch_id, item_id) do nothing")
                .param("id", UUID.randomUUID()).param("m", merchantId).param("b", branchId).param("i", item.getId())
                .param("dimension", item.getMeasurementDimension().name()).param("now", Timestamp.from(now))
                .update();
    }

    /** Authorises, then confirms the business works in BUSINESS mode (SIMPLIFIED businesses keep amount-only checkout). */
    private Actor require(UUID merchantId, Permission permission) {
        Actor actor = access.require(merchantId, permission);
        if (settings.operatingModeOf(merchantId) != OperatingMode.BUSINESS) {
            throw ApiException.invalidState("inventory_unavailable", "Inventory is available to businesses in business mode.");
        }
        return actor;
    }

    private void requireEligible(Actor actor, Permission permission, Branch branch) {
        if (!canWriteAt(actor, permission, branch.getId(), assignedBranchIds(actor))) {
            throw ApiException.forbidden("You are not assigned to that branch.");
        }
    }

    private boolean canWriteAt(Actor actor, Permission permission, UUID branchId, Set<UUID> assigned) {
        return actor.can(permission) && (actor.hasFullScope(permission) || assigned.contains(branchId));
    }

    /** The branches the caller is actively assigned to AND that are active themselves. Nothing is visible or writable elsewhere. */
    private Set<UUID> assignedBranchIds(Actor actor) {
        Set<UUID> assigned = assignments.findByMembershipIdAndStatus(actor.membership().getId(), "ACTIVE").stream()
                .map(BranchAssignment::getBranchId).collect(Collectors.toSet());
        if (assigned.isEmpty()) {
            return assigned;
        }
        return branches.findAllById(assigned).stream().filter(Branch::isActive).map(Branch::getId).collect(Collectors.toSet());
    }

    private record Visible(boolean restrict, Collection<UUID> allowed) {}

    private Visible visibleBranches(Actor actor) {
        return actor.hasFullScope(Permission.INVENTORY_VIEW) ? new Visible(false, List.of()) : new Visible(true, assignedBranchIds(actor));
    }

    private static final UUID ZERO_ID = new UUID(0L, 0L);

    // ---------------------------------------------------------------------------------------------
    // Presentation
    // ---------------------------------------------------------------------------------------------

    private record Lookup(Map<UUID, CatalogItem> items, Map<UUID, Branch> branches, Map<UUID, String> actors) {
        CatalogItem item(UUID id) {
            return items.get(id);
        }

        Branch branch(UUID id) {
            return branches.get(id);
        }

        String actorName(UUID id) {
            if (id == null) {
                return "OuPay (verified payment)";
            }
            return actors.getOrDefault(id, "Unknown");
        }
    }

    private Lookup lookup(Set<UUID> itemIds, Set<UUID> branchIds, Set<UUID> userIds) {
        Map<UUID, CatalogItem> itemMap = itemIds.isEmpty() ? Map.of()
                : items.findAllById(itemIds).stream().collect(Collectors.toMap(CatalogItem::getId, Function.identity()));
        Map<UUID, Branch> branchMap = branchIds.isEmpty() ? Map.of()
                : branches.findAllById(branchIds).stream().collect(Collectors.toMap(Branch::getId, Function.identity()));
        Map<UUID, String> actorMap = new HashMap<>();
        // A SALE movement is posted by the system and has no actor (null): it is shown as OuPay itself.
        Set<UUID> people = userIds.stream().filter(java.util.Objects::nonNull).collect(Collectors.toSet());
        if (!people.isEmpty()) {
            users.findAllById(people).forEach(u -> actorMap.put(u.getId(), u.getFullName()));
        }
        return new Lookup(itemMap, branchMap, actorMap);
    }

    private static InventoryDtos.BalanceDto toDto(InventoryBalance balance, CatalogItem item, Branch branch, BigDecimal reserved) {
        MeasurementUnit stockUnit = item.getMeasurementDimension().canonicalUnit();
        MeasuredQuantity onHand = new MeasuredQuantity(balance.getQuantityOnHand(), stockUnit);
        return new InventoryDtos.BalanceDto(balance.getId(), branch.getId(), branch.getName(), branch.getCode(), item.getId(),
                item.getName(), item.getCode(), item.getMeasurementDimension().name(), stockUnit.code(), plain(onHand.amount()),
                item.getSaleUnit().code(), plain(onHand.to(item.getSaleUnit()).amount()), balance.getUpdatedAt(), balance.getVersion(),
                plain(reserved), plain(balance.getQuantityOnHand().subtract(reserved)));
    }

    private static InventoryDtos.MovementDto toDto(StockMovement m, CatalogItem item, Branch branch, String actorName) {
        return new InventoryDtos.MovementDto(m.getId(), branch.getId(), branch.getName(), item.getId(), item.getName(), m.getMovementType(),
                plain(m.getQuantityDelta()), plain(m.getBalanceAfter()), item.getMeasurementDimension().canonicalUnit().code(),
                m.getEnteredAs(), m.getReason(), m.getReference(), m.getOperationId(), actorName, m.getCreatedAt());
    }

    /** An exact plain decimal ("25000", "0.75", "-250"); never an exponent, never a trailing zero. */
    private static String plain(BigDecimal value) {
        return value.stripTrailingZeros().toPlainString();
    }

    private static String auditKind(MovementType type) {
        return switch (type) {
            case OPENING -> "INVENTORY_STOCK_OPENED";
            case RECEIVE -> "INVENTORY_STOCK_RECEIVED";
            case ADJUST_IN, ADJUST_OUT -> "INVENTORY_STOCK_ADJUSTED";
            case SALE -> "INVENTORY_STOCK_SOLD";
        };
    }

    private static String auditMessage(MovementType type, CatalogItem item, Branch branch, BigDecimal delta, BigDecimal after, String reason) {
        String unit = item.getMeasurementDimension().canonicalUnit().code();
        String verb = switch (type) {
            case OPENING -> "Opening stock";
            case RECEIVE -> "Received";
            case ADJUST_IN -> "Adjusted in";
            case ADJUST_OUT -> "Adjusted out";
            case SALE -> "Deducted for a paid sale";
        };
        return verb + " " + plain(delta.abs()) + " " + unit + " of \"" + item.getName() + "\" at " + branch.getCode() + "; balance "
                + plain(after) + " " + unit + (reason == null ? "." : ". Reason: " + reason);
    }

    private static String abbreviate(String message) {
        return message.length() <= MAX_AUDIT_MESSAGE ? message : message.substring(0, MAX_AUDIT_MESSAGE - 3) + "...";
    }

    private static ApiException operationReused() {
        return ApiException.conflict("operation_id_reuse", "This operation identifier was already used for a different stock operation.");
    }

    private static String escapeLike(String text) {
        return text.replace("!", "!!").replace("%", "!%").replace("_", "!_");
    }

    private static String blankToNull(String text) {
        return isBlank(text) ? null : text.trim();
    }

    private static boolean isBlank(String text) {
        return text == null || text.isBlank();
    }
}
