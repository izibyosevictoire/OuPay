package rw.oupay.payment;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.stream.Collectors;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;
import rw.oupay.banking.BankConnection;
import rw.oupay.banking.BankConnectionRepository;
import rw.oupay.banking.BankingDtos;
import rw.oupay.banking.PaymentDestination;
import rw.oupay.banking.PaymentDestinationRepository;
import rw.oupay.branch.Branch;
import rw.oupay.branch.BranchAssignmentRepository;
import rw.oupay.branch.BranchRepository;
import rw.oupay.common.ApiException;
import rw.oupay.common.SecureTokens;
import rw.oupay.invoice.Invoice;
import rw.oupay.invoice.InvoiceRepository;
import rw.oupay.invoice.InvoiceStatus;
import rw.oupay.ledger.InvoiceBalanceReader;
import rw.oupay.ledger.LedgerMath;
import rw.oupay.membership.Actor;
import rw.oupay.membership.Membership;
import rw.oupay.membership.MembershipRepository;
import rw.oupay.membership.MerchantAccess;
import rw.oupay.membership.Permission;
import rw.oupay.membership.Role;
import rw.oupay.merchant.MerchantRepository;
import rw.oupay.user.User;
import rw.oupay.user.UserRepository;
import rw.oupay.user.UserStatus;

/**
 * Merchant-side management of public payment profiles (what QR codes and NFC tags point at) and of
 * invoice payment requests. Public customer pages use {@link PublicPaymentService} instead.
 */
@Service
public class PaymentProfileService {

    private static final int TOKEN_LENGTH = 12;

    private final PaymentProfileRepository profiles;
    private final PaymentRequestRepository requests;
    private final PaymentDestinationRepository destinations;
    private final BankConnectionRepository connections;
    private final BranchRepository branches;
    private final BranchAssignmentRepository assignments;
    private final MembershipRepository memberships;
    private final UserRepository users;
    private final MerchantRepository merchants;
    private final InvoiceRepository invoices;
    private final InvoiceBalanceReader balances;
    private final PaymentRequestResolver resolver;
    private final MerchantAccess access;
    private final AuditService audit;
    private final Clock clock;

    public PaymentProfileService(PaymentProfileRepository profiles, PaymentRequestRepository requests, PaymentDestinationRepository destinations,
                                 BankConnectionRepository connections, BranchRepository branches, BranchAssignmentRepository assignments,
                                 MembershipRepository memberships, UserRepository users, MerchantRepository merchants,
                                 InvoiceRepository invoices, InvoiceBalanceReader balances, PaymentRequestResolver resolver,
                                 MerchantAccess access, AuditService audit, Clock clock) {
        this.profiles = profiles;
        this.requests = requests;
        this.destinations = destinations;
        this.connections = connections;
        this.branches = branches;
        this.assignments = assignments;
        this.memberships = memberships;
        this.users = users;
        this.merchants = merchants;
        this.invoices = invoices;
        this.balances = balances;
        this.resolver = resolver;
        this.access = access;
        this.audit = audit;
        this.clock = clock;
    }

    // ---- profiles ------------------------------------------------------------------------------

    /** Cashiers see only profiles assigned to them. */
    @Transactional(readOnly = true)
    public List<PaymentDtos.ProfileDto> list(UUID merchantId) {
        Actor actor = access.require(merchantId, Permission.PAYMENT_PROFILES_VIEW);
        return profiles.findByMerchantIdOrderByCreatedAtDesc(merchantId).stream()
                .filter(p -> actor.hasFullScope(Permission.PAYMENT_PROFILES_VIEW) || actor.userId().equals(p.getAssignedCashierUserId()))
                .map(this::toDto).toList();
    }

    @Transactional(readOnly = true)
    public PaymentDtos.ProfileDto get(UUID merchantId, UUID profileId) {
        Actor actor = access.require(merchantId, Permission.PAYMENT_PROFILES_VIEW);
        PaymentProfile profile = find(merchantId, profileId);
        // A cashier asking for someone else's link gets the same answer as for a missing one.
        if (!actor.hasFullScope(Permission.PAYMENT_PROFILES_VIEW) && !actor.userId().equals(profile.getAssignedCashierUserId())) {
            throw notFound();
        }
        return toDto(profile);
    }

    @Transactional(readOnly = true)
    public PaymentDtos.FormOptions formOptions(UUID merchantId) {
        access.require(merchantId, Permission.PAYMENT_PROFILES_MANAGE);
        var live = destinations.findByMerchantIdOrderByCreatedAtAsc(merchantId).stream()
                .filter(d -> connections.findById(d.getBankConnectionId()).filter(c -> c.getStatus() == BankConnection.Status.CONNECTED).isPresent())
                .map(BankingDtos.DestinationDto::of).toList();
        var activeBranches = branches.findByMerchantIdOrderByNameAsc(merchantId).stream().filter(Branch::isActive)
                .map(b -> new PaymentDtos.BranchOption(b.getId(), b.getName())).toList();
        return new PaymentDtos.FormOptions(live, activeBranches, cashiers(merchantId));
    }

    @Transactional
    public PaymentDtos.ProfileDto create(UUID merchantId, PaymentDtos.CreateProfileRequest request) {
        Actor actor = access.require(merchantId, Permission.PAYMENT_PROFILES_MANAGE);
        PaymentDestination destination = destinations.findByIdAndMerchantId(request.paymentDestinationId(), merchantId)
                .filter(d -> connections.findById(d.getBankConnectionId()).filter(c -> c.getStatus() == BankConnection.Status.CONNECTED).isPresent())
                .orElseThrow(() -> ApiException.validation("Choose a payment destination with a connected bank link."));
        if (request.branchId() != null) {
            branches.findByIdAndMerchantId(request.branchId(), merchantId).filter(Branch::isActive)
                    .orElseThrow(() -> ApiException.validation("Choose an active branch of this business."));
        }
        if (request.assignedCashierId() != null) {
            var cashier = cashiers(merchantId).stream().filter(c -> c.userId().equals(request.assignedCashierId())).findFirst()
                    .orElseThrow(() -> ApiException.validation("Choose an active cashier of this business."));
            if (request.branchId() != null && !cashier.branchIds().contains(request.branchId())) {
                throw ApiException.validation("That cashier is not assigned to the chosen branch.");
            }
        }
        for (int attempt = 0; attempt < 5; attempt++) {
            try {
                PaymentProfile profile = new PaymentProfile(UUID.randomUUID(), merchantId, SecureTokens.publicToken(TOKEN_LENGTH),
                        request.label().trim(), request.branchId(), request.assignedCashierId(), destination.getId(), clock.instant());
                profiles.saveAndFlush(profile);
                audit.record(merchantId, actor.userId(), "PAYMENT_LINK_CREATED", "payment_profile", profile.getId(), "Payment link created.");
                return toDto(profile);
            } catch (DataIntegrityViolationException tokenCollision) {
                // 62^12 makes a collision astronomically unlikely; the unique index would still catch it.
            }
        }
        throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "service_unavailable", "A link could not be created. Please try again.");
    }

    /** Switches a link on or off. A revoked link can never be switched back on. */
    @Transactional
    public PaymentDtos.ProfileDto setActive(UUID merchantId, UUID profileId, boolean active) {
        Actor actor = access.require(merchantId, Permission.PAYMENT_PROFILES_MANAGE);
        PaymentProfile profile = find(merchantId, profileId);
        if (profile.getStatus() == PaymentProfile.Status.REVOKED) {
            throw ApiException.invalidState("invalid_state", "A replaced link can never be switched back on. Reissue a new one instead.");
        }
        profile.changeStatus(active ? PaymentProfile.Status.ACTIVE : PaymentProfile.Status.INACTIVE, clock.instant());
        audit.record(merchantId, actor.userId(), "PAYMENT_LINK_TOGGLED", "payment_profile", profileId, "Payment link " + (active ? "switched on." : "switched off."));
        return toDto(profile);
    }

    /** Replaces an exposed link: the old token is revoked for good and a new profile with a new token takes its place. */
    @Transactional
    public PaymentDtos.ProfileDto reissue(UUID merchantId, UUID profileId) {
        Actor actor = access.require(merchantId, Permission.PAYMENT_PROFILES_MANAGE);
        PaymentProfile old = find(merchantId, profileId);
        if (old.getStatus() == PaymentProfile.Status.REVOKED) {
            throw ApiException.invalidState("invalid_state", "This link was already replaced.");
        }
        PaymentProfile replacement = new PaymentProfile(UUID.randomUUID(), merchantId, SecureTokens.publicToken(TOKEN_LENGTH), old.getLabel(),
                old.getBranchId(), old.getAssignedCashierUserId(), old.getPaymentDestinationId(), clock.instant());
        profiles.saveAndFlush(replacement);
        old.revoke(replacement.getId(), clock.instant());
        audit.record(merchantId, actor.userId(), "PAYMENT_LINK_REPLACED", "payment_profile", profileId, "Payment link replaced; the old link no longer works.");
        return toDto(replacement);
    }

    // ---- invoice payment requests --------------------------------------------------------------

    /** A request for an issued invoice, for exactly its outstanding balance, open for the traditional seven days. */
    @Transactional
    public PaymentDtos.RequestDto createInvoiceRequest(UUID merchantId, UUID invoiceId) {
        return createInvoiceRequest(merchantId, invoiceId, PaymentRequestOptions.traditionalInvoice(), false);
    }

    /**
     * The same request with a lifetime chosen by TRUSTED server code (a checkout flow wanting a shorter one). The expiry is
     * {@code now + lifetime} on this server's clock, the lifetime is validated by {@link PaymentRequestOptions}, and no
     * controller or public page reaches this method. The request records where it came from: the source is its
     * invoice's sale channel, the branch is the invoice's branch, and the creator is the signed-in member. The database
     * enforces that these agree with the invoice and the business.
     *
     * <p>Lifetime policy. A live request for the invoice is never overwritten, shortened, lengthened or replaced here. If one
     * already exists with exactly the requested lifetime it is returned (so a retry is harmless); if it was created with a
     * different lifetime the call fails with 409 {@code payment_request_lifetime_conflict} and nothing changes. To get a
     * request with another lifetime the caller must first cancel the existing one explicitly (a deliberate act) and then
     * create the new one. The existing two-argument method, used by the merchant API, keeps its behaviour: it returns whatever
     * live request exists, so the customer keeps one reference per invoice.
     *
     * <p>Bank confirmation and reconciliation are not touched.
     */
    @Transactional
    public PaymentDtos.RequestDto createInvoiceRequest(UUID merchantId, UUID invoiceId, PaymentRequestOptions options) {
        return createInvoiceRequest(merchantId, invoiceId, options, true);
    }

    private PaymentDtos.RequestDto createInvoiceRequest(UUID merchantId, UUID invoiceId, PaymentRequestOptions options,
                                                        boolean lifetimeMustMatchAnExistingRequest) {
        Actor actor = access.require(merchantId, Permission.INVOICES_VIEW);
        Invoice invoice = visibleInvoice(actor, merchantId, invoiceId);
        // Serialise with other creators and with allocations for this invoice.
        invoice = invoices.lockByIdAndMerchantId(invoiceId, merchantId).orElseThrow(PaymentProfileService::invoiceNotFound);
        if (invoice.getStatus() != InvoiceStatus.ISSUED) {
            throw ApiException.invalidState("invoice_not_payable",
                    "Only an issued invoice can be paid. Cancelled, voided and draft invoices cannot.");
        }
        long remaining = LedgerMath.summarize(invoice.getGrandTotalRwf(), balances.allocated(invoiceId)).remainingBalance();
        if (remaining <= 0) {
            throw ApiException.invalidState("invoice_not_payable", "This invoice is already fully paid.");
        }
        // Reuse a live request so the customer keeps one reference for one invoice.
        Optional<PaymentRequest> live = requests.findByMerchantIdAndInvoiceIdOrderByCreatedAtDesc(merchantId, invoiceId).stream()
                .filter(r -> {
                    var status = resolver.resolve(r).state().status();
                    return status != PaymentRequestState.Status.CANCELLED && status != PaymentRequestState.Status.EXPIRED;
                }).findFirst();
        if (live.isPresent()) {
            if (lifetimeMustMatchAnExistingRequest && !lifetimeOf(live.get()).equals(options.lifetime())) {
                throw ApiException.conflict("payment_request_lifetime_conflict",
                        "This invoice already has an open payment request with a different lifetime. "
                                + "Cancel it first if you need one with the requested lifetime.");
            }
            return toDto(live.get());
        }
        Invoice target = invoice;
        PaymentProfile profile = chooseProfile(merchantId, target.getBranchId(), target.getAssignedToUserId())
                .orElseThrow(() -> new ApiException(HttpStatus.CONFLICT, "no_active_profile",
                        "There is no active payment link for this invoice. Create or switch one on in Payment links."));
        Instant now = clock.instant();
        PaymentRequest request = new PaymentRequest(UUID.randomUUID(), merchantId, profile.getId(), invoiceId, remaining,
                newReference(), now.plus(options.lifetime()), now,
                PaymentRequestSource.forInvoice(target.getSaleChannel()), target.getBranchId(), actor.userId());
        requests.saveAndFlush(request);
        audit.record(merchantId, actor.userId(), "PAYMENT_REQUEST_CREATED", "payment_request", request.getId(),
                "Payment request created for invoice " + target.getInvoiceNumber() + ".");
        return toDto(request);
    }

    /**
     * Whether an invoice for this branch and assignee could be collected right now: an active payment link (the assignee's, the
     * branch's or the business-wide one) that points at a connected payment destination. Lets a checkout say so BEFORE billing.
     */
    @Transactional(readOnly = true)
    public boolean canCollectFor(UUID merchantId, UUID branchId, UUID assigneeUserId) {
        access.require(merchantId, Permission.INVOICES_CREATE);
        return chooseProfile(merchantId, branchId, assigneeUserId).isPresent();
    }

    @Transactional(readOnly = true)
    public List<PaymentDtos.RequestDto> listInvoiceRequests(UUID merchantId, UUID invoiceId) {
        Actor actor = access.require(merchantId, Permission.INVOICES_VIEW);
        visibleInvoice(actor, merchantId, invoiceId);
        return requests.findByMerchantIdAndInvoiceIdOrderByCreatedAtDesc(merchantId, invoiceId).stream().map(this::toDto).toList();
    }

    @Transactional
    public PaymentDtos.RequestDto cancelRequest(UUID merchantId, UUID requestId) {
        Actor actor = access.require(merchantId, Permission.PAYMENT_PROFILES_MANAGE);
        PaymentRequest request = requests.findByIdAndMerchantId(requestId, merchantId)
                .orElseThrow(() -> ApiException.notFound("This request could not be found."));
        var status = resolver.resolve(request).state().status();
        if (status == PaymentRequestState.Status.SETTLED || status == PaymentRequestState.Status.PARTIALLY_SETTLED) {
            throw ApiException.invalidState("invalid_state", "Money has already been confirmed for this request, so it cannot be cancelled.");
        }
        request.cancel(clock.instant());
        audit.record(merchantId, actor.userId(), "PAYMENT_REQUEST_CANCELLED", "payment_request", requestId, "Payment request cancelled.");
        return toDto(request);
    }

    // ---- internals -----------------------------------------------------------------------------

    /** Best-matching active link: cashier+branch, then branch, then business-wide. */
    private Optional<PaymentProfile> chooseProfile(UUID merchantId, UUID branchId, UUID assigneeUserId) {
        List<PaymentProfile> candidates = profiles.findByMerchantIdOrderByCreatedAtDesc(merchantId).stream()
                .filter(p -> p.getStatus() == PaymentProfile.Status.ACTIVE)
                .filter(p -> destinations.findByIdAndMerchantId(p.getPaymentDestinationId(), merchantId)
                        .flatMap(d -> connections.findById(d.getBankConnectionId()))
                        .filter(c -> c.getStatus() == BankConnection.Status.CONNECTED).isPresent())
                .toList();
        return candidates.stream().filter(p -> assigneeUserId.equals(p.getAssignedCashierUserId())
                        && branchId.equals(p.getBranchId())).findFirst()
                .or(() -> candidates.stream().filter(p -> p.getAssignedCashierUserId() == null && branchId.equals(p.getBranchId())).findFirst())
                .or(() -> candidates.stream().filter(p -> p.getAssignedCashierUserId() == null && p.getBranchId() == null).findFirst());
    }

    /** How long the request was originally opened for. */
    private static Duration lifetimeOf(PaymentRequest request) {
        return Duration.between(request.getCreatedAt(), request.getExpiresAt());
    }

    private String newReference() {
        for (int attempt = 0; attempt < 5; attempt++) {
            String reference = SecureTokens.paymentReference();
            if (!requests.existsByPublicReference(reference)) {
                return reference;
            }
        }
        throw new ApiException(HttpStatus.INTERNAL_SERVER_ERROR, "service_unavailable", "A reference could not be created.");
    }

    private List<PaymentDtos.CashierOption> cashiers(UUID merchantId) {
        var activeAssignments = assignments.findByMerchantIdAndStatus(merchantId, "ACTIVE");
        return memberships.findByMerchantId(merchantId).stream()
                .filter(m -> m.getRole() == Role.CASHIER && m.isActive())
                .flatMap(m -> users.findById(m.getUserId()).filter(u -> u.getStatus() == UserStatus.ACTIVE).stream()
                        .map(u -> new PaymentDtos.CashierOption(u.getId(), u.getFullName(),
                                activeAssignments.stream().filter(a -> a.getMembershipId().equals(m.getId())).map(a -> a.getBranchId()).toList())))
                .toList();
    }

    private Invoice visibleInvoice(Actor actor, UUID merchantId, UUID invoiceId) {
        Invoice invoice = invoices.findByIdAndMerchantId(invoiceId, merchantId).orElseThrow(PaymentProfileService::invoiceNotFound);
        if (!actor.hasFullScope(Permission.INVOICES_VIEW) && !invoice.getAssignedToUserId().equals(actor.userId())) {
            throw invoiceNotFound();
        }
        return invoice;
    }

    private PaymentProfile find(UUID merchantId, UUID profileId) {
        return profiles.findByIdAndMerchantId(profileId, merchantId).orElseThrow(PaymentProfileService::notFound);
    }

    private static ApiException notFound() {
        return ApiException.notFound("This payment link could not be found.");
    }

    private static ApiException invoiceNotFound() {
        return ApiException.notFound("This invoice could not be found.");
    }

    private PaymentDtos.ProfileDto toDto(PaymentProfile p) {
        String branchName = p.getBranchId() == null ? null : branches.findById(p.getBranchId()).map(Branch::getName).orElse(null);
        String cashierName = p.getAssignedCashierUserId() == null ? null : users.findById(p.getAssignedCashierUserId()).map(User::getFullName).orElse(null);
        Optional<PaymentDestination> destination = destinations.findById(p.getPaymentDestinationId());
        String display = merchants.findById(p.getMerchantId()).map(rw.oupay.merchant.Merchant::displayName).orElse("Business");
        return new PaymentDtos.ProfileDto(p.getId(), p.getMerchantId(), p.getPublicToken(), display, p.getLabel(), p.getBranchId(),
                p.getAssignedCashierUserId(), p.getPaymentDestinationId(), p.getStatus(), p.getReplacedByProfileId(), p.getCreatedAt(),
                p.getUpdatedAt(), branchName, cashierName, destination.map(PaymentDestination::getLabel).orElse("Unknown destination"),
                destination.map(PaymentDestination::getMaskedAccount).orElse(""), destination.map(PaymentDestination::isSimulated).orElse(true));
    }

    PaymentDtos.RequestDto toDto(PaymentRequest r) {
        var resolved = resolver.resolve(r);
        String token = profiles.findById(r.getPaymentProfileId()).map(PaymentProfile::getPublicToken).orElse("");
        return new PaymentDtos.RequestDto(r.getId(), r.getMerchantId(), r.getPaymentProfileId(), r.getInvoiceId(), r.getRequestedAmountRwf(),
                "RWF", r.getPublicReference(), resolved.state().status(), r.getExpiresAt(), r.getCreatedAt(), r.getUpdatedAt(),
                r.getCancelledAt(), r.getInstructionsOpenedAt(), r.getCustomerClaimedAt(), token);
    }
}
