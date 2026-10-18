package rw.oupay.email;

import static org.assertj.core.api.Assertions.*;
import static org.mockito.ArgumentMatchers.*;
import static org.mockito.Mockito.*;

import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.UUID;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import tools.jackson.databind.ObjectMapper;

class ResendEmailSenderTest {

    private static EmailMessage message(UUID id) {
        return new EmailMessage(
            id,
            "cashier@example.com",
            "noreply@ousuite.com",
            "Invitation to OuPay",
            "Accept your invitation",
            "<p>Accept your invitation</p>"
        );
    }

    @SuppressWarnings("unchecked")
    private static HttpClient mockClient(int status) throws Exception {
        HttpClient client = mock(HttpClient.class);
        HttpResponse<String> response = mock(HttpResponse.class);

        when(response.statusCode()).thenReturn(status);
        when(client.send(any(HttpRequest.class), any(HttpResponse.BodyHandler.class)))
            .thenReturn(response);

        return client;
    }

    @Test
    void acceptsSuccessfulProviderResponse() throws Exception {
        var sender = new ResendEmailSender(
            "test-key",
            new ObjectMapper(),
            mockClient(200)
        );

        assertThatCode(() -> sender.send(message(UUID.randomUUID())))
            .doesNotThrowAnyException();
    }

    @Test
    void acceptsCreatedResponse() throws Exception {
        var sender = new ResendEmailSender(
            "test-key",
            new ObjectMapper(),
            mockClient(201)
        );

        assertThatCode(() -> sender.send(message(UUID.randomUUID())))
            .doesNotThrowAnyException();
    }

    @Test
    void sendsAuthorizationAndStableIdempotencyKey() throws Exception {
        HttpClient client = mockClient(200);
        var sender = new ResendEmailSender(
            "test-key",
            new ObjectMapper(),
            client
        );

        UUID id = UUID.randomUUID();
        sender.send(message(id));
        sender.send(message(id));

        ArgumentCaptor<HttpRequest> requests =
            ArgumentCaptor.forClass(HttpRequest.class);

        verify(client, times(2))
            .send(requests.capture(), any(HttpResponse.BodyHandler.class));

        for (HttpRequest request : requests.getAllValues()) {
            assertThat(request.uri().toString())
                .isEqualTo("https://api.resend.com/emails");

            assertThat(request.headers()
                .firstValue("Authorization"))
                .hasValue("Bearer test-key");

            assertThat(request.headers()
                .firstValue("Idempotency-Key"))
                .hasValue("oupay-email/" + id);
        }
    }

    @Test
    void rejectsProviderErrors() throws Exception {
        for (int status : new int[] {400, 401, 429, 500}) {
            var sender = new ResendEmailSender(
                "test-key",
                new ObjectMapper(),
                mockClient(status)
            );

            assertThatThrownBy(
                () -> sender.send(message(UUID.randomUUID()))
            ).isInstanceOf(EmailDeliveryException.class)
             .hasMessageContaining("HTTP " + status);
        }
    }

    @Test
    void rejectsMissingApiKey() {
        assertThatThrownBy(
            () -> new ResendEmailSender(
                "",
                new ObjectMapper(),
                mock(HttpClient.class)
            )
        ).isInstanceOf(IllegalStateException.class)
         .hasMessageContaining("OUPAY_RESEND_API_KEY");
    }

    @Test
    void rejectsMissingOutboxId() throws Exception {
        var sender = new ResendEmailSender(
            "test-key",
            new ObjectMapper(),
            mockClient(200)
        );

        assertThatThrownBy(
            () -> sender.send(new EmailMessage(
                "cashier@example.com",
                "noreply@ousuite.com",
                "Invite",
                "Text",
                "<p>HTML</p>"
            ))
        ).isInstanceOf(EmailDeliveryException.class)
         .hasMessageContaining("outbox message ID");
    }
}
