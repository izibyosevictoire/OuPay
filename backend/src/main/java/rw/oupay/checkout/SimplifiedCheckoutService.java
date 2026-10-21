package rw.oupay.checkout;

import java.math.BigDecimal;
import java.time.Clock;
import java.time.Duration;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
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
import rw.oupay.membership.Role;
import rw.oupay.merchant.MerchantRepository;
import rw.oupay.merchant.MerchantSettingsService;
import rw.oupay.merchant.OperatingMode;
import rw.oupay.payment.PaymentDtos;
import rw.oupay.payment.PaymentProfileService;
import rw.oupay.payment.PaymentRequestOptions;

/**
 * Amount-only billing for a business in SIMPLIFIED mode: one invoice with one line, issued, and a fixed-amount payment request
 * for it, as ONE atomic operation. It composes the existing invoice and payment-request services; it has no billing logic of
 * its own.
 *
 * <h2>Transactions</h2>
 * This class is deliberately NOT transactional. {@link IdempotencyService#executeOnce} owns the transaction (it refuses to run
 * inside one), and everything the sale needs happens inside it: the idempotency claim, the invoice with its durable client
 * request identity, the issue, the payment request and the audit entries. A failure anywhere (no payment link, no connected
 * destination, an ineligible branch) rolls ALL of it back, including the claim, so nothing is left behind and the same request
 * can be retried after the problem is fixed. There is no external side effect inside the transaction.
 *
 * <h2>Two layers of idempotency</h2>
 * <ul>
 *   <li>The HTTP {@code Idempotency-Key} (R2) replays the response of an identical request for 30 days.</li>
 *   <li>The invoice's durable {@code client_request_id} with its server-computed fingerprint (R3) is the permanent guard: the
 *       same id with the same sale returns the existing invoice, with another sale it is a 409. It works after the HTTP
 *       records are pruned.</li>
 * </ul>
 */
@Service
public class SimplifiedCheckoutService {

    public static final long MIN_AMOUNT_RWF = 100;
    public static final long MAX_AMOUNT_RWF = 10_000_000;
    /** How long a simplified payment request stays open. Server policy; nothing a client sends can change it. */
    public static final Duration PAYMENT_LIFETIME = Duration.ofMinutes(30);
    public static final String DEFAULT_DESCRIPTION = "Payment";
    static final String WALK_IN_CUSTOMER = "Walk-in customer";
    static final int MAX_DESCRIPTION = 120;
    private static final String SCOPE = "SIMPLE_CHECKOUT";
    private static final ZoneId KIGALI = ZoneId.of("Africa/Kigali");

    /** The response, and whether this call created the sale (false: it already existed). */
    public record Billed(CheckoutDtos.SimpleCheckoutResult result, boolean created) {}

    /** A request whose amount and description the server has checked and normalised. */
    private record Sale(long amount, String description, UUID branchId, UUID clientRequestId) {
        Map<String, Object> canonical() {
            Map<String, Object> body = new LinkedHashMap<>();
            body.put("amountRwf", amount);
            body.put("description", description);
            body.put("branchId", branchId);
            body.put("clientRequestId", clientRequestId);
            return body;
        }
    }

    private record Eligible(UUID branchId, String name, String code, boolean paymentReady) {}

    private final IdempotencyService idempotency;
    private final InvoiceService invoices;
    private final PaymentProfileService payments;
    private final MerchantSettingsService settings;
    private final MerchantRepository merchants;
    private final MerchantAccess access;
    private final AuditService audit;
    private final Clock clock;

    public SimplifiedCheckoutService(IdempotencyService idempotency, InvoiceService invoices, PaymentProfileService payments,
                                     MerchantSettingsService settings, MerchantRepository merchants, MerchantAccess access,
                                     AuditService audit, Clock clock) {
        this.idempotency = idempotency;
        this.invoices = invoices;
        this.payments = payments;
        this.settings = settings;
        this.merchants = merchants;
        this.access = access;
        this.audit = audit;
        this.clock = clock;
    }

    // ---- options -------------------------------------------------------------------------------

    /** What the page needs before it shows the form. A business that is not SIMPLIFIED is told so (200), not hidden. */
    @Transactional(readOnly = true)
    public CheckoutDtos.SimpleCheckoutOptions options(UUID merchantId) {
        Actor actor = access.require(merchantId, Permission.INVOICES_CREATE);
        OperatingMode mode = settings.operatingModeOf(merchantId);
        List<Eligible> eligible = mode == OperatingMode.SIMPLIFIED ? eligibleBranches(merchantId, actor) : List.of();
        CheckoutDtos.Readiness readiness;
        if (mode != OperatingMode.SIMPLIFIED) {
            readiness = CheckoutDtos.Readiness.NOT_SIMPLIFIED;
        } else if (eligible.isEmpty()) {
            readiness = CheckoutDtos.Readiness.NO_BRANCH;
        } else if (eligible.stream().noneMatch(Eligible::paymentReady)) {
            readiness = CheckoutDtos.Readiness.NO_PAYMENT_LINK;
        } else {
            readiness = CheckoutDtos.Readiness.READY;
        }
        return new CheckoutDtos.SimpleCheckoutOptions(mode, readiness,
                eligible.stream().map(e -> new CheckoutDtos.BranchChoice(e.branchId(), e.name(), e.code(), e.paymentReady())).toList(),
                MIN_AMOUNT_RWF, MAX_AMOUNT_RWF, (int) PAYMENT_LIFETIME.toMinutes(), DEFAULT_DESCRIPTION);
    }

    // ---- billing -------------------------------------------------------------------------------

    /**
     * Bills one sale. Must be called outside a transaction (the caller is the controller).
     *
     * @param idempotencyKey the client's {@code Idempotency-Key}; a retry with the same key and the same sale replays the result
     */
    public Billed bill(UUID merchantId, String idempotencyKey, CheckoutDtos.SimpleCheckoutRequest request) {
        Sale sale = validated(request);
        String fingerprint = idempotency.fingerprintOf("SIMPLE_CHECKOUT", Map.of("merchantId", merchantId), sale.canonical());
        return idempotency.executeOnce(merchantId, SCOPE, idempotencyKey, fingerprint,
                () -> create(merchantId, sale), stored -> replay(merchantId, stored)).response();
    }

    private IdempotencyService.Created<Billed> create(UUID merchantId, Sale sale) {
        Actor actor = access.require(merchantId, Permission.INVOICES_CREATE);
        if (settings.operatingModeOf(merchantId) != OperatingMode.SIMPLIFIED) {
            throw ApiException.invalidState("checkout_not_available",
                    "Simplified checkout is only available to businesses in simplified mode.");
        }
        Eligible branch = chooseBranch(merchantId, actor, sale.branchId());

        // The assignee is always the person billing: a cashier may only act for themselves, and for everyone else it keeps the
        // sale attributed to whoever collected it. The existing invoice rules re-check the assignment and the branch.
        InvoiceDtos.DraftRequest draft = new InvoiceDtos.DraftRequest(branch.branchId(), actor.userId(),
                new InvoiceDtos.Customer(WALK_IN_CUSTOMER, null, null, null, null),
                List.of(new InvoiceDtos.ItemInput(sale.description(), BigDecimal.ONE, sale.amount(), 0,
                        new InvoiceDtos.TaxRate(InvoiceCalculator.TaxCategory.NOT_APPLICABLE, 0))),
                InvoiceCalculator.TaxMode.EXCLUSIVE, LocalDate.now(clock.withZone(KIGALI)).toString(), null);
        InvoiceService.DraftOutcome drafted = invoices.createDraftFor(merchantId, draft,
                new InvoiceCreation(SaleChannel.SIMPLIFIED, sale.clientRequestId()));

        InvoiceDtos.InvoiceDto invoice = drafted.invoice();
        if (invoice.status() == InvoiceStatus.DRAFT) {
            invoice = invoices.issue(merchantId, invoice.id(), invoice.version());
        }
        PaymentDtos.RequestDto request = requestFor(merchantId, invoice);
        if (drafted.created()) {
            audit.record(merchantId, actor.userId(), "SIMPLE_CHECKOUT_BILLED", "invoice", invoice.id(),
                    "Simplified checkout billed RWF " + sale.amount() + " (" + invoice.invoiceNumber() + ").");
        }
        return new IdempotencyService.Created<>(new Billed(result(merchantId, invoice, request), drafted.created()),
                "invoice", invoice.id());
    }

    /** Rebuilds the answer for a stored result from CURRENT data, re-checking who is asking. */
    private Billed replay(UUID merchantId, IdempotencyService.StoredResult stored) {
        access.require(merchantId, Permission.INVOICES_CREATE);
        InvoiceDtos.InvoiceDto invoice = invoices.get(merchantId, stored.entityId());
        List<PaymentDtos.RequestDto> requests = payments.listInvoiceRequests(merchantId, invoice.id());
        if (requests.isEmpty()) {
            throw ApiException.notFound("This payment could not be found.");
        }
        return new Billed(result(merchantId, invoice, requests.get(0)), false);
    }

    /**
     * The invoice's payment request. A new sale gets a new request with the checkout lifetime; an invoice that already has one
     * (a repeat of the same sale) returns its newest request as it is now, whatever state it is in, so a retry never changes
     * a lifetime, replaces a request or hides a payment that has already arrived.
     */
    private PaymentDtos.RequestDto requestFor(UUID merchantId, InvoiceDtos.InvoiceDto invoice) {
        List<PaymentDtos.RequestDto> existing = payments.listInvoiceRequests(merchantId, invoice.id());
        if (!existing.isEmpty()) {
            return existing.get(0);
        }
        return payments.createInvoiceRequest(merchantId, invoice.id(), PaymentRequestOptions.ofLifetime(PAYMENT_LIFETIME));
    }

    // ---- branch and amount rules ---------------------------------------------------------------

    /**
     * The branches this person may bill at: active branches they are actively assigned to, exactly the rule the invoice service
     * applies. Nothing is created or assigned here.
     */
    private List<Eligible> eligibleBranches(UUID merchantId, Actor actor) {
        InvoiceDtos.FormOptions form = invoices.formOptions(merchantId);
        Set<UUID> assignedToMe = form.assignees().stream().filter(a -> a.userId().equals(actor.userId()))
                .flatMap(a -> a.branchIds().stream()).collect(Collectors.toSet());
        return form.branches().stream().filter(b -> assignedToMe.contains(b.id()))
                .map(b -> new Eligible(b.id(), b.name(), b.code(), payments.canCollectFor(merchantId, b.id(), actor.userId())))
                .toList();
    }

    private Eligible chooseBranch(UUID merchantId, Actor actor, UUID requested) {
        List<Eligible> eligible = eligibleBranches(merchantId, actor);
        if (eligible.isEmpty()) {
            throw ApiException.invalidState("no_eligible_branch", actor.role() == Role.CASHIER
                    ? "You are not assigned to an active branch yet. Ask your manager to assign you to one."
                    : "You are not assigned to an active branch. Create a branch, or assign yourself to one, before collecting payments.");
        }
        if (requested != null) {
            return eligible.stream().filter(e -> e.branchId().equals(requested)).findFirst()
                    .orElseThrow(() -> new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "branch_not_eligible",
                            "Choose one of the branches you are assigned to."));
        }
        if (eligible.size() > 1) {
            throw new ApiException(HttpStatus.UNPROCESSABLE_CONTENT, "branch_required", "Choose the branch you are billing for.");
        }
        return eligible.get(0);
    }

    private static Sale validated(CheckoutDtos.SimpleCheckoutRequest request) {
        BigDecimal amount = request.amountRwf();
        if (amount == null || amount.compareTo(BigDecimal.valueOf(MIN_AMOUNT_RWF)) < 0
                || amount.compareTo(BigDecimal.valueOf(MAX_AMOUNT_RWF)) > 0 || amount.stripTrailingZeros().scale() > 0) {
            throw ApiException.validation("Enter a whole amount between RWF " + MIN_AMOUNT_RWF + " and RWF " + MAX_AMOUNT_RWF + ".");
        }
        String description = request.description() == null ? "" : request.description().trim();
        if (description.length() > MAX_DESCRIPTION || description.chars().anyMatch(Character::isISOControl)) {
            throw ApiException.validation("The description can be at most " + MAX_DESCRIPTION + " characters, on one line.");
        }
        return new Sale(amount.longValueExact(), description.isEmpty() ? DEFAULT_DESCRIPTION : description,
                request.branchId(), request.clientRequestId());
    }

    private CheckoutDtos.SimpleCheckoutResult result(UUID merchantId, InvoiceDtos.InvoiceDto invoice, PaymentDtos.RequestDto request) {
        String merchantName = merchants.findById(merchantId).map(m -> m.displayName()).orElse("Business");
        return new CheckoutDtos.SimpleCheckoutResult(invoice.id(), invoice.invoiceNumber(), request.id(), request.publicReference(),
                request.requestedAmount(), request.currency(), invoice.items().get(0).description(), request.status(),
                request.expiresAt(), request.createdAt(), merchantName, invoice.branchId(), invoice.branchSnapshot().name(),
                request.profileToken(), "/p/" + request.profileToken() + "/r/" + request.publicReference());
    }
}
