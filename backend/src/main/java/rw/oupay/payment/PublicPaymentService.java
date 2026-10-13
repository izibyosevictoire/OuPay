package rw.oupay.payment;

import java.time.Clock;
import java.time.Duration;
import java.util.List;
import java.util.Optional;
import java.util.regex.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.banking.BankConnection;
import rw.oupay.banking.BankConnectionRepository;
import rw.oupay.banking.BankingProviderAdapter;
import rw.oupay.banking.Capability;
import rw.oupay.banking.PaymentDestination;
import rw.oupay.banking.PaymentDestinationRepository;
import rw.oupay.banking.ProviderId;
import rw.oupay.banking.ProviderRegistry;
import rw.oupay.branch.Branch;
import rw.oupay.branch.BranchRepository;
import rw.oupay.common.ApiException;
import rw.oupay.common.SecureTokens;
import rw.oupay.merchant.Merchant;
import rw.oupay.merchant.MerchantRepository;
import rw.oupay.user.User;
import rw.oupay.user.UserRepository;

/**
 * What an ANONYMOUS customer can do. No sign-in, so every method takes only public tokens and returns
 * only what that customer may know: the merchant's display name, the amount, the reference and the
 * status of THIS payment request. Never other transactions, payers, staff, business identifiers or
 * banking detail.
 *
 * <p>Nothing here can confirm a payment. The customer can say they started one, but only a trusted
 * bank event (the integration boundary) can establish receipt.
 */
@Service
public class PublicPaymentService {

    static final long MIN_OPEN_AMOUNT = 100;
    static final long MAX_OPEN_AMOUNT = 10_000_000;
    static final Duration OPEN_REQUEST_LIFETIME = Duration.ofMinutes(30);
    /** Anti-abuse: a single public link cannot be used to flood the database with requests. */
    static final int MAX_OPEN_REQUESTS_PER_PROFILE_PER_HOUR = 200;

    private static final Pattern TOKEN = Pattern.compile("^[0-9A-Za-z]{12}$");
    private static final Pattern REFERENCE = Pattern.compile("^OP-[2-9A-HJKMNP-Z]{12}$");

    private static final List<PaymentDtos.MethodDefinition> METHODS = List.of(
            new PaymentDtos.MethodDefinition("EQUITY_MERCHANT", "Equity Bank merchant payment", ProviderId.EQUITY_MOCK),
            new PaymentDtos.MethodDefinition("MTN_MOMO", "MTN MoMo", ProviderId.MTN_MOMO),
            new PaymentDtos.MethodDefinition("AIRTEL_MONEY", "Airtel Money", ProviderId.AIRTEL_MONEY));

    private final PaymentProfileRepository profiles;
    private final PaymentRequestRepository requests;
    private final MerchantRepository merchants;
    private final BranchRepository branches;
    private final UserRepository users;
    private final PaymentDestinationRepository destinations;
    private final BankConnectionRepository connections;
    private final ProviderRegistry registry;
    private final PaymentRequestResolver resolver;
    private final Clock clock;

    public PublicPaymentService(PaymentProfileRepository profiles, PaymentRequestRepository requests, MerchantRepository merchants,
                                BranchRepository branches, UserRepository users, PaymentDestinationRepository destinations,
                                BankConnectionRepository connections, ProviderRegistry registry, PaymentRequestResolver resolver, Clock clock) {
        this.profiles = profiles;
        this.requests = requests;
        this.merchants = merchants;
        this.branches = branches;
        this.users = users;
        this.destinations = destinations;
        this.connections = connections;
        this.registry = registry;
        this.resolver = resolver;
        this.clock = clock;
    }

    /** Unknown tokens fail with not_found; inactive or revoked ones return an UNAVAILABLE view that names nothing. */
    @Transactional(readOnly = true)
    public PaymentDtos.PublicProfile profile(String token) {
        return view(profileOf(token));
    }

    @Transactional
    public PaymentDtos.PublicRequest createOpenRequest(String token, long amountRwf) {
        PaymentProfile profile = profileOf(token);
        if (view(profile).status().equals("UNAVAILABLE")) {
            throw new ApiException(HttpStatus.CONFLICT, "profile_unavailable", "This payment link is not available.");
        }
        if (amountRwf < MIN_OPEN_AMOUNT || amountRwf > MAX_OPEN_AMOUNT) {
            throw ApiException.validation("Enter a whole amount between RWF " + MIN_OPEN_AMOUNT + " and RWF " + MAX_OPEN_AMOUNT + ".");
        }
        if (requests.countByPaymentProfileIdAndCreatedAtAfter(profile.getId(), clock.instant().minus(Duration.ofHours(1))) >= MAX_OPEN_REQUESTS_PER_PROFILE_PER_HOUR) {
            throw new ApiException(HttpStatus.TOO_MANY_REQUESTS, "rate_limited", "Too many requests for this link. Please try again later.");
        }
        String reference;
        do {
            reference = SecureTokens.paymentReference();
        } while (requests.existsByPublicReference(reference));
        var now = clock.instant();
        PaymentRequest request = new PaymentRequest(java.util.UUID.randomUUID(), profile.getMerchantId(), profile.getId(), null, amountRwf,
                reference, now.plus(OPEN_REQUEST_LIFETIME), now);
        requests.saveAndFlush(request);
        return requestView(profile, request);
    }

    @Transactional(readOnly = true)
    public PaymentDtos.PublicRequest request(String token, String reference) {
        PaymentProfile profile = profileOf(token);
        return requestView(profile, requestOf(profile, reference));
    }

    /** Records that the customer opened the payment instructions. Never a payment. */
    @Transactional
    public void markInstructionsOpened(String token, String reference) {
        PaymentProfile profile = profileOf(token);
        requestOf(profile, reference).markInstructionsOpened(clock.instant());
    }

    /** Records the customer's CLAIM that they started a payment. It changes nothing about the verified status. */
    @Transactional
    public void claimPaymentInitiated(String token, String reference) {
        PaymentProfile profile = profileOf(token);
        PaymentRequest request = requestOf(profile, reference);
        var stage = resolver.resolve(request).state().stage();
        if (stage == PaymentRequestState.Stage.EXPIRED || stage == PaymentRequestState.Stage.CANCELLED) {
            throw new ApiException(HttpStatus.CONFLICT, "request_unavailable", "This request is no longer payable.");
        }
        request.markCustomerClaimed(clock.instant());
    }

    // ---- internals -----------------------------------------------------------------------------

    private PaymentProfile profileOf(String token) {
        // Malformed tokens never reach the database, and look exactly like unknown ones.
        if (token == null || !TOKEN.matcher(token).matches()) {
            throw notFound();
        }
        return profiles.findByPublicToken(token).orElseThrow(PublicPaymentService::notFound);
    }

    /** The request, only if it belongs to the profile the URL names. Anything else is "not found". */
    private PaymentRequest requestOf(PaymentProfile profile, String reference) {
        if (reference == null || !REFERENCE.matcher(reference).matches()) {
            throw notFound();
        }
        return requests.findByPublicReference(reference).filter(r -> r.getPaymentProfileId().equals(profile.getId()))
                .orElseThrow(PublicPaymentService::notFound);
    }

    private static ApiException notFound() {
        return ApiException.notFound("This payment page could not be found.");
    }

    private Optional<BankConnection> connectionOf(PaymentProfile profile) {
        return destinations.findById(profile.getPaymentDestinationId()).flatMap(d -> connections.findById(d.getBankConnectionId()));
    }

    private PaymentDtos.PublicProfile view(PaymentProfile profile) {
        Optional<Merchant> merchant = merchants.findById(profile.getMerchantId());
        boolean live = profile.getStatus() == PaymentProfile.Status.ACTIVE && merchant.isPresent()
                && !merchant.get().getStatus().equals("suspended") && !merchant.get().getStatus().equals("rejected")
                && connectionOf(profile).filter(c -> c.getStatus() == BankConnection.Status.CONNECTED).isPresent();
        if (!live) {
            // An unavailable link reveals nothing: no name, no branch, no cashier.
            return new PaymentDtos.PublicProfile("", null, null, false, "UNAVAILABLE", List.of());
        }
        String branchName = profile.getBranchId() == null ? null : branches.findById(profile.getBranchId()).map(Branch::getName).orElse(null);
        String cashier = profile.getAssignedCashierUserId() == null ? null
                : users.findById(profile.getAssignedCashierUserId()).map(User::getFullName).map(PublicPaymentService::publicCashierName).orElse(null);
        return new PaymentDtos.PublicProfile(merchant.get().displayName(), branchName, cashier,
                // Verified only when OuPay really verified the business, never by default.
                merchant.get().getStatus().equals("active"), "ACTIVE", methodsFor(profile));
    }

    /** "Aline Uwase" becomes "Aline U." Nothing more is shown to the public. */
    static String publicCashierName(String fullName) {
        String[] parts = fullName.trim().split("\\s+");
        if (parts.length < 2) {
            return parts[0];
        }
        return parts[0] + " " + Character.toUpperCase(parts[parts.length - 1].charAt(0)) + ".";
    }

    private List<PaymentDtos.PublicMethod> methodsFor(PaymentProfile profile) {
        Optional<PaymentDestination> destination = destinations.findById(profile.getPaymentDestinationId());
        Optional<BankConnection> connection = connectionOf(profile);
        return METHODS.stream().map(method -> {
            var adapter = registry.adapter(method.providerId());
            boolean configured = destination.filter(d -> d.getProviderId() == method.providerId()).isPresent()
                    && connection.filter(c -> c.getStatus() == BankConnection.Status.CONNECTED).isPresent();
            boolean canConfirm = adapter.map(a -> a.capabilities().transactionWebhooks() == Capability.SUPPORTED).orElse(false);
            boolean usable = adapter.isPresent() && configured && canConfirm;
            // Plain steps only: no USSD codes, deep links, endpoints or credential requests are invented.
            List<String> instructions = usable ? List.of(
                    "Pay the merchant through your bank or wallet using the payment option it offers.",
                    "Include the reference shown on this page exactly as written, so the payment can be matched.",
                    "Never share a PIN, password or one-time code with anyone, including the merchant.",
                    "Keep this page open: it updates once the bank confirms your payment.") : List.of();
            return new PaymentDtos.PublicMethod(method.id(), method.label(), usable,
                    usable ? null : adapter.isEmpty() ? "Not available yet." : "This merchant has not set this method up.",
                    adapter.map(BankingProviderAdapter::isSimulated).orElse(false), instructions);
        }).toList();
    }

    private PaymentDtos.PublicRequest requestView(PaymentProfile profile, PaymentRequest request) {
        var resolved = resolver.resolve(request);
        boolean simulated = destinations.findById(profile.getPaymentDestinationId()).map(PaymentDestination::isSimulated).orElse(true);
        return new PaymentDtos.PublicRequest(view(profile), resolved.invoiceNumber(), request.getRequestedAmountRwf(),
                resolved.state().amountDue(), "RWF", resolved.state().confirmedAmount(), request.getPublicReference(), true,
                resolved.state().stage(), request.getExpiresAt(), request.getInstructionsOpenedAt() != null,
                request.getCustomerClaimedAt() != null, simulated);
    }
}
