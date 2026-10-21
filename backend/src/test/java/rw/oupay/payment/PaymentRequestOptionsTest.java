package rw.oupay.payment;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import org.junit.jupiter.api.Test;
import rw.oupay.invoice.SaleChannel;

class PaymentRequestOptionsTest {

    @Test
    void theTraditionalLifetimeIsExactlySevenDays() {
        assertThat(PaymentRequestOptions.traditionalInvoice().lifetime()).isEqualTo(Duration.ofDays(7));
        assertThat(PaymentRequestOptions.TRADITIONAL_INVOICE_LIFETIME).isEqualTo(Duration.ofDays(7));
    }

    @Test
    void aCheckoutFlowMayChooseAShorterLifetime() {
        assertThat(PaymentRequestOptions.ofLifetime(Duration.ofMinutes(15)).lifetime()).isEqualTo(Duration.ofMinutes(15));
        assertThat(PaymentRequestOptions.ofLifetime(Duration.ofHours(2)).lifetime()).isEqualTo(Duration.ofHours(2));
    }

    @Test
    void theBoundsAreInclusive() {
        assertThat(PaymentRequestOptions.ofLifetime(Duration.ofMinutes(1)).lifetime()).isEqualTo(Duration.ofMinutes(1));
        assertThat(PaymentRequestOptions.ofLifetime(Duration.ofDays(7)).lifetime()).isEqualTo(Duration.ofDays(7));
    }

    @Test
    void zeroNegativeTooShortTooLongAndMissingLifetimesAreRejected() {
        for (Duration invalid : new Duration[] {Duration.ZERO, Duration.ofMinutes(-5), Duration.ofSeconds(59),
                Duration.ofDays(7).plusMillis(1), Duration.ofDays(30), Duration.ofDays(3650)}) {
            assertThatThrownBy(() -> PaymentRequestOptions.ofLifetime(invalid)).as(invalid.toString())
                    .isInstanceOf(IllegalArgumentException.class);
        }
        assertThatThrownBy(() -> PaymentRequestOptions.ofLifetime(null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new PaymentRequestOptions(null)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void aRequestSourceIsEitherOpenOrTheInvoicesOwnChannelWithNoOtherValueToDriftTo() {
        for (SaleChannel channel : SaleChannel.values()) {
            assertThat(PaymentRequestSource.forInvoice(channel).name()).isEqualTo(channel.name());
        }
        assertThat(PaymentRequestSource.values()).extracting(Enum::name)
                .containsExactlyInAnyOrder("OPEN", "INVOICE", "POS", "SIMPLIFIED");
    }
}
