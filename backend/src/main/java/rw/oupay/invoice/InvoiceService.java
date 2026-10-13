package rw.oupay.invoice;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.branch.Branch;
import rw.oupay.branch.BranchAssignmentRepository;
import rw.oupay.branch.BranchRepository;
import rw.oupay.common.ApiException;
import rw.oupay.common.Pagination;
import rw.oupay.ledger.InvoiceBalanceReader;
import rw.oupay.ledger.LedgerMath;
import rw.oupay.membership.Actor;
import rw.oupay.membership.Membership;
import rw.oupay.membership.MembershipRepository;
import rw.oupay.membership.MembershipStatus;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.membership.Permission;
import rw.oupay.membership.Role;
import rw.oupay.merchant.Merchant;
import rw.oupay.merchant.MerchantRepository;
import rw.oupay.user.User;
import rw.oupay.user.UserRepository;
import rw.oupay.user.UserStatus;
import tools.jackson.databind.json.JsonMapper;

@Service
public class InvoiceService {

    private static final ZoneId KIGALI = ZoneId.of("Africa/Kigali");
    private static final Pattern EMAIL = Pattern.compile("^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$");
    private static final Pattern TIN = Pattern.compile("^\\d{9}$");
    private static final int MAX_ITEMS = 50;
    private static final long MAX_UNIT_PRICE = 1_000_000_000L;
    private static final long MAX_QUANTITY_MILLI = 1_000_000L * InvoiceCalculator.QUANTITY_SCALE;

    private final InvoiceRepository invoices;
    private final MerchantRepository merchants;
    private final BranchRepository branches;
    private final BranchAssignmentRepository assignments;
    private final MembershipRepository memberships;
    private final UserRepository users;
    private final InvoiceBalanceReader balances;
    private final MerchantAccess access;
    private final AuditService audit;
    private final JdbcClient jdbc;
    private final JsonMapper json;
    private final Clock clock;

    public InvoiceService(InvoiceRepository invoices, MerchantRepository merchants, BranchRepository branches,
                          BranchAssignmentRepository assignments, MembershipRepository memberships, UserRepository users,
                          InvoiceBalanceReader balances, MerchantAccess access, AuditService audit, JdbcClient jdbc,
                          JsonMapper json, Clock clock) {
        this.invoices = invoices;
        this.merchants = merchants;
        this.branches = branches;
        this.assignments = assignments;
        this.memberships = memberships;
        this.users = users;
        this.balances = balances;
        this.access = access;
        this.audit = audit;
        this.jdbc = jdbc;
        this.json = json;
        this.clock = clock;
    }

    // ---- reads ---------------------------------------------------------------------------------

    /** Cashiers receive only invoices assigned to them: the restriction is in the query itself. */
    @Transactional(readOnly = true)
    public InvoiceDtos.InvoicePage list(UUID merchantId, Integer limit, String cursor) {
        Actor actor = access.require(merchantId, Permission.INVOICES_VIEW);
        int size = Pagination.limit(limit);
        var position = Pagination.decode(cursor);
        boolean everything = actor.hasFullScope(Permission.INVOICES_VIEW);
        List<Invoice> fetched = everything
                ? invoices.pageForMerchant(merchantId, position.at(), position.id(), Pagination.fetch(size))
                : invoices.pageAssignedTo(merchantId, actor.userId(), position.at(), position.id(), Pagination.fetch(size));
        long total = everything ? invoices.countByMerchantId(merchantId) : invoices.countByMerchantIdAndAssignedToUserId(merchantId, actor.userId());
        var page = Pagination.page(fetched, size, Invoice::getCreatedAt, Invoice::getId, total);
        Map<UUID, Long> allocated = balances.allocatedByInvoice(page.items().stream().map(Invoice::getId).toList());
        return new InvoiceDtos.InvoicePage(page.items().stream().map(i -> toDto(i, allocated.getOrDefault(i.getId(), 0L))).toList(),
                total, page.nextCursor());
    }

    @Transactional(readOnly = true)
    public InvoiceDtos.InvoiceDto get(UUID merchantId, UUID invoiceId) {
        Actor actor = access.require(merchantId, Permission.INVOICES_VIEW);
        Invoice invoice = visible(actor, merchantId, invoiceId);
        return toDto(invoice, balances.allocated(invoice.getId()));
    }

    @Transactional(readOnly = true)
    public InvoiceDtos.FormOptions formOptions(UUID merchantId) {
        Actor actor = access.require(merchantId, Permission.INVOICES_CREATE);
        List<Branch> activeBranches = branches.findByMerchantIdOrderByNameAsc(merchantId).stream().filter(Branch::isActive).toList();
        var activeBranchIds = activeBranches.stream().map(Branch::getId).collect(java.util.stream.Collectors.toSet());
        var activeAssignments = assignments.findByMerchantIdAndStatus(merchantId, "ACTIVE").stream()
                .filter(a -> activeBranchIds.contains(a.getBranchId())).toList();
        List<InvoiceDtos.AssigneeOption> assignees = new ArrayList<>();
        for (Membership m : memberships.findByMerchantId(merchantId)) {
            if (m.getStatus() != MembershipStatus.ACTIVE) {
                continue;
            }
            if (actor.role() == Role.CASHIER && !m.getUserId().equals(actor.userId())) {
                continue; // cashiers may only act for themselves
            }
            Optional<User> user = users.findById(m.getUserId()).filter(u -> u.getStatus() == UserStatus.ACTIVE);
            List<UUID> branchIds = activeAssignments.stream().filter(a -> a.getMembershipId().equals(m.getId()))
                    .map(a -> a.getBranchId()).toList();
            if (user.isPresent() && !branchIds.isEmpty()) {
                assignees.add(new InvoiceDtos.AssigneeOption(user.get().getId(), m.getId(), user.get().getFullName(), branchIds));
            }
        }
        assignees.sort(Comparator.comparing(InvoiceDtos.AssigneeOption::fullName));
        var usable = assignees.stream().flatMap(a -> a.branchIds().stream()).collect(java.util.stream.Collectors.toSet());
        List<InvoiceDtos.BranchOption> options = activeBranches.stream()
                .filter(b -> actor.role() != Role.CASHIER || usable.contains(b.getId()))
                .map(b -> new InvoiceDtos.BranchOption(b.getId(), b.getName(), b.getCode()))
                .toList();
        return new InvoiceDtos.FormOptions(options, assignees);
    }

    // ---- writes --------------------------------------------------------------------------------

    @Transactional
    public InvoiceDtos.InvoiceDto createDraft(UUID merchantId, InvoiceDtos.DraftRequest request) {
        Actor actor = access.require(merchantId, Permission.INVOICES_CREATE);
        Prepared prepared = prepare(actor, merchantId, request);
        Instant now = clock.instant();
        Invoice invoice = new Invoice(UUID.randomUUID(), merchantId, nextInvoiceNumber(merchantId), actor.userId(),
                actor.user().getFullName(), now);
        applyContent(invoice, request, prepared, now);
        invoices.saveAndFlush(invoice);
        audit.record(merchantId, actor.userId(), "INVOICE_DRAFT_CREATED", "invoice", invoice.getId(),
                "Draft " + invoice.getInvoiceNumber() + " created.");
        return toDto(invoice, 0);
    }

    @Transactional
    public InvoiceDtos.InvoiceDto updateDraft(UUID merchantId, UUID invoiceId, InvoiceDtos.DraftRequest request, long expectedVersion) {
        Actor actor = access.require(merchantId, Permission.INVOICES_CREATE);
        Invoice invoice = visible(actor, merchantId, invoiceId);
        if (invoice.getStatus() != InvoiceStatus.DRAFT) {
            throw ApiException.invalidState("invalid_transition", "Only drafts can be edited.");
        }
        assertVersion(invoice, expectedVersion);
        Prepared prepared = prepare(actor, merchantId, request);
        // Remove the old lines first: the new ones reuse the same (invoice, line number) keys.
        invoice.getItems().clear();
        invoices.flush();
        applyContent(invoice, request, prepared, clock.instant());
        invoices.saveAndFlush(invoice);
        audit.record(merchantId, actor.userId(), "INVOICE_DRAFT_UPDATED", "invoice", invoiceId, "Draft " + invoice.getInvoiceNumber() + " updated.");
        return toDto(invoice, 0);
    }

    /** DRAFT to ISSUED, with strict validation. Never implies the invoice has been paid. */
    @Transactional
    public InvoiceDtos.InvoiceDto issue(UUID merchantId, UUID invoiceId, long expectedVersion) {
        Actor actor = access.require(merchantId, Permission.INVOICES_CREATE);
        Invoice invoice = visible(actor, merchantId, invoiceId);
        if (!invoice.getStatus().canTransitionTo(InvoiceStatus.ISSUED)) {
            throw ApiException.invalidState("invalid_transition", "Only drafts can be issued.");
        }
        assertVersion(invoice, expectedVersion);
        // Eligibility is re-checked now: the branch or assignment may have changed since the draft.
        Branch branch = activeBranch(merchantId, invoice.getBranchId());
        User assignee = assertAssigneeEligible(merchantId, branch, invoice.getAssignedToUserId());
        validateForIssue(invoice);
        invoice.issue(snapshotOf(merchantId), branchSnapshot(branch), assignee.getFullName(), clock.instant());
        invoices.saveAndFlush(invoice);
        audit.record(merchantId, actor.userId(), "INVOICE_ISSUED", "invoice", invoiceId, "Invoice " + invoice.getInvoiceNumber() + " issued.");
        return toDto(invoice, 0);
    }

    @Transactional
    public InvoiceDtos.InvoiceDto cancelDraft(UUID merchantId, UUID invoiceId, long expectedVersion) {
        Actor actor = access.require(merchantId, Permission.INVOICES_CREATE);
        Invoice invoice = visible(actor, merchantId, invoiceId);
        if (!invoice.getStatus().canTransitionTo(InvoiceStatus.CANCELLED)) {
            throw ApiException.invalidState("invalid_transition", invoice.getStatus() == InvoiceStatus.ISSUED
                    ? "An issued invoice cannot be cancelled. Ask an owner to void it."
                    : "This invoice can no longer be cancelled.");
        }
        assertVersion(invoice, expectedVersion);
        invoice.cancel(clock.instant());
        invoices.saveAndFlush(invoice);
        audit.record(merchantId, actor.userId(), "INVOICE_CANCELLED", "invoice", invoiceId, "Draft " + invoice.getInvoiceNumber() + " cancelled.");
        return toDto(invoice, 0);
    }

    /** ISSUED to VOIDED under the correction policy: owner only, unpaid only, with a reason. */
    @Transactional
    public InvoiceDtos.InvoiceDto voidInvoice(UUID merchantId, UUID invoiceId, String reason, long expectedVersion) {
        Actor actor = access.require(merchantId, Permission.INVOICES_VOID);
        visible(actor, merchantId, invoiceId);
        // Lock first: a concurrent allocation and a void can never both succeed.
        Invoice invoice = invoices.lockByIdAndMerchantId(invoiceId, merchantId).orElseThrow(() -> notFound());
        if (!invoice.getStatus().canTransitionTo(InvoiceStatus.VOIDED)) {
            throw ApiException.invalidState("invalid_transition", "Only issued invoices can be voided.");
        }
        long allocated = balances.allocated(invoiceId);
        if (LedgerMath.summarize(invoice.getGrandTotalRwf(), allocated).paymentStatus() != LedgerMath.PaymentStatus.UNPAID) {
            throw ApiException.invalidState("void_not_allowed",
                    "An invoice with payment activity cannot be voided. It needs a credit note or refund instead.");
        }
        if (reason == null || reason.trim().length() < 3) {
            throw ApiException.validation("Give a reason for voiding this invoice.");
        }
        assertVersion(invoice, expectedVersion);
        invoice.voidInvoice(reason.trim(), clock.instant());
        invoices.saveAndFlush(invoice);
        audit.record(merchantId, actor.userId(), "INVOICE_VOIDED", "invoice", invoiceId, "Invoice " + invoice.getInvoiceNumber() + " voided.");
        return toDto(invoice, 0);
    }

    // ---- internals -----------------------------------------------------------------------------

    private record Prepared(Branch branch, User assignee, InvoiceCalculator.Result calculation, LocalDate dueOn,
                            String merchantSnapshot, String branchSnapshot) {}

    private Prepared prepare(Actor actor, UUID merchantId, InvoiceDtos.DraftRequest request) {
        validateDraft(request);
        if (actor.role() == Role.CASHIER && !request.assignedToUserId().equals(actor.userId())) {
            throw ApiException.forbidden("Cashiers can only create invoices for themselves.");
        }
        Branch branch = activeBranch(merchantId, request.branchId());
        User assignee = assertAssigneeEligible(merchantId, branch, request.assignedToUserId());
        InvoiceCalculator.Result result = InvoiceCalculator.calculate(lineInputs(request), request.taxMode());
        return new Prepared(branch, assignee, result, parseDate(request.dueAt()), snapshotOf(merchantId), branchSnapshot(branch));
    }

    private void applyContent(Invoice invoice, InvoiceDtos.DraftRequest request, Prepared p, Instant now) {
        var c = request.customer();
        invoice.applyContent(p.branch().getId(), p.assignee().getId(), p.assignee().getFullName(), c.name().trim(),
                blankToNull(c.email()), blankToNull(c.phoneNumber()), blankToNull(c.address()), blankToNull(c.tin()),
                p.merchantSnapshot(), p.branchSnapshot(), request.taxMode(), p.calculation(), p.dueOn(),
                blankToNull(request.notes()), now);
    }

    private static List<InvoiceCalculator.LineInput> lineInputs(InvoiceDtos.DraftRequest request) {
        return request.items().stream()
                .map(i -> new InvoiceCalculator.LineInput(i.description().trim(), InvoiceCalculator.toMilli(i.quantity()),
                        i.unitPrice(), i.discount(), i.taxRate().category(), i.taxRate().rateBp()))
                .toList();
    }

    /** Everything a DRAFT must satisfy. Issuing applies the stricter rules in {@link #validateForIssue}. */
    private static void validateDraft(InvoiceDtos.DraftRequest request) {
        var customer = request.customer();
        if (customer.email() != null && !customer.email().isBlank() && !EMAIL.matcher(customer.email()).matches()) {
            throw ApiException.validation("Customer email is not valid.");
        }
        if (customer.tin() != null && !customer.tin().isBlank() && !TIN.matcher(customer.tin()).matches()) {
            throw ApiException.validation("Customer TIN must be 9 digits.");
        }
        parseDate(request.dueAt());
        if (request.items().size() > MAX_ITEMS) {
            throw ApiException.validation("An invoice can have at most " + MAX_ITEMS + " items.");
        }
        int index = 0;
        for (InvoiceDtos.ItemInput item : request.items()) {
            index++;
            String label = "Item " + index;
            BigDecimal quantity = item.quantity();
            if (quantity.signum() <= 0 || InvoiceCalculator.decimals(quantity) > InvoiceCalculator.MAX_QUANTITY_DECIMALS) {
                throw ApiException.validation(label + ": quantity must be positive with at most "
                        + InvoiceCalculator.MAX_QUANTITY_DECIMALS + " decimal places.");
            }
            long milli = InvoiceCalculator.toMilli(quantity);
            if (milli < 1 || milli > MAX_QUANTITY_MILLI) {
                throw ApiException.validation(label + ": quantity is out of range.");
            }
            if (item.unitPrice() < 0 || item.unitPrice() > MAX_UNIT_PRICE) {
                throw ApiException.validation(label + ": unit price must be a whole amount of francs.");
            }
            if (item.discount() < 0) {
                throw ApiException.validation(label + ": discount must be a whole amount.");
            }
            if (item.taxRate().rateBp() < 0 || item.taxRate().rateBp() > InvoiceCalculator.BASIS_POINTS) {
                throw ApiException.validation(label + ": tax rate must be between 0% and 100%.");
            }
            long gross = InvoiceCalculator.mulDivRound(item.unitPrice(), milli, InvoiceCalculator.QUANTITY_SCALE);
            if (item.discount() > gross) {
                throw ApiException.validation("A discount cannot be larger than its line amount.");
            }
        }
    }

    private void validateForIssue(Invoice invoice) {
        if (invoice.getCustomerName() == null || invoice.getCustomerName().isBlank()) {
            throw ApiException.validation("Customer name is required to issue an invoice.");
        }
        for (InvoiceItem item : invoice.getItems()) {
            if (item.getDescription().isBlank() || item.getQuantityMilli() <= 0 || item.getUnitPriceRwf() <= 0) {
                throw ApiException.validation("Item " + item.getLineNo() + " needs a description, a quantity and a price above zero.");
            }
        }
        if (invoice.getGrandTotalRwf() <= 0) {
            throw ApiException.validation("An issued invoice must have a total above zero.");
        }
        if (invoice.getDueOn().isBefore(LocalDate.now(clock.withZone(KIGALI)))) {
            throw ApiException.validation("The due date cannot be in the past.");
        }
    }

    private Branch activeBranch(UUID merchantId, UUID branchId) {
        Branch branch = branches.findByIdAndMerchantId(branchId, merchantId)
                .orElseThrow(() -> ApiException.validation("Choose a branch of this business."));
        if (!branch.isActive()) {
            throw new ApiException(HttpStatus.CONFLICT, "branch_inactive", branch.getName() + " is inactive and cannot be used for new invoices.");
        }
        return branch;
    }

    /** The assignee must be an ACTIVE member with an ACTIVE assignment to this branch, right now. */
    private User assertAssigneeEligible(UUID merchantId, Branch branch, UUID assigneeUserId) {
        Optional<User> user = users.findById(assigneeUserId).filter(u -> u.getStatus() == UserStatus.ACTIVE);
        Optional<Membership> membership = memberships.findByUserIdAndMerchantId(assigneeUserId, merchantId).filter(Membership::isActive);
        boolean assigned = membership.isPresent()
                && assignments.existsByMembershipIdAndBranchIdAndStatus(membership.get().getId(), branch.getId(), "ACTIVE");
        if (user.isEmpty() || !assigned) {
            throw new ApiException(HttpStatus.CONFLICT, "assignee_not_eligible",
                    "That person is not an active member assigned to " + branch.getName() + ".");
        }
        return user.get();
    }

    private Invoice visible(Actor actor, UUID merchantId, UUID invoiceId) {
        Invoice invoice = invoices.findByIdAndMerchantId(invoiceId, merchantId).orElseThrow(InvoiceService::notFound);
        if (!actor.hasFullScope(Permission.INVOICES_VIEW) && !invoice.getAssignedToUserId().equals(actor.userId())) {
            throw notFound();
        }
        return invoice;
    }

    private static ApiException notFound() {
        return ApiException.notFound("This invoice could not be found.");
    }

    private static void assertVersion(Invoice invoice, long expected) {
        if (invoice.getVersion() != expected) {
            throw ApiException.conflict("version_conflict", "This invoice was changed by someone else. Reload it and try again.");
        }
    }

    /** Per-merchant sequence, never reused: cancelled and voided invoices keep their numbers. Atomic in SQL. */
    private String nextInvoiceNumber(UUID merchantId) {
        int next = jdbc.sql("insert into invoice_number_sequences (merchant_id, last_value) values (:m, 1) "
                        + "on conflict (merchant_id) do update set last_value = invoice_number_sequences.last_value + 1 "
                        + "returning last_value")
                .param("m", merchantId).query(Integer.class).single();
        return String.format("INV-%04d", next);
    }

    private String snapshotOf(UUID merchantId) {
        Merchant m = merchants.findById(merchantId).orElseThrow();
        String address = java.util.stream.Stream.of(m.getPhysicalAddress(), m.getSector(), m.getDistrict(), m.getProvince())
                .filter(s -> s != null && !s.isBlank()).collect(java.util.stream.Collectors.joining(", "));
        return json.writeValueAsString(new InvoiceDtos.MerchantSnapshot(m.getLegalName(), m.getTradingName(), m.getTin(),
                m.getRegistrationNumber(), address, m.getContactPhone(), m.getContactEmail()));
    }

    private String branchSnapshot(Branch b) {
        return json.writeValueAsString(new InvoiceDtos.BranchSnapshot(b.getName(), b.getCode(), b.getPhysicalAddress()));
    }

    private static LocalDate parseDate(String value) {
        try {
            return LocalDate.parse(value);
        } catch (DateTimeParseException e) {
            throw ApiException.validation("Due date is required (YYYY-MM-DD).");
        }
    }

    private static String blankToNull(String value) {
        return value == null || value.isBlank() ? null : value.trim();
    }

    InvoiceDtos.InvoiceDto toDto(Invoice i, long allocated) {
        LedgerMath.InvoicePayment payment = LedgerMath.summarize(i.getGrandTotalRwf(), allocated);
        var customer = new InvoiceDtos.Customer(i.getCustomerName(), i.getCustomerEmail(), i.getCustomerPhone(), i.getCustomerAddress(), i.getCustomerTin());
        var items = i.getItems().stream().map(it -> new InvoiceDtos.ItemDto(it.getId(), it.getDescription(),
                BigDecimal.valueOf(it.getQuantityMilli(), InvoiceCalculator.MAX_QUANTITY_DECIMALS).stripTrailingZeros(),
                it.getUnitPriceRwf(), it.getDiscountRwf(), new InvoiceDtos.TaxRate(it.getTaxCategory(), it.getTaxRateBp()),
                it.getNetAmountRwf(), it.getTaxAmountRwf(), it.getLineTotalRwf())).toList();
        return new InvoiceDtos.InvoiceDto(i.getId(), i.getMerchantId(), i.getBranchId(), i.getInvoiceNumber(),
                i.getCreatedByUserId(), i.getAssignedToUserId(), i.getCreatedByName(), i.getAssignedToName(), customer,
                json.readValue(i.getMerchantSnapshot(), InvoiceDtos.MerchantSnapshot.class),
                json.readValue(i.getBranchSnapshot(), InvoiceDtos.BranchSnapshot.class), items, i.getCurrency(),
                i.getTaxMode(), i.getSubtotalRwf(), i.getDiscountTotalRwf(), i.getTaxTotalRwf(), i.getGrandTotalRwf(),
                i.getIssuedAt(), i.getDueOn().toString(), i.getCreatedAt(), i.getUpdatedAt(), i.getCancelledAt(),
                i.getVoidedAt(), i.getVoidReason(), i.getStatus(), payment.paymentStatus(),
                new InvoiceDtos.PaymentDto(payment.invoiceTotal(), payment.allocatedAmount(), payment.remainingBalance(),
                        payment.unappliedAmount(), payment.paymentStatus()),
                i.getNotes(), i.getVersion());
    }
}
