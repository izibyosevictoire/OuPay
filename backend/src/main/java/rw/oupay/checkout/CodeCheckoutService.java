package rw.oupay.checkout;

import java.math.BigDecimal;
import java.sql.Timestamp;
import java.time.Clock;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.banking.PaymentDestination;
import rw.oupay.banking.PaymentDestinationRepository;
import rw.oupay.collection.CollectionCode;
import rw.oupay.collection.CollectionCodeAssignment;
import rw.oupay.collection.CollectionCodeService;
import rw.oupay.collection.CollectionCodeStatus;
import rw.oupay.common.ApiException;
import rw.oupay.idempotency.IdempotencyService;
import rw.oupay.invoice.InvoiceCalculator;
import rw.oupay.invoice.InvoiceCreation;
import rw.oupay.invoice.InvoiceDtos;
import rw.oupay.invoice.InvoiceService;
import rw.oupay.invoice.InvoiceStatus;
import rw.oupay.invoice.SaleChannel;
import rw.oupay.membership.Actor;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.membership.Permission;
import rw.oupay.merchant.MerchantRepository;
import rw.oupay.payment.PaymentDtos;
import rw.oupay.payment.PaymentProfileService;
import rw.oupay.payment.PaymentRequest;
import rw.oupay.payment.PaymentRequestOptions;
import rw.oupay.payment.PaymentRequestState;
import rw.oupay.payment.PaymentRequestRepository;
import rw.oupay.payment.PaymentRequestResolver;

/**
 * An agent's code-based sale: one invoice (channel CODE) with one line, issued, a fixed-amount payment request for it, and ONE immutable
 * record of the collection code and assignment it was made through, as ONE atomic operation. It composes the existing invoice, payment
 * request, idempotency and ledger machinery; there is no second ledger, and payment status is still derived from verified bank
 * transactions and allocations, never from anything this class says.
 *
 * <h2>What may be sold through, and what is merely shown</h2>
 * <ul>
 *   <li><b>LIVE</b>: the agent holds a bank-approved, non-simulated code that is eligible for collection right now (the registry's own live
 *       eligibility) AND live collection has been enabled by configuration. Equity's capabilities are unconfirmed and OuPay has no Equity
 *       integration, so live collection is OFF (and cannot be turned on outside the test profile, see {@link CodeCheckoutStartupGuard}).</li>
 *   <li><b>DEMONSTRATION</b>: the agent holds a SIMULATED code that is otherwise in good standing. The sale is real internal bookkeeping but
 *       no real bank payment can be made with it, and everything the customer sees says so. OuPay never invents a bank code for it.</li>
 *   <li>Anything else (an unapproved code on a real account, a suspended code, an inactive agent, ...) is refused with the reason.</li>
 * </ul>
 *
 * <h2>Transactions and idempotency</h2>
 * Not transactional itself: {@link IdempotencyService#executeOnce} owns the single transaction (it refuses to run inside one), and the
 * claim, the invoice with its durable request identity, the issue, the payment request, the sale record and the audit entries commit or
 * roll back together. A repeat of an existing sale is recognised BEFORE current eligibility is looked at, so a lost answer stays
 * recoverable after a reassignment, and it is always answered with the original code and assignment, never today's.
 */
@Service
public class CodeCheckoutService {

    private static final String SCOPE = "CODE_SALE";
    private static final String DEFAULT_DESCRIPTION = "Sale";
    private static final ZoneId KIGALI = ZoneId.of("Africa/Kigali");
    static final String DEMO_NOTICE = "DEMONSTRATION ONLY. This is a simulated code: no real bank payment can be made with it.";
    private static final Set<String> DEMO_ALLOWED_ISSUES = Set.of("SIMULATED", "NOT_BANK_APPROVED");
    private static final Set<CollectionCodeStatus> DEMO_STATUSES = Set.of(CollectionCodeStatus.REQUESTED, CollectionCodeStatus.REQUEST_DECLARED,
            CollectionCodeStatus.ACTIVE);

    private record Sale(long amount, String description, UUID codeId, UUID branchId, UUID clientRequestId) {}

    /** The stored record of a sale (what it was made through, as it was). */
    private record Stored(UUID saleId, UUID invoiceId, UUID branchId, String reference, long amount, String description, String mode, UUID agentUserId,
                          String agentName, UUID codeId, String codeLabel, String internalRef, String externalCode, String branchName, Instant createdAt) {}

    private final IdempotencyService idempotency;
    private final InvoiceService invoices;
    private final PaymentProfileService payments;
    private final CollectionCodeService codes;
    private final PaymentDestinationRepository destinations;
    private final PaymentRequestRepository requests;
    private final PaymentRequestResolver resolver;
    private final MerchantRepository merchants;
    private final MerchantAccess access;
    private final AuditService audit;
    private final JdbcClient jdbc;
    private final Clock clock;
    private final boolean liveEnabled;

    public CodeCheckoutService(IdempotencyService idempotency, InvoiceService invoices, PaymentProfileService payments, CollectionCodeService codes,
                               PaymentDestinationRepository destinations, PaymentRequestRepository requests, PaymentRequestResolver resolver,
                               MerchantRepository merchants, MerchantAccess access, AuditService audit, JdbcClient jdbc, Clock clock,
                               @Value("${oupay.code-checkout.live-enabled:false}") boolean liveEnabled) {
        this.idempotency = idempotency;
        this.invoices = invoices;
        this.payments = payments;
        this.codes = codes;
        this.destinations = destinations;
        this.requests = requests;
        this.resolver = resolver;
        this.merchants = merchants;
        this.access = access;
        this.audit = audit;
        this.jdbc = jdbc;
        this.clock = clock;
        this.liveEnabled = liveEnabled;
    }

    // ---- options -------------------------------------------------------------------------------

    /** The caller's own codes, and for each whether a sale can be made through it and why not. Nobody else's code is ever listed. */
    @Transactional(readOnly = true)
    public CodeCheckoutDtos.Options options(UUID merchantId) {
        Actor actor = access.require(merchantId, Permission.INVOICES_CREATE);
        List<CodeCheckoutDtos.CodeChoice> choices = new ArrayList<>();
        for (CollectionCodeService.HeldCode held : codes.heldByMe(merchantId)) {
            String mode = modeOf(held);
            UUID branch = held.assignment().getBranchId() != null ? held.assignment().getBranchId() : held.code().getBranchId();
            boolean paymentReady = branch == null
                    ? !"UNAVAILABLE".equals(mode)
                    : payments.canCollectTo(merchantId, branch, actor.userId(), held.code().getSettlementDestinationId());
            choices.add(new CodeCheckoutDtos.CodeChoice(held.code().getId(), held.code().getDisplayLabel(), mode,
                    "UNAVAILABLE".equals(mode) ? reasonOf(held) : null, paymentReady, held.assignment().getBranchName()));
        }
        CodeCheckoutDtos.Readiness readiness;
        if (choices.isEmpty()) {
            readiness = CodeCheckoutDtos.Readiness.NO_ASSIGNED_CODE;
        } else if (choices.stream().allMatch(c -> "UNAVAILABLE".equals(c.mode()))) {
            readiness = CodeCheckoutDtos.Readiness.CODE_NOT_AVAILABLE;
        } else if (choices.stream().noneMatch(c -> !"UNAVAILABLE".equals(c.mode()) && c.paymentReady())) {
            readiness = CodeCheckoutDtos.Readiness.NO_PAYMENT_LINK;
        } else {
            readiness = CodeCheckoutDtos.Readiness.READY;
        }
        return new CodeCheckoutDtos.Options(readiness, choices, SimplifiedCheckoutService.MIN_AMOUNT_RWF, SimplifiedCheckoutService.MAX_AMOUNT_RWF,
                (int) SimplifiedCheckoutService.PAYMENT_LIFETIME.toMinutes(), liveEnabled,
                "OuPay has no confirmed way to take payments with a bank code yet. Sales through a simulated code are demonstrations only.");
    }

    // ---- billing -------------------------------------------------------------------------------

    /** Bills one sale. Must be called outside a transaction (the caller is the controller). */
    public CodeCheckoutDtos.Billed bill(UUID merchantId, String idempotencyKey, CodeCheckoutDtos.CodeSaleRequest request) {
        Sale sale = validated(request);
        Map<String, Object> canonical = new LinkedHashMap<>();
        canonical.put("amountRwf", sale.amount());
        canonical.put("description", sale.description());
        canonical.put("collectionCodeId", sale.codeId());
        canonical.put("branchId", sale.branchId());
        canonical.put("clientRequestId", sale.clientRequestId());
        String fingerprint = idempotency.fingerprintOf("CODE_SALE", Map.of("merchantId", merchantId), canonical);
        return idempotency.executeOnce(merchantId, SCOPE, idempotencyKey, fingerprint, () -> create(merchantId, sale),
                stored -> replay(merchantId, stored)).response();
    }

    private IdempotencyService.Created<CodeCheckoutDtos.Billed> create(UUID merchantId, Sale sale) {
        Actor actor = access.require(merchantId, Permission.INVOICES_CREATE);

        // 1. Is this a repeat of a sale that already exists? Answered from ITS OWN record, whatever the agent holds today.
        Optional<Stored> existing = storedByClientRequest(merchantId, sale.clientRequestId());
        if (existing.isPresent()) {
            return new IdempotencyService.Created<>(new CodeCheckoutDtos.Billed(repeatOf(merchantId, actor, existing.get(), sale), false),
                    "invoice", existing.get().invoiceId());
        }

        // 2. A new sale: only through a code the caller holds NOW and that may be used.
        CollectionCodeService.HeldCode held = choose(merchantId, sale.codeId());
        String mode = modeOf(held);
        if ("UNAVAILABLE".equals(mode)) {
            throw refusal(held);
        }
        CollectionCode code = held.code();
        CollectionCodeAssignment assignment = held.assignment();
        UUID branchId = branchFor(merchantId, actor, held, sale.branchId());

        InvoiceDtos.DraftRequest draft = new InvoiceDtos.DraftRequest(branchId, actor.userId(),
                new InvoiceDtos.Customer("Walk-in customer", null, null, null, null),
                List.of(new InvoiceDtos.ItemInput(sale.description(), BigDecimal.ONE, sale.amount(), 0,
                        new InvoiceDtos.TaxRate(InvoiceCalculator.TaxCategory.NOT_APPLICABLE, 0))),
                InvoiceCalculator.TaxMode.EXCLUSIVE, LocalDate.now(clock.withZone(KIGALI)).toString(),
                // Part of what makes two requests the same sale (R3's fingerprint): the same identifier through another code is a conflict.
                "Collection code " + code.getInternalRef());
        InvoiceService.DraftOutcome drafted = invoices.createDraftFor(merchantId, draft, new InvoiceCreation(SaleChannel.CODE, sale.clientRequestId(), "DEMONSTRATION".equals(mode)));
        if (!drafted.created()) {
            // Lost a race with an identical request: its sale is committed (we waited for it), so this is a repeat.
            Stored other = storedByInvoice(merchantId, drafted.invoice().id()).orElseThrow(() -> ApiException.conflict("client_request_id_reuse",
                    "This request identifier was already used for a different sale."));
            return new IdempotencyService.Created<>(new CodeCheckoutDtos.Billed(repeatOf(merchantId, actor, other, sale), false), "invoice", other.invoiceId());
        }
        InvoiceDtos.InvoiceDto invoice = drafted.invoice();
        if (invoice.status() == InvoiceStatus.DRAFT) {
            invoice = invoices.issue(merchantId, invoice.id(), invoice.version());
        }
        PaymentDtos.RequestDto request = payments.createCodeSaleRequest(merchantId, invoice.id(),
                PaymentRequestOptions.ofLifetime(SimplifiedCheckoutService.PAYMENT_LIFETIME), code.getSettlementDestinationId());
        PaymentDestination account = destinations.findByIdAndMerchantId(code.getSettlementDestinationId(), merchantId).orElseThrow();
        Instant now = clock.instant().truncatedTo(ChronoUnit.MICROS);
        jdbc.sql("insert into code_sales (payment_request_id, merchant_id, invoice_id, branch_id, sale_reference, amount_rwf, description, presentation_mode, "
                        + "agent_user_id, agent_name, collection_code_id, assignment_id, code_provider_id, code_internal_ref, code_label, code_external_code, "
                        + "code_status, code_is_simulated, settlement_destination_id, settlement_masked_account, assignment_kind, assignee_membership_id, "
                        + "assignee_name, assignee_role, assignment_valid_from, branch_name, branch_code, created_at) "
                        + "values (:id, :m, :inv, :b, :ref, :amt, :desc, :mode, :agent, :agentName, :code, :asg, :prov, :iref, :label, :ext, :cst, :sim, :dest, "
                        + ":masked, :kind, :mem, :aname, :arole, :from, :bname, :bcode, :now)")
                .param("id", request.id()).param("m", merchantId).param("inv", invoice.id()).param("b", branchId).param("ref", request.publicReference())
                .param("amt", sale.amount()).param("desc", sale.description()).param("mode", mode).param("agent", actor.userId())
                .param("agentName", actor.user().getFullName()).param("code", code.getId()).param("asg", assignment.getId())
                .param("prov", code.getProviderId().name()).param("iref", code.getInternalRef()).param("label", code.getDisplayLabel())
                .param("ext", "LIVE".equals(mode) ? code.getExternalCode() : null).param("cst", code.getStatus().name()).param("sim", code.isSimulated())
                .param("dest", code.getSettlementDestinationId()).param("masked", account.getMaskedAccount()).param("kind", assignment.getAssigneeKind().name())
                .param("mem", assignment.getMembershipId()).param("aname", assignment.getAssigneeName()).param("arole", assignment.getAssigneeRole())
                .param("from", Timestamp.from(assignment.getValidFrom())).param("bname", invoice.branchSnapshot().name())
                .param("bcode", invoice.branchSnapshot().code()).param("now", Timestamp.from(now)).update();
        audit.record(merchantId, actor.userId(), "CODE_SALE_BILLED", "invoice", invoice.id(),
                "Code sale " + invoice.invoiceNumber() + " billed for RWF " + sale.amount() + " (" + mode + ", code " + code.getInternalRef() + ").");
        Stored stored = storedByInvoice(merchantId, invoice.id()).orElseThrow();
        return new IdempotencyService.Created<>(new CodeCheckoutDtos.Billed(toDto(merchantId, stored), true), "invoice", invoice.id());
    }

    /** Rebuilds the answer for a stored result from CURRENT payment state, re-checking who is asking. */
    private CodeCheckoutDtos.Billed replay(UUID merchantId, IdempotencyService.StoredResult stored) {
        access.require(merchantId, Permission.INVOICES_CREATE);
        Stored sale = storedByInvoice(merchantId, stored.entityId()).orElseThrow(() -> ApiException.notFound("This sale could not be found."));
        invoices.get(merchantId, sale.invoiceId()); // the same visibility rules as any invoice: a cashier sees only their own
        return new CodeCheckoutDtos.Billed(toDto(merchantId, sale), false);
    }

    /** One sale, for the agent who made it (or whoever may see its invoice): safe recovery after a refresh. */
    @Transactional(readOnly = true)
    public CodeCheckoutDtos.CodeSaleDto get(UUID merchantId, UUID saleId) {
        access.require(merchantId, Permission.INVOICES_VIEW);
        Stored sale = jdbc.sql(STORED_SELECT + " where cs.payment_request_id = :id and cs.merchant_id = :m").param("id", saleId).param("m", merchantId)
                .query(STORED_MAPPER).optional().orElseThrow(() -> ApiException.notFound("This sale could not be found."));
        invoices.get(merchantId, sale.invoiceId());
        return toDto(merchantId, sale);
    }

    // ---- rules ---------------------------------------------------------------------------------

    private CollectionCodeService.HeldCode choose(UUID merchantId, UUID requested) {
        List<CollectionCodeService.HeldCode> held = codes.heldByMe(merchantId);
        if (held.isEmpty()) {
            throw ApiException.invalidState("no_assigned_code", "You are not assigned a collection code. Ask the business owner or a manager to assign you one.");
        }
        if (requested != null) {
            return held.stream().filter(h -> h.code().getId().equals(requested)).findFirst()
                    .orElseThrow(() -> new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "code_not_assigned", "Choose one of the codes assigned to you."));
        }
        if (held.size() > 1) {
            throw new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "code_required", "Choose which of your codes you are billing through.");
        }
        return held.get(0);
    }

    /** LIVE, DEMONSTRATION or UNAVAILABLE, from the registry's own live eligibility. Nothing a client sends takes part. */
    private String modeOf(CollectionCodeService.HeldCode held) {
        if (held.issues().isEmpty()) {
            return liveEnabled ? "LIVE" : "UNAVAILABLE";
        }
        boolean demonstrable = held.code().isSimulated() && DEMO_STATUSES.contains(held.code().getStatus())
                && held.issues().stream().allMatch(DEMO_ALLOWED_ISSUES::contains);
        return demonstrable ? "DEMONSTRATION" : "UNAVAILABLE";
    }

    private String reasonOf(CollectionCodeService.HeldCode held) {
        if (held.issues().isEmpty()) {
            return "Live collection with bank codes is not available yet: OuPay has no confirmed Equity capability to rely on.";
        }
        List<String> blocking = held.issues().stream().filter(i -> !(held.code().isSimulated() && DEMO_ALLOWED_ISSUES.contains(i))).toList();
        if (!blocking.isEmpty()) {
            return switch (blocking.get(0)) {
                case "SETTLEMENT_ACCOUNT_NOT_CONNECTED" -> "The settlement account of this code is not connected.";
                case "BRANCH_INACTIVE" -> "The branch of this code is not active.";
                case "ASSIGNEE_NOT_ACTIVE" -> "Your membership is not active.";
                case "ASSIGNEE_NOT_AT_BRANCH" -> "You are no longer assigned to the branch of this code.";
                default -> "This code cannot be used right now.";
            };
        }
        if (held.code().isSimulated()) {
            return "This simulated code is " + held.code().getStatus().name().toLowerCase(java.util.Locale.ROOT) + " and cannot be used.";
        }
        return "This code has not been approved by the bank, so it cannot be used to collect.";
    }

    private ApiException refusal(CollectionCodeService.HeldCode held) {
        String code = held.issues().isEmpty() ? "live_collection_unavailable" : "code_not_available";
        return ApiException.invalidState(code, reasonOf(held));
    }

    private UUID branchFor(UUID merchantId, Actor actor, CollectionCodeService.HeldCode held, UUID requested) {
        UUID fixed = held.assignment().getBranchId() != null ? held.assignment().getBranchId() : held.code().getBranchId();
        if (fixed != null) {
            if (requested != null && !requested.equals(fixed)) {
                throw new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "branch_not_eligible", "This code belongs to a different branch.");
            }
            return fixed;
        }
        InvoiceDtos.FormOptions form = invoices.formOptions(merchantId);
        Set<UUID> mine = form.assignees().stream().filter(a -> a.userId().equals(actor.userId())).flatMap(a -> a.branchIds().stream()).collect(Collectors.toSet());
        List<UUID> eligible = form.branches().stream().map(InvoiceDtos.BranchOption::id).filter(mine::contains).toList();
        if (requested != null) {
            if (!eligible.contains(requested)) {
                throw new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "branch_not_eligible", "Choose one of the branches you are assigned to.");
            }
            return requested;
        }
        if (eligible.isEmpty()) {
            throw ApiException.invalidState("no_eligible_branch", "You are not assigned to an active branch, so you cannot bill yet.");
        }
        if (eligible.size() > 1) {
            throw new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "branch_required", "Choose the branch you are billing for.");
        }
        return eligible.get(0);
    }

    /** A repeat is the same sale only for the same agent, amount, note and (if named) code and branch; anything else is a conflict. */
    private CodeCheckoutDtos.CodeSaleDto repeatOf(UUID merchantId, Actor actor, Stored stored, Sale sale) {
        boolean same = stored.agentUserId().equals(actor.userId()) && stored.amount() == sale.amount() && stored.description().equals(sale.description())
                && (sale.codeId() == null || sale.codeId().equals(stored.codeId())) && (sale.branchId() == null || sale.branchId().equals(stored.branchId()));
        if (!same) {
            throw ApiException.conflict("client_request_id_reuse", "This request identifier was already used for a different sale.");
        }
        invoices.get(merchantId, stored.invoiceId());
        return toDto(merchantId, stored);
    }

    private static Sale validated(CodeCheckoutDtos.CodeSaleRequest request) {
        BigDecimal amount = request.amountRwf();
        if (amount == null || amount.compareTo(BigDecimal.valueOf(SimplifiedCheckoutService.MIN_AMOUNT_RWF)) < 0
                || amount.compareTo(BigDecimal.valueOf(SimplifiedCheckoutService.MAX_AMOUNT_RWF)) > 0 || amount.stripTrailingZeros().scale() > 0) {
            throw ApiException.validation("Enter a whole amount between RWF " + SimplifiedCheckoutService.MIN_AMOUNT_RWF + " and RWF "
                    + SimplifiedCheckoutService.MAX_AMOUNT_RWF + ".");
        }
        String description = request.description() == null ? "" : request.description().trim();
        if (description.length() > SimplifiedCheckoutService.MAX_DESCRIPTION || description.chars().anyMatch(Character::isISOControl)) {
            throw ApiException.validation("The description can be at most " + SimplifiedCheckoutService.MAX_DESCRIPTION + " characters, on one line.");
        }
        return new Sale(amount.longValueExact(), description.isEmpty() ? DEFAULT_DESCRIPTION : description, request.collectionCodeId(), request.branchId(),
                request.clientRequestId());
    }

    // ---- reading a sale ------------------------------------------------------------------------

    private static final String STORED_SELECT = "select cs.payment_request_id, cs.invoice_id, cs.branch_id, cs.sale_reference, cs.amount_rwf, cs.description, "
            + "cs.presentation_mode, cs.agent_user_id, cs.agent_name, cs.collection_code_id, cs.code_label, cs.code_internal_ref, cs.code_external_code, "
            + "cs.branch_name, cs.created_at from code_sales cs";

    private static final org.springframework.jdbc.core.RowMapper<Stored> STORED_MAPPER = (rs, row) -> new Stored(rs.getObject(1, UUID.class),
            rs.getObject(2, UUID.class), rs.getObject(3, UUID.class), rs.getString(4), rs.getLong(5), rs.getString(6), rs.getString(7),
            rs.getObject(8, UUID.class), rs.getString(9), rs.getObject(10, UUID.class), rs.getString(11), rs.getString(12), rs.getString(13),
            rs.getString(14), rs.getTimestamp(15).toInstant());

    private Optional<Stored> storedByClientRequest(UUID merchantId, UUID clientRequestId) {
        return jdbc.sql(STORED_SELECT + " join invoices i on i.id = cs.invoice_id and i.merchant_id = cs.merchant_id "
                        + "where i.merchant_id = :m and i.client_request_id = :c")
                .param("m", merchantId).param("c", clientRequestId).query(STORED_MAPPER).optional();
    }

    private Optional<Stored> storedByInvoice(UUID merchantId, UUID invoiceId) {
        return jdbc.sql(STORED_SELECT + " where cs.invoice_id = :i and cs.merchant_id = :m").param("i", invoiceId).param("m", merchantId)
                .query(STORED_MAPPER).optional();
    }

    /** The sale as it was made, with its payment state as it is NOW (derived from verified bank transactions and allocations). */
    private CodeCheckoutDtos.CodeSaleDto toDto(UUID merchantId, Stored s) {
        PaymentRequest request = requests.findByIdAndMerchantId(s.saleId(), merchantId).orElseThrow();
        var resolved = resolver.resolve(request);
        var state = effectiveState(s.mode(), resolved.state(), s.amount());
        String merchantName = merchants.findById(merchantId).map(m -> m.displayName()).orElse("Business");
        return new CodeCheckoutDtos.CodeSaleDto(s.saleId(), s.invoiceId(), resolved.invoiceNumber(), s.reference(), s.amount(), "RWF", s.description(),
                state.status(), state.stage(), state.confirmedAmount(), state.amountDue(), request.getExpiresAt(),
                request.getCreatedAt(), merchantName, s.branchName(), s.agentName(), presentation(s.mode(), s.codeLabel(), s.externalCode(), s.internalRef()));
    }

    /**
     * What a sale SHOWS. A LIVE sale shows what the ledger derived. A DEMONSTRATION sale is not payable: it never shows money, a partial
     * payment or "paid", whatever the bank reported, so a demo can never look settled. It can still be seen as expired or cancelled.
     * (The ledger itself refuses to apply bank money to it, see {@code CodeSaleAllocationPolicy} and V13.)
     */
    static PaymentRequestState.State effectiveState(String mode, PaymentRequestState.State derived, long amount) {
        if ("LIVE".equals(mode)) {
            return liveState(derived, amount);
        }
        boolean closed = derived.status() == PaymentRequestState.Status.EXPIRED || derived.status() == PaymentRequestState.Status.CANCELLED;
        return closed ? new PaymentRequestState.State(derived.status(), derived.stage(), 0, amount)
                : new PaymentRequestState.State(PaymentRequestState.Status.AWAITING_PAYMENT, PaymentRequestState.Stage.AWAITING_PAYMENT, 0, amount);
    }

    /**
     * A LIVE sale counts only money that was APPLIED to it. The generic request state counts any confirmed money that carries the
     * reference, which for an ordinary invoice is applied a moment later by the same transaction; a code sale is not matched
     * automatically (until R6d), so confirmed money naming it is unmatched, never "partly paid" or "paid".
     */
    private static PaymentRequestState.State liveState(PaymentRequestState.State derived, long amount) {
        if (derived.status() == PaymentRequestState.Status.CANCELLED) {
            return derived;
        }
        long applied = Math.max(0, amount - derived.amountDue());
        if (applied >= amount) {
            return new PaymentRequestState.State(PaymentRequestState.Status.SETTLED, PaymentRequestState.Stage.CONFIRMED_AND_RECONCILED, applied, 0);
        }
        if (applied > 0) {
            return new PaymentRequestState.State(PaymentRequestState.Status.PARTIALLY_SETTLED, PaymentRequestState.Stage.PARTIALLY_SETTLED, applied,
                    amount - applied);
        }
        if (derived.confirmedAmount() > 0) {
            return new PaymentRequestState.State(PaymentRequestState.Status.AWAITING_PAYMENT, PaymentRequestState.Stage.CONFIRMED_UNMATCHED, 0, amount);
        }
        return derived;
    }

    static CodeCheckoutDtos.CodePresentation presentation(String mode, String label, String externalCode, String internalRef) {
        return "LIVE".equals(mode)
                ? new CodeCheckoutDtos.CodePresentation("LIVE", label, externalCode, null, null)
                : new CodeCheckoutDtos.CodePresentation("DEMONSTRATION", label, null, internalRef, DEMO_NOTICE);
    }
}
