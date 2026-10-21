package rw.oupay.payment;

import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class PaymentRequestProvenanceTest {

    private static final Instant NOW = Instant.parse("2026-01-01T00:00:00Z");
    private final UUID merchant = UUID.randomUUID();
    private final UUID profile = UUID.randomUUID();
    private final UUID invoice = UUID.randomUUID();
    private final UUID branch = UUID.randomUUID();
    private final UUID creator = UUID.randomUUID();

    private PaymentRequest build(UUID invoiceId, PaymentRequestSource source, UUID branchId, UUID createdBy) {
        return new PaymentRequest(UUID.randomUUID(), merchant, profile, invoiceId, 1_000, "OP-TEST", NOW.plusSeconds(60), NOW,
                source, branchId, createdBy);
    }

    @Test
    void aCompleteInvoiceRequestAndAnAnonymousOpenRequestAreAccepted() {
        PaymentRequest forInvoice = build(invoice, PaymentRequestSource.POS, branch, creator);
        assertThat(forInvoice.getSource()).isEqualTo(PaymentRequestSource.POS);
        assertThat(forInvoice.getBranchId()).isEqualTo(branch);
        assertThat(forInvoice.getCreatedByUserId()).isEqualTo(creator);
        assertThat(build(null, PaymentRequestSource.OPEN, branch, null).getSource()).isEqualTo(PaymentRequestSource.OPEN);
        assertThat(build(null, PaymentRequestSource.OPEN, null, null).getSource()).isEqualTo(PaymentRequestSource.OPEN);
    }

    @Test
    void inconsistentProvenanceIsRefused() {
        assertThatThrownBy(() -> build(invoice, null, branch, creator)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> build(invoice, PaymentRequestSource.OPEN, branch, null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> build(null, PaymentRequestSource.INVOICE, branch, creator)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> build(null, PaymentRequestSource.OPEN, branch, creator)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> build(invoice, PaymentRequestSource.POS, null, creator)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> build(invoice, PaymentRequestSource.POS, branch, null)).isInstanceOf(IllegalArgumentException.class);
    }
}
