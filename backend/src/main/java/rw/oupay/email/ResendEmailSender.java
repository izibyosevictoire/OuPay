package rw.oupay.email;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Map;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;

import tools.jackson.databind.ObjectMapper;

/**
 * Delivers OuPay transactional emails using Resend's HTTPS API.
 */
@Component
@ConditionalOnProperty(
    prefix = "oupay.email",
    name = "provider",
    havingValue = "resend"
)
public class ResendEmailSender implements EmailSender {

    private static final URI ENDPOINT =
        URI.create("https://api.resend.com/emails");

    private final HttpClient client;
    private final ObjectMapper mapper;
    private final String apiKey;

    @Autowired
    public ResendEmailSender(
        @Value("${OUPAY_RESEND_API_KEY:}") String apiKey,
        ObjectMapper mapper
    ) {
        this(
            apiKey,
            mapper,
            HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(10))
                .build()
        );
    }

    ResendEmailSender(
        String apiKey,
        ObjectMapper mapper,
        HttpClient client
    ) {
        if (apiKey == null || apiKey.isBlank()) {
            throw new IllegalStateException(
                "OUPAY_RESEND_API_KEY must be configured"
            );
        }
        this.apiKey = apiKey;
        this.mapper = mapper;
        this.client = client;
    }

    @Override
    public void send(EmailMessage message)
        throws EmailDeliveryException {

        if (message.messageId() == null) {
            throw new EmailDeliveryException(
                "Resend delivery requires an outbox message ID",
                null
            );
        }

        try {
            Map<String, Object> payload = Map.of(
                "from", message.from(),
                "to", new String[]{message.to()},
                "subject", message.subject(),
                "text", message.text(),
                "html", message.html()
            );

            String json = mapper.writeValueAsString(payload);

            HttpRequest request = HttpRequest.newBuilder()
                .uri(ENDPOINT)
                .timeout(Duration.ofSeconds(20))
                .header("Authorization", "Bearer " + apiKey)
                .header("Content-Type", "application/json")
                .header(
                    "Idempotency-Key",
                    "oupay-email/" + message.messageId()
                )
                .POST(HttpRequest.BodyPublishers.ofString(
                    json,
                    StandardCharsets.UTF_8
                ))
                .build();

            HttpResponse<String> response = client.send(
                request,
                HttpResponse.BodyHandlers.ofString()
            );

            int status = response.statusCode();

            if (status < 200 || status >= 300) {
                throw new EmailDeliveryException(
                    "Resend API rejected email, HTTP " + status,
                    null
                );
            }

        } catch (EmailDeliveryException exception) {
            throw exception;

        } catch (InterruptedException exception) {
            Thread.currentThread().interrupt();

            throw new EmailDeliveryException(
                "Resend request interrupted",
                exception
            );

        } catch (Exception exception) {
            throw new EmailDeliveryException(
                "Resend API request failed",
                exception
            );
        }
    }
}
