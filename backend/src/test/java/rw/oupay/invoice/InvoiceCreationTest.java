package rw.oupay.invoice;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.UUID;
import org.junit.jupiter.api.Test;

class InvoiceCreationTest {

    @Test
    void aManualInvoiceIsATraditionalInvoiceWithNoClientRequestId() {
        InvoiceCreation manual = InvoiceCreation.manual();
        assertThat(manual.channel()).isEqualTo(SaleChannel.INVOICE);
        assertThat(manual.clientRequestId()).isNull();
    }

    @Test
    void checkoutChannelsMustCarryADurableClientRequestId() {
        UUID id = UUID.randomUUID();
        assertThat(new InvoiceCreation(SaleChannel.POS, id).clientRequestId()).isEqualTo(id);
        assertThat(new InvoiceCreation(SaleChannel.SIMPLIFIED, id).channel()).isEqualTo(SaleChannel.SIMPLIFIED);
        assertThatThrownBy(() -> new InvoiceCreation(SaleChannel.POS, null)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new InvoiceCreation(SaleChannel.SIMPLIFIED, null)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void aTraditionalInvoiceMayCarryOneButNeedsNone() {
        assertThat(new InvoiceCreation(SaleChannel.INVOICE, UUID.randomUUID()).clientRequestId()).isNotNull();
        assertThat(new InvoiceCreation(SaleChannel.INVOICE, null).clientRequestId()).isNull();
    }

    @Test
    void aMissingChannelOrTheNilIdentifierIsRejected() {
        assertThatThrownBy(() -> new InvoiceCreation(null, UUID.randomUUID())).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new InvoiceCreation(SaleChannel.POS, new UUID(0L, 0L))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new InvoiceCreation(SaleChannel.INVOICE, new UUID(0L, 0L))).isInstanceOf(IllegalArgumentException.class);
    }
}
