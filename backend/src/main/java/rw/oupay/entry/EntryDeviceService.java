package rw.oupay.entry;

import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.checkout.PublicCodeSaleService;
import rw.oupay.common.ApiException;
import rw.oupay.membership.Actor;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.membership.Permission;
import rw.oupay.membership.Role;

/**
 * The merchant-facing side of the payment-entry devices: register a static QR, NFC tag or NFC bracelet, assign it to a branch and cashier,
 * suspend or revoke it, and lead it to ONE prepared bill at a time.
 *
 * <h2>What a device is, and is not</h2>
 * A device is a stable doorway (one permanent URL). It holds no bank detail, no amount and no person. It never creates an invoice, a payment
 * request or a ledger row, and it never says anything is paid: the sale it leads to is an ordinary code sale (R6c / R7b) and reconciliation
 * (R6d-B) stays the only authority on money.
 *
 * <h2>Binding rules</h2>
 * A binding is always an explicit act by an authorised person. The device never falls back to "the newest bill": with no open binding it is
 * idle. At most one open binding per device and per sale (partial unique indexes), the sale must belong to the device's own branch and, when
 * the device has a cashier, be that cashier's. A binding is replaced only after the previous one is closed: by the person, or by the system when
 * its sale is paid, expired or cancelled. A customer session in progress is never cut off silently.
 *
 * <h2>Locking</h2>
 * Every write locks the device row ({@code FOR UPDATE}) first, so binds, unbinds, reassignments, suspensions and customer claims of one device
 * take turns; the unique indexes back that up across instances.
 */
@Service
public class EntryDeviceService {

    private static final Set<String> TYPES = Set.of("STATIC_QR", "NFC_TAG", "NFC_BRACELET");
    private static final Set<String> BINDABLE = Set.of("AWAITING_PAYMENT", "PARTIALLY_PAID");
    private static final Set<String> TERMINAL = Set.of("PAID", "EXPIRED", "CANCELLED");

    private final JdbcClient jdbc;
    private final MerchantAccess access;
    private final AuditService audit;
    private final PublicCodeSaleService sales;
    private final Clock clock;

    public EntryDeviceService(JdbcClient jdbc, MerchantAccess access, AuditService audit, PublicCodeSaleService sales, Clock clock) {
        this.jdbc = jdbc;
        this.access = access;
        this.audit = audit;
        this.sales = sales;
        this.clock = clock;
    }

    private record Device(UUID id, UUID merchantId, String type, String token, String name, UUID branchId, UUID cashierId, String status,
                          long version, String clientRequestId) {}

    private record OpenBinding(UUID id, UUID saleId, UUID agentId, String reference) {}

    // ---------------------------------------------------------------------------------------------
    // Reads
    // ---------------------------------------------------------------------------------------------

    /** What the forms need: the active branches the person may use and the members who could hold a device. */
    @Transactional(readOnly = true)
    public EntryDtos.Options options(UUID merchantId) {
        Actor actor = access.require(merchantId, Permission.ENTRY_DEVICES_VIEW);
        List<EntryDtos.BranchOption> branches = jdbc.sql("select id, name, code from branches where merchant_id = :m and status = 'ACTIVE' order by name")
                .param("m", merchantId).query((rs, i) -> new EntryDtos.BranchOption(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3))).list();
        if (actor.role() == Role.MANAGER || actor.role() == Role.CASHIER) {
            Set<UUID> mine = myBranches(actor);
            branches = branches.stream().filter(b -> mine.contains(b.id())).toList();
        }
        Map<UUID, List<UUID>> branchesOf = jdbc.sql("select m.user_id, a.branch_id from memberships m join branch_assignments a on a.membership_id = m.id and a.merchant_id = m.merchant_id "
                        + "where m.merchant_id = :m and m.status = 'ACTIVE' and a.status = 'ACTIVE'").param("m", merchantId)
                .query((rs, i) -> Map.entry(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class))).list().stream()
                .collect(Collectors.groupingBy(Map.Entry::getKey, Collectors.mapping(Map.Entry::getValue, Collectors.toList())));
        List<EntryDtos.CashierOption> cashiers = jdbc.sql("select u.id, u.full_name, m.role from memberships m join users u on u.id = m.user_id "
                        + "where m.merchant_id = :m and m.status = 'ACTIVE' and u.status = 'ACTIVE' order by u.full_name").param("m", merchantId)
                .query((rs, i) -> new EntryDtos.CashierOption(rs.getObject(1, UUID.class), rs.getString(2), rs.getString(3), List.of())).list().stream()
                .filter(c -> branchesOf.containsKey(c.userId()))
                .map(c -> new EntryDtos.CashierOption(c.userId(), c.fullName(), c.role(), branchesOf.get(c.userId()))).toList();
        if (actor.role() == Role.CASHIER) {
            cashiers = cashiers.stream().filter(c -> c.userId().equals(actor.userId())).toList();
        }
        return new EntryDtos.Options(branches, cashiers);
    }

    @Transactional(readOnly = true)
    public List<EntryDtos.DeviceDto> list(UUID merchantId, String status, UUID branchId) {
        Actor actor = access.require(merchantId, Permission.ENTRY_DEVICES_VIEW);
        if (status != null && !Set.of("ACTIVE", "SUSPENDED", "REVOKED").contains(status)) {
            throw ApiException.validation("Unknown device status.");
        }
        List<UUID> ids = jdbc.sql("select d.id from payment_entry_devices d where d.merchant_id = :m and (cast(:s as varchar) is null or d.status = :s) "
                        + "and (cast(:b as uuid) is null or d.branch_id = :b) order by d.created_at desc, d.id desc limit 200")
                .param("m", merchantId).param("s", status).param("b", branchId).query(UUID.class).list();
        return ids.stream().map(id -> read(merchantId, id)).flatMap(Optional::stream).filter(d -> visible(actor, d)).map(d -> dto(actor, d)).toList();
    }

    @Transactional(readOnly = true)
    public EntryDtos.DeviceDto get(UUID merchantId, UUID deviceId) {
        Actor actor = access.require(merchantId, Permission.ENTRY_DEVICES_VIEW);
        Device device = read(merchantId, deviceId).filter(d -> visible(actor, d)).orElseThrow(EntryDeviceService::notFound);
        return dto(actor, device);
    }

    @Transactional(readOnly = true)
    public List<EntryDtos.AssignmentDto> assignments(UUID merchantId, UUID deviceId) {
        Actor actor = access.require(merchantId, Permission.ENTRY_DEVICES_VIEW);
        read(merchantId, deviceId).filter(d -> visible(actor, d)).orElseThrow(EntryDeviceService::notFound);
        return jdbc.sql("select a.id, a.branch_id, a.branch_name, a.assigned_cashier_user_id, a.assigned_cashier_name, a.valid_from, a.valid_to, u.full_name, a.change_reason "
                        + "from payment_entry_device_assignments a join users u on u.id = a.assigned_by_user_id where a.device_id = :d and a.merchant_id = :m "
                        + "order by a.valid_from desc, a.id desc limit 200")
                .param("d", deviceId).param("m", merchantId)
                .query((rs, i) -> new EntryDtos.AssignmentDto(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3), rs.getObject(4, UUID.class),
                        rs.getString(5), rs.getTimestamp(6).toInstant(), instant(rs.getTimestamp(7)), rs.getString(8), rs.getString(9))).list();
    }

    @Transactional(readOnly = true)
    public List<EntryDtos.BindingHistoryDto> bindings(UUID merchantId, UUID deviceId) {
        Actor actor = access.require(merchantId, Permission.ENTRY_DEVICES_VIEW);
        read(merchantId, deviceId).filter(d -> visible(actor, d)).orElseThrow(EntryDeviceService::notFound);
        return jdbc.sql("select b.id, s.sale_reference, s.amount_rwf, s.agent_name, u.full_name, b.bound_at, b.ended_at, b.end_reason "
                        + "from payment_entry_bindings b join code_sales s on s.payment_request_id = b.sale_id and s.merchant_id = b.merchant_id "
                        + "join users u on u.id = b.bound_by_user_id where b.device_id = :d and b.merchant_id = :m order by b.bound_at desc, b.id desc limit 200")
                .param("d", deviceId).param("m", merchantId)
                .query((rs, i) -> new EntryDtos.BindingHistoryDto(rs.getObject(1, UUID.class), rs.getString(2), rs.getLong(3), rs.getString(4), rs.getString(5),
                        rs.getTimestamp(6).toInstant(), instant(rs.getTimestamp(7)), rs.getString(8))).list();
    }

    /** The prepared sales this device could lead to right now: open, unexpired, of its branch and (when it has one) its cashier, not bound elsewhere. */
    @Transactional(readOnly = true)
    public List<EntryDtos.EligibleSaleDto> eligibleSales(UUID merchantId, UUID deviceId) {
        Actor actor = access.require(merchantId, Permission.ENTRY_DEVICES_BIND);
        Device device = read(merchantId, deviceId).filter(d -> visible(actor, d)).orElseThrow(EntryDeviceService::notFound);
        requireBindScope(actor, device);
        UUID agent = device.cashierId() != null ? device.cashierId() : actor.role() == Role.CASHIER ? actor.userId() : null;
        record Candidate(UUID id, String reference, long amount, String description, String mode, String agentName, Instant expiresAt, Instant createdAt) {}
        List<Candidate> candidates = jdbc.sql("select s.payment_request_id, s.sale_reference, s.amount_rwf, s.description, s.presentation_mode, s.agent_name, r.expires_at, s.created_at "
                        + "from code_sales s join payment_requests r on r.id = s.payment_request_id and r.merchant_id = s.merchant_id "
                        + "where s.merchant_id = :m and s.branch_id = :b and r.cancelled_at is null and r.expires_at > :now "
                        + "and (cast(:agent as uuid) is null or s.agent_user_id = :agent) "
                        + "and not exists (select 1 from payment_entry_bindings x where x.sale_id = s.payment_request_id and x.ended_at is null) "
                        + "order by s.created_at desc, s.payment_request_id desc limit 40")
                .param("m", merchantId).param("b", device.branchId()).param("agent", agent).param("now", Timestamp.from(clock.instant()))
                .query((rs, i) -> new Candidate(rs.getObject(1, UUID.class), rs.getString(2), rs.getLong(3), rs.getString(4), rs.getString(5), rs.getString(6),
                        rs.getTimestamp(7).toInstant(), rs.getTimestamp(8).toInstant())).list();
        return candidates.stream()
                .map(c -> new EntryDtos.EligibleSaleDto(c.id(), c.reference(), c.amount(), c.description(), c.mode(), c.agentName(), c.expiresAt(), c.createdAt(), saleStatus(c.reference())))
                .filter(s -> BINDABLE.contains(s.status())).limit(25).toList();
    }

    // ---------------------------------------------------------------------------------------------
    // Registration and lifecycle
    // ---------------------------------------------------------------------------------------------

    public record Written(EntryDtos.DeviceDto device, boolean created) {}

    @Transactional
    public Written register(UUID merchantId, EntryDtos.CreateRequest request) {
        Actor actor = access.require(merchantId, Permission.ENTRY_DEVICES_MANAGE);
        String type = request.deviceType().trim();
        if (!TYPES.contains(type)) {
            throw ApiException.validation("Choose a static QR code, an NFC tag or an NFC bracelet.");
        }
        String name = request.displayName().trim();
        if (name.isEmpty() || name.length() > 60) {
            throw ApiException.validation("Give the device a name of 1 to 60 characters.");
        }
        // A retry of the same request returns the device already registered; the same id with other content is refused.
        Optional<Device> existing = jdbc.sql(DEVICE_SELECT + " where d.merchant_id = :m and d.client_request_id = :c").param("m", merchantId)
                .param("c", request.clientRequestId()).query(DEVICE_MAPPER).optional();
        if (existing.isPresent()) {
            Device d = existing.get();
            if (!d.type().equals(type) || !d.name().equals(name) || !d.branchId().equals(request.branchId())
                    || !java.util.Objects.equals(d.cashierId(), request.assignedCashierUserId())) {
                throw ApiException.conflict("client_request_id_reuse", "This request identifier was already used for a different device.");
            }
            return new Written(dto(actor, d), false);
        }
        String branchName = requireUsableBranch(merchantId, request.branchId());
        requireManageScope(actor, request.branchId());
        String cashierName = requireEligibleCashier(merchantId, request.assignedCashierUserId(), request.branchId());
        if ("NFC_BRACELET".equals(type) && request.assignedCashierUserId() == null) {
            throw ApiException.validation("A bracelet is personal: choose the cashier who wears it.");
        }
        if (jdbc.sql("select count(*) from payment_entry_devices where merchant_id = :m and status <> 'REVOKED' and lower(display_name) = lower(:n)")
                .param("m", merchantId).param("n", name).query(Integer.class).single() > 0) {
            throw ApiException.conflict("device_name_taken", "Another device already has this name. Names identify devices at the counter.");
        }
        UUID id = UUID.randomUUID();
        Timestamp now = Timestamp.from(clock.instant());
        jdbc.sql("insert into payment_entry_devices (id, merchant_id, branch_id, device_type, public_token, display_name, assigned_cashier_user_id, status, "
                        + "client_request_id, created_by_user_id, created_at, updated_at, version) values (:id, :m, :b, :t, :tok, :n, :c, 'ACTIVE', :req, :u, :now, :now, 0)")
                .param("id", id).param("m", merchantId).param("b", request.branchId()).param("t", type).param("tok", EntryTokens.newDeviceToken()).param("n", name)
                .param("c", request.assignedCashierUserId()).param("req", request.clientRequestId()).param("u", actor.userId()).param("now", now).update();
        openAssignment(merchantId, id, request.branchId(), branchName, request.assignedCashierUserId(), cashierName, actor.userId(), now, "Registered");
        audit.record(merchantId, actor.userId(), "ENTRY_DEVICE_REGISTERED", "entry_device", id, "Registered " + type + " device \"" + name + "\".");
        return new Written(dto(actor, read(merchantId, id).orElseThrow()), true);
    }

    @Transactional
    public EntryDtos.DeviceDto assign(UUID merchantId, UUID deviceId, EntryDtos.AssignRequest request) {
        Actor actor = access.require(merchantId, Permission.ENTRY_DEVICES_MANAGE);
        Device device = lock(merchantId, deviceId);
        requireManageScope(actor, device.branchId());
        requireVersion(device, request.expectedVersion());
        if ("REVOKED".equals(device.status())) {
            throw ApiException.conflict("device_revoked", "A revoked device is final.");
        }
        if (device.branchId().equals(request.branchId()) && java.util.Objects.equals(device.cashierId(), request.assignedCashierUserId())) {
            throw ApiException.conflict("no_change", "This is already the branch and cashier of the device.");
        }
        String branchName = requireUsableBranch(merchantId, request.branchId());
        requireManageScope(actor, request.branchId());
        String cashierName = requireEligibleCashier(merchantId, request.assignedCashierUserId(), request.branchId());
        if ("NFC_BRACELET".equals(device.type()) && request.assignedCashierUserId() == null) {
            throw ApiException.validation("A bracelet is personal: it always keeps a cashier.");
        }
        Instant now = clock.instant();
        // The open bill stays only if it still fits: same branch and, when the new cashier is named, that cashier's sale.
        Optional<OpenBinding> open = openBinding(device.id());
        if (open.isPresent() && (!device.branchId().equals(request.branchId())
                || (request.assignedCashierUserId() != null && !request.assignedCashierUserId().equals(open.get().agentId())))) {
            requireNoActiveSession(open.get(), now, Boolean.TRUE.equals(request.confirmActiveSession()));
            closeBinding(open.get(), device, now, "DEVICE_REASSIGNED", actor.userId());
        }
        Timestamp ts = Timestamp.from(now);
        jdbc.sql("update payment_entry_device_assignments set valid_to = :now where device_id = :d and valid_to is null").param("now", ts).param("d", deviceId).update();
        openAssignment(merchantId, deviceId, request.branchId(), branchName, request.assignedCashierUserId(), cashierName, actor.userId(), ts, trim(request.reason()));
        jdbc.sql("update payment_entry_devices set branch_id = :b, assigned_cashier_user_id = :c, updated_at = :now, version = version + 1 where id = :d")
                .param("b", request.branchId()).param("c", request.assignedCashierUserId()).param("now", ts).param("d", deviceId).update();
        audit.record(merchantId, actor.userId(), "ENTRY_DEVICE_ASSIGNED", "entry_device", deviceId,
                "Device \"" + device.name() + "\" now at branch " + branchName + (cashierName == null ? " with no fixed cashier." : " for " + cashierName + "."));
        return dto(actor, read(merchantId, deviceId).orElseThrow());
    }

    @Transactional
    public EntryDtos.DeviceDto suspend(UUID merchantId, UUID deviceId, EntryDtos.StatusRequest request) {
        return changeStatus(merchantId, deviceId, request, "ACTIVE", "SUSPENDED", "ENTRY_DEVICE_SUSPENDED", "suspended");
    }

    @Transactional
    public EntryDtos.DeviceDto reactivate(UUID merchantId, UUID deviceId, EntryDtos.StatusRequest request) {
        return changeStatus(merchantId, deviceId, request, "SUSPENDED", "ACTIVE", "ENTRY_DEVICE_REACTIVATED", "reactivated");
    }

    private EntryDtos.DeviceDto changeStatus(UUID merchantId, UUID deviceId, EntryDtos.StatusRequest request, String from, String to, String kind, String verb) {
        Actor actor = access.require(merchantId, Permission.ENTRY_DEVICES_MANAGE);
        Device device = lock(merchantId, deviceId);
        requireManageScope(actor, device.branchId());
        requireVersion(device, request.expectedVersion());
        if (!from.equals(device.status())) {
            throw ApiException.conflict("device_status_invalid", "A device that is " + device.status().toLowerCase(java.util.Locale.ROOT) + " cannot be " + verb + ".");
        }
        jdbc.sql("update payment_entry_devices set status = :s, status_reason = :r, updated_at = :now, version = version + 1 where id = :d")
                .param("s", to).param("r", trim(request.reason())).param("now", Timestamp.from(clock.instant())).param("d", deviceId).update();
        audit.record(merchantId, actor.userId(), kind, "entry_device", deviceId, "Device \"" + device.name() + "\" " + verb + ": " + trim(request.reason()));
        return dto(actor, read(merchantId, deviceId).orElseThrow());
    }

    /** Revoking is final. The device URL stops working at once; sales, bindings and assignment history stay exactly as they were. */
    @Transactional
    public EntryDtos.DeviceDto revoke(UUID merchantId, UUID deviceId, EntryDtos.StatusRequest request) {
        Actor actor = access.require(merchantId, Permission.ENTRY_DEVICES_MANAGE);
        Device device = lock(merchantId, deviceId);
        requireManageScope(actor, device.branchId());
        requireVersion(device, request.expectedVersion());
        if ("REVOKED".equals(device.status())) {
            throw ApiException.conflict("device_revoked", "This device is already revoked.");
        }
        Instant now = clock.instant();
        Timestamp ts = Timestamp.from(now);
        endClaims(device.id(), ts, "DEVICE_REVOKED");
        openBinding(device.id()).ifPresent(b -> closeBindingRow(b, ts, "DEVICE_REVOKED", actor.userId()));
        jdbc.sql("update payment_entry_device_assignments set valid_to = :now where device_id = :d and valid_to is null").param("now", ts).param("d", deviceId).update();
        jdbc.sql("update payment_entry_devices set status = 'REVOKED', status_reason = :r, revoked_at = :now, updated_at = :now, version = version + 1 where id = :d")
                .param("r", trim(request.reason())).param("now", ts).param("d", deviceId).update();
        audit.record(merchantId, actor.userId(), "ENTRY_DEVICE_REVOKED", "entry_device", deviceId, "Device \"" + device.name() + "\" revoked: " + trim(request.reason()));
        return dto(actor, read(merchantId, deviceId).orElseThrow());
    }

    // ---------------------------------------------------------------------------------------------
    // Binding
    // ---------------------------------------------------------------------------------------------

    @Transactional
    public EntryDtos.DeviceDto bind(UUID merchantId, UUID deviceId, EntryDtos.BindRequest request) {
        Actor actor = access.require(merchantId, Permission.ENTRY_DEVICES_BIND);
        Device device = lock(merchantId, deviceId);
        if (!visible(actor, device)) {
            throw notFound();
        }
        requireBindScope(actor, device);
        requireVersion(device, request.expectedVersion());
        if (!"ACTIVE".equals(device.status())) {
            throw ApiException.conflict("device_not_active", "A " + device.status().toLowerCase(java.util.Locale.ROOT) + " device cannot be given a bill.");
        }
        record SaleRow(UUID id, UUID branchId, UUID agentId, String agentName, String reference, Timestamp expiresAt, Timestamp cancelledAt) {}
        SaleRow sale = jdbc.sql("select s.payment_request_id, s.branch_id, s.agent_user_id, s.agent_name, s.sale_reference, r.expires_at, r.cancelled_at from code_sales s "
                        + "join payment_requests r on r.id = s.payment_request_id and r.merchant_id = s.merchant_id where s.payment_request_id = :s and s.merchant_id = :m")
                .param("s", request.saleId()).param("m", merchantId)
                .query((rs, i) -> new SaleRow(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getObject(3, UUID.class), rs.getString(4), rs.getString(5),
                        rs.getTimestamp(6), rs.getTimestamp(7))).optional().orElseThrow(() -> ApiException.notFound("This sale could not be found."));
        if (!sale.branchId().equals(device.branchId())) {
            throw ApiException.conflict("sale_branch_mismatch", "This sale belongs to another branch than the device.");
        }
        if (device.cashierId() != null && !device.cashierId().equals(sale.agentId())) {
            throw ApiException.conflict("sale_agent_mismatch", "This device belongs to another cashier: it only leads to that cashier's sales.");
        }
        if (actor.role() == Role.CASHIER && !actor.userId().equals(sale.agentId())) {
            throw ApiException.forbidden("A cashier can only give a device their own sales.");
        }
        Instant now = clock.instant();
        String status = saleStatus(sale.reference());
        Optional<OpenBinding> open = openBinding(device.id());
        if (open.isPresent() && open.get().saleId().equals(sale.id())) {
            return dto(actor, device);
        }
        if (!BINDABLE.contains(status) || sale.cancelledAt() != null || !sale.expiresAt().toInstant().isAfter(now)) {
            throw ApiException.conflict("sale_not_bindable", "A bill that is " + readable(status) + " cannot be given to a device.");
        }
        if (open.isPresent()) {
            String current = saleStatus(open.get().reference());
            if (!TERMINAL.contains(current)) {
                throw ApiException.conflict("device_has_open_bill", "This device still leads to bill " + open.get().reference() + ". Close it first.");
            }
            closeBinding(open.get(), device, now, switch (current) {
                case "PAID" -> "SALE_PAID";
                case "CANCELLED" -> "SALE_CANCELLED";
                default -> "SALE_EXPIRED";
            }, null);
        }
        if (jdbc.sql("select count(*) from payment_entry_bindings where sale_id = :s and ended_at is null").param("s", sale.id()).query(Integer.class).single() > 0) {
            throw ApiException.conflict("sale_already_bound", "This bill already leads from another device.");
        }
        jdbc.sql("insert into payment_entry_bindings (id, device_id, merchant_id, branch_id, sale_id, agent_user_id, bound_by_user_id, bound_at) values (:id, :d, :m, :b, :s, :a, :u, :now)")
                .param("id", UUID.randomUUID()).param("d", deviceId).param("m", merchantId).param("b", device.branchId()).param("s", sale.id()).param("a", sale.agentId())
                .param("u", actor.userId()).param("now", Timestamp.from(now)).update();
        jdbc.sql("update payment_entry_devices set updated_at = :now, version = version + 1 where id = :d").param("now", Timestamp.from(now)).param("d", deviceId).update();
        audit.record(merchantId, actor.userId(), "ENTRY_DEVICE_BILL_BOUND", "entry_device", deviceId,
                "Device \"" + device.name() + "\" now leads to bill " + sale.reference() + " of " + sale.agentName() + ".");
        return dto(actor, read(merchantId, deviceId).orElseThrow());
    }

    @Transactional
    public EntryDtos.DeviceDto unbind(UUID merchantId, UUID deviceId, EntryDtos.UnbindRequest request) {
        Actor actor = access.require(merchantId, Permission.ENTRY_DEVICES_BIND);
        Device device = lock(merchantId, deviceId);
        if (!visible(actor, device)) {
            throw notFound();
        }
        requireBindScope(actor, device);
        OpenBinding open = openBinding(device.id()).orElseThrow(() -> ApiException.conflict("no_open_bill", "This device has no bill to close."));
        Instant now = clock.instant();
        requireNoActiveSession(open, now, Boolean.TRUE.equals(request.confirmActiveSession()));
        closeBinding(open, device, now, "UNBOUND", actor.userId());
        jdbc.sql("update payment_entry_devices set updated_at = :now, version = version + 1 where id = :d").param("now", Timestamp.from(now)).param("d", deviceId).update();
        audit.record(merchantId, actor.userId(), "ENTRY_DEVICE_BILL_UNBOUND", "entry_device", deviceId,
                "Device \"" + device.name() + "\" no longer leads to bill " + open.reference() + ": " + trim(request.reason()));
        return dto(actor, read(merchantId, deviceId).orElseThrow());
    }

    // ---------------------------------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------------------------------

    private static final String DEVICE_SELECT = "select d.id, d.merchant_id, d.device_type, d.public_token, d.display_name, d.branch_id, d.assigned_cashier_user_id, d.status, d.version, "
            + "cast(d.client_request_id as varchar) from payment_entry_devices d";

    private static final org.springframework.jdbc.core.RowMapper<Device> DEVICE_MAPPER = (rs, i) -> new Device(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class),
            rs.getString(3), rs.getString(4), rs.getString(5), rs.getObject(6, UUID.class), rs.getObject(7, UUID.class), rs.getString(8), rs.getLong(9), rs.getString(10));

    private Optional<Device> read(UUID merchantId, UUID deviceId) {
        return jdbc.sql(DEVICE_SELECT + " where d.id = :d and d.merchant_id = :m").param("d", deviceId).param("m", merchantId).query(DEVICE_MAPPER).optional();
    }

    private Device lock(UUID merchantId, UUID deviceId) {
        return jdbc.sql(DEVICE_SELECT + " where d.id = :d and d.merchant_id = :m for update").param("d", deviceId).param("m", merchantId).query(DEVICE_MAPPER).optional()
                .orElseThrow(EntryDeviceService::notFound);
    }

    private Optional<OpenBinding> openBinding(UUID deviceId) {
        return jdbc.sql("select b.id, b.sale_id, b.agent_user_id, s.sale_reference from payment_entry_bindings b join code_sales s on s.payment_request_id = b.sale_id and s.merchant_id = b.merchant_id "
                        + "where b.device_id = :d and b.ended_at is null").param("d", deviceId)
                .query((rs, i) -> new OpenBinding(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getObject(3, UUID.class), rs.getString(4))).optional();
    }

    private boolean activeSession(UUID bindingId, Instant now) {
        return jdbc.sql("select count(*) from payment_entry_claims where binding_id = :b and ended_at is null and expires_at > :now")
                .param("b", bindingId).param("now", Timestamp.from(now)).query(Integer.class).single() > 0;
    }

    private void requireNoActiveSession(OpenBinding binding, Instant now, boolean confirmed) {
        if (!confirmed && activeSession(binding.id(), now)) {
            throw ApiException.conflict("customer_session_active", "A customer is looking at this bill right now. Confirm to close it anyway.");
        }
    }

    private void closeBinding(OpenBinding binding, Device device, Instant now, String reason, UUID by) {
        Timestamp ts = Timestamp.from(now);
        endClaims(device.id(), ts, "BINDING_ENDED");
        closeBindingRow(binding, ts, reason, by);
    }

    private void closeBindingRow(OpenBinding binding, Timestamp ts, String reason, UUID by) {
        jdbc.sql("update payment_entry_bindings set ended_at = :now, end_reason = :r, ended_by_user_id = :u where id = :b and ended_at is null")
                .param("now", ts).param("r", reason).param("u", by).param("b", binding.id()).update();
    }

    private void endClaims(UUID deviceId, Timestamp ts, String reason) {
        jdbc.sql("update payment_entry_claims set ended_at = :now, end_reason = :r where device_id = :d and ended_at is null")
                .param("now", ts).param("r", reason).param("d", deviceId).update();
    }

    private void openAssignment(UUID merchantId, UUID deviceId, UUID branchId, String branchName, UUID cashierId, String cashierName, UUID by, Timestamp at, String reason) {
        jdbc.sql("insert into payment_entry_device_assignments (id, device_id, merchant_id, branch_id, branch_name, assigned_cashier_user_id, assigned_cashier_name, valid_from, assigned_by_user_id, change_reason) "
                        + "values (:id, :d, :m, :b, :bn, :c, :cn, :at, :u, :r)")
                .param("id", UUID.randomUUID()).param("d", deviceId).param("m", merchantId).param("b", branchId).param("bn", branchName).param("c", cashierId).param("cn", cashierName)
                .param("at", at).param("u", by).param("r", reason).update();
    }

    private String requireUsableBranch(UUID merchantId, UUID branchId) {
        return jdbc.sql("select name from branches where id = :b and merchant_id = :m and status = 'ACTIVE'").param("b", branchId).param("m", merchantId).query(String.class).optional()
                .orElseThrow(() -> ApiException.conflict("branch_not_eligible", "A device can only belong to an active branch of this business."));
    }

    /** The cashier's name, or null when no cashier is chosen. They must be an ACTIVE member assigned to the branch. */
    private String requireEligibleCashier(UUID merchantId, UUID userId, UUID branchId) {
        if (userId == null) {
            return null;
        }
        return jdbc.sql("select u.full_name from memberships m join users u on u.id = m.user_id join branch_assignments a on a.membership_id = m.id and a.merchant_id = m.merchant_id "
                        + "where m.user_id = :u and m.merchant_id = :m and m.status = 'ACTIVE' and u.status = 'ACTIVE' and a.branch_id = :b and a.status = 'ACTIVE'")
                .param("u", userId).param("m", merchantId).param("b", branchId).query(String.class).optional()
                .orElseThrow(() -> ApiException.conflict("cashier_not_eligible", "The cashier must be an active member assigned to this branch."));
    }

    private Set<UUID> myBranches(Actor actor) {
        return jdbc.sql("select branch_id from branch_assignments where membership_id = :m and status = 'ACTIVE'").param("m", actor.membership().getId())
                .query(UUID.class).list().stream().collect(Collectors.toSet());
    }

    /** A manager acts only on branches they are assigned to; an owner on all. */
    private void requireManageScope(Actor actor, UUID branchId) {
        if (actor.role() == Role.MANAGER && !myBranches(actor).contains(branchId)) {
            throw ApiException.forbidden("You can only manage devices of branches you are assigned to.");
        }
    }

    private void requireBindScope(Actor actor, Device device) {
        switch (actor.role()) {
            case MANAGER -> requireManageScope(actor, device.branchId());
            case CASHIER -> {
                boolean mine = actor.userId().equals(device.cashierId());
                boolean sharedAtMyBranch = device.cashierId() == null && myBranches(actor).contains(device.branchId());
                if (!mine && !sharedAtMyBranch) {
                    throw ApiException.forbidden("This device is not yours.");
                }
            }
            default -> { }
        }
    }

    /** A cashier sees the devices assigned to them and the shared ones of their branches; owners and managers see every device. */
    private boolean visible(Actor actor, Device device) {
        if (actor.role() != Role.CASHIER) {
            return true;
        }
        return actor.userId().equals(device.cashierId()) || (device.cashierId() == null && myBranches(actor).contains(device.branchId()));
    }

    private static void requireVersion(Device device, long expected) {
        if (device.version() != expected) {
            throw ApiException.conflict("version_conflict", "This device was changed by someone else. Reload it and try again.");
        }
    }

    private String saleStatus(String reference) {
        try {
            return sales.sale(reference).status().name();
        } catch (ApiException e) {
            return "UNKNOWN";
        }
    }

    private static String readable(String status) {
        return status.toLowerCase(java.util.Locale.ROOT).replace('_', ' ');
    }

    private EntryDtos.DeviceDto dto(Actor actor, Device d) {
        record Names(String branchName, String cashierName, Timestamp created, Timestamp updated, String reason) {}
        Names names = jdbc.sql("select b.name, u.full_name, d.created_at, d.updated_at, d.status_reason from payment_entry_devices d join branches b on b.id = d.branch_id and b.merchant_id = d.merchant_id "
                        + "left join users u on u.id = d.assigned_cashier_user_id where d.id = :d").param("d", d.id())
                .query((rs, i) -> new Names(rs.getString(1), rs.getString(2), rs.getTimestamp(3), rs.getTimestamp(4), rs.getString(5))).single();
        return new EntryDtos.DeviceDto(d.id(), d.type(), d.name(), "/e/" + d.token(), d.branchId(), names.branchName(), d.cashierId(), names.cashierName(), d.status(), names.reason(),
                names.created().toInstant(), names.updated().toInstant(), d.version(), bindingDto(d));
    }

    private EntryDtos.BindingDto bindingDto(Device d) {
        record Row(UUID id, UUID saleId, String reference, long amount, String description, String mode, String agent, Timestamp boundAt, Timestamp expires) {}
        Optional<Row> row = jdbc.sql("select b.id, b.sale_id, s.sale_reference, s.amount_rwf, s.description, s.presentation_mode, s.agent_name, b.bound_at, r.expires_at "
                        + "from payment_entry_bindings b join code_sales s on s.payment_request_id = b.sale_id and s.merchant_id = b.merchant_id "
                        + "join payment_requests r on r.id = s.payment_request_id and r.merchant_id = s.merchant_id where b.device_id = :d and b.ended_at is null").param("d", d.id())
                .query((rs, i) -> new Row(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3), rs.getLong(4), rs.getString(5), rs.getString(6), rs.getString(7),
                        rs.getTimestamp(8), rs.getTimestamp(9))).optional();
        if (row.isEmpty()) {
            return null;
        }
        Row r = row.get();
        Optional<Timestamp> session = jdbc.sql("select expires_at from payment_entry_claims where binding_id = :b and ended_at is null and expires_at > :now order by expires_at desc limit 1")
                .param("b", r.id()).param("now", Timestamp.from(clock.instant())).query((rs, i) -> rs.getTimestamp(1)).optional();
        return new EntryDtos.BindingDto(r.id(), r.saleId(), r.reference(), r.amount(), r.description(), r.mode(), r.agent(), r.boundAt().toInstant(), r.expires().toInstant(),
                saleStatus(r.reference()), session.isPresent(), session.map(Timestamp::toInstant).orElse(null));
    }

    private static Instant instant(Timestamp t) {
        return t == null ? null : t.toInstant();
    }

    private static String trim(String text) {
        return text == null || text.isBlank() ? null : text.trim();
    }

    private static ApiException notFound() {
        return ApiException.notFound("This device could not be found.");
    }
}
