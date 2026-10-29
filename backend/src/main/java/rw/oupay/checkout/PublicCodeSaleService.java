package rw.oupay.checkout;

import java.util.Arrays;
import java.util.List;
import java.util.regex.Pattern;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.common.ApiException;
import rw.oupay.merchant.MerchantRepository;
import rw.oupay.payment.PaymentRequestRepository;
import rw.oupay.payment.PaymentRequestResolver;
import rw.oupay.payment.PaymentRequestSource;
import rw.oupay.payment.PaymentRequestState;

/**
 * The CUSTOMER page for a code sale. Anonymous, read-only and deliberately thin: it names the business, the amount, the sale reference and the
 * code, and the honest state. It never shows who the agent is, which account the money settles to, or any internal identifier, and it offers
 * NO other way to pay: this flow is code-only. A reference that is not a code sale is "not found" here, and a code sale is "not found" on the
 * ordinary public payment pages.
 *
 * <p>The instructions are configuration ({@code oupay.code-checkout.instructions}, separated by {@code |}), because the wording must come from
 * what Equity has CONFIRMED. Until it is configured the page shows none, and invents none.
 */
@Service
public class PublicCodeSaleService {

    private static final Pattern REFERENCE = Pattern.compile("^OP-[2-9A-HJKMNP-Z]{12}$");

    private final JdbcClient jdbc;
    private final PaymentRequestRepository requests;
    private final PaymentRequestResolver resolver;
    private final MerchantRepository merchants;
    private final List<String> instructions;

    public PublicCodeSaleService(JdbcClient jdbc, PaymentRequestRepository requests, PaymentRequestResolver resolver, MerchantRepository merchants,
                                 @Value("${oupay.code-checkout.instructions:}") String instructions) {
        this.jdbc = jdbc;
        this.requests = requests;
        this.resolver = resolver;
        this.merchants = merchants;
        this.instructions = instructions == null ? List.of()
                : Arrays.stream(instructions.split("\\|")).map(String::trim).filter(s -> !s.isEmpty()).toList();
    }

    @Transactional(readOnly = true)
    public CodeCheckoutDtos.PublicCodeSale sale(String reference) {
        if (reference == null || !REFERENCE.matcher(reference).matches()) {
            throw notFound();
        }
        var request = requests.findByPublicReference(reference).filter(r -> r.getSource() == PaymentRequestSource.CODE).orElseThrow(PublicCodeSaleService::notFound);
        String[] row = jdbc.sql("select description, presentation_mode, code_label, code_external_code, code_internal_ref from code_sales where payment_request_id = :id")
                .param("id", request.getId())
                .query((rs, i) -> new String[] {rs.getString(1), rs.getString(2), rs.getString(3), rs.getString(4), rs.getString(5)})
                .optional().orElseThrow(PublicCodeSaleService::notFound);
        boolean live = "LIVE".equals(row[1]);
        var state = CodeCheckoutService.effectiveState(row[1], resolver.resolve(request).state(), request.getRequestedAmountRwf());
        var customer = customerStatus(state);
        String merchantName = merchants.findById(request.getMerchantId()).map(m -> m.displayName()).orElse("Business");
        return new CodeCheckoutDtos.PublicCodeSale(merchantName, reference, request.getRequestedAmountRwf(), "RWF", row[0], customer, state.confirmedAmount(),
                state.amountDue(), request.getExpiresAt(), publicPresentation(CodeCheckoutService.presentation(row[1], row[2], row[3], row[4])), live ? instructions : List.of(),
                noteFor(customer, live));
    }

    /** The customer never sees OuPay's internal code reference: a demonstration says what it is, and a live sale shows the bank code. */
    private static CodeCheckoutDtos.CodePresentation publicPresentation(CodeCheckoutDtos.CodePresentation p) {
        return new CodeCheckoutDtos.CodePresentation(p.mode(), p.label(), p.bankCode(), null, p.notice());
    }

    /** Paid only when the bank-verified money has been applied to the sale. Confirmed but not applied needs reconciliation, never "paid". */
    static CodeCheckoutDtos.CustomerStatus customerStatus(PaymentRequestState.State state) {
        if (state.stage() == PaymentRequestState.Stage.CONFIRMED_UNMATCHED || state.stage() == PaymentRequestState.Stage.REVERSED) {
            return CodeCheckoutDtos.CustomerStatus.REQUIRES_RECONCILIATION;
        }
        return switch (state.status()) {
            case SETTLED -> CodeCheckoutDtos.CustomerStatus.PAID;
            case PARTIALLY_SETTLED -> CodeCheckoutDtos.CustomerStatus.PARTIALLY_PAID;
            case EXPIRED -> CodeCheckoutDtos.CustomerStatus.EXPIRED;
            case CANCELLED -> CodeCheckoutDtos.CustomerStatus.CANCELLED;
            case CREATED, AWAITING_PAYMENT -> CodeCheckoutDtos.CustomerStatus.AWAITING_PAYMENT;
        };
    }

    private static String noteFor(CodeCheckoutDtos.CustomerStatus status, boolean live) {
        return switch (status) {
            case AWAITING_PAYMENT -> live ? "Waiting for the bank to confirm a payment. Nothing has been received yet."
                    : "Nothing can be paid: this is a demonstration with a simulated code.";
            case PARTIALLY_PAID -> "The bank has confirmed part of the amount. The rest is still due.";
            case PAID -> "The bank has confirmed this payment and it has been applied to this sale.";
            case EXPIRED -> "This request has expired. If you already paid, the business will match it when the bank confirms it.";
            case CANCELLED -> "This request was cancelled.";
            case REQUIRES_RECONCILIATION -> "The bank reported a payment that is not yet matched to this sale. The business will review it.";
        };
    }

    private static ApiException notFound() {
        return ApiException.notFound("This payment page could not be found.");
    }
}
