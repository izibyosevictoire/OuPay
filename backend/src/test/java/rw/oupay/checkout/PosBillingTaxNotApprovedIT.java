package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;
import org.springframework.test.context.TestPropertySource;
import rw.oupay.pos.PosTaxPolicy;
import tools.jackson.databind.JsonNode;

/** The default: no tax treatment has been approved for payable POS invoices, so NOTHING can be billed, however the catalog is configured. */
@TestPropertySource(properties = {
        "oupay.collection-codes.approval-enabled=true",
        "oupay.code-checkout.live-enabled=true"})
class PosBillingTaxNotApprovedIT extends PosBillingTestSupport {

    @Test
    void untilAnApprovalIsConfiguredNoPosInvoiceCanBeIssuedEvenForFullyClassifiedItems() {
        live();
        JsonNode draft = saveDraft(line(rice, "2", "kg"), line(repair, "1", "pc"));
        JsonNode review = review(w.cashier, draft).json();
        assertThat(review.path("billable").asBoolean()).isFalse();
        assertThat(review.path("approvedTaxTreatments").size()).isZero();
        assertThat(review.path("problems").toString()).contains("tax_not_approved");
        var refused = bill(w.cashier, "bill-unapproved-1", draft, 8_540);
        assertThat(refused.status()).isEqualTo(422);
        assertThat(refused.code()).isEqualTo("tax_not_approved");
        assertThat(count("invoices")).isZero();
        assertThat(count("stock_reservations")).isZero();
        assertThat(draftNow(draft).path("status").asString()).isEqualTo("DRAFT");
    }

    @Test
    void theApprovalListIsStrictlyParsed() {
        assertThat(new PosTaxPolicy("").approvedLabels()).isEmpty();
        assertThat(new PosTaxPolicy(" EXEMPT:0 , STANDARD:1800 ").isApproved(rw.oupay.invoice.InvoiceCalculator.TaxCategory.STANDARD, 1_800)).isTrue();
        assertThat(new PosTaxPolicy("STANDARD:1800").isApproved(rw.oupay.invoice.InvoiceCalculator.TaxCategory.STANDARD, 1_000)).isFalse();
        assertThat(new PosTaxPolicy("EXEMPT:0").isApproved(rw.oupay.invoice.InvoiceCalculator.TaxCategory.ZERO_RATED, 0)).isFalse();
        for (String bad : new String[] {"EXEMPT", "EXEMPT:5", "STANDARD:0", "STANDARD:10001", "BOGUS:0", "STANDARD:x"}) {
            assertThatThrownBy(() -> new PosTaxPolicy(bad)).as(bad).isInstanceOf(IllegalStateException.class);
        }
    }
}
