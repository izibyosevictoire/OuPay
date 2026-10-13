package rw.oupay.support;

import java.time.Instant;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.springframework.http.HttpMethod;
import org.springframework.test.web.servlet.MockMvc;
import rw.oupay.banking.SimulatedProviderAdapter;
import tools.jackson.databind.json.JsonMapper;

/**
 * Plays the role of the (simulated) bank: it links an account for a business through the real API,
 * then delivers signed events to the real provider-specific webhook endpoint, exactly as a provider
 * would. It uses no cookies and no session: the only credential is the signature.
 */
public class Bank {

    public static final String SECRET = "test-simulator-secret";
    private static final JsonMapper JSON = JsonMapper.builder().build();
    private static final AtomicInteger COUNTER = new AtomicInteger();

    private final MockMvc mvc;
    public final String accountId;

    public Bank(MockMvc mvc, String accountId) {
        this.mvc = mvc;
        this.accountId = accountId;
    }

    /** Links and completes a demo account for the business (owner session required). */
    public static Bank link(MockMvc mvc, TestApi owner, UUID merchantId) {
        var started = owner.post("/api/v1/merchants/" + merchantId + "/bank-connections",
                Map.of("providerId", "EQUITY_MOCK", "accountReference", "SIM-" + (1000 + COUNTER.incrementAndGet()), "accountNickname", "Main account"));
        if (started.status() != 200) {
            throw new IllegalStateException("link failed: " + started.body());
        }
        String connectionId = started.json().path("id").asString();
        var completed = owner.post("/api/v1/merchants/" + merchantId + "/bank-connections/" + connectionId + "/complete", null);
        if (completed.status() != 200) {
            throw new IllegalStateException("complete failed: " + completed.body());
        }
        return new Bank(mvc, started.json().path("bankAccountId").asString());
    }

    public static String body(String accountId, String state, long amount, String reference, String transactionId, String eventId, Instant occurredAt) {
        Map<String, Object> event = new java.util.LinkedHashMap<>();
        event.put("simulated", true);
        event.put("eventId", eventId);
        event.put("transactionId", transactionId);
        event.put("state", state);
        event.put("amount", amount);
        event.put("currency", "RWF");
        if (reference != null) {
            event.put("reference", reference);
        }
        event.put("payerName", "Test Payer");
        event.put("occurredAt", occurredAt.toString());
        event.put("accountRef", accountId);
        return JSON.writeValueAsString(event);
    }

    public record Delivery(TestApi.Response response, String transactionId) {
        public String outcome() {
            return response.json().path("outcome").asString("");
        }
    }

    /** Delivers a signed event with the given (provider-side) ids and time. */
    public Delivery send(String state, long amount, String reference, String transactionId, String eventId, Instant occurredAt) {
        String raw = body(accountId, state, amount, reference, transactionId, eventId, occurredAt);
        return new Delivery(post(raw, SimulatedProviderAdapter.sign(SECRET, raw)), transactionId);
    }

    private final AtomicInteger sequence = new AtomicInteger();
    private static final Instant BASE = Instant.parse("2026-10-12T10:00:00Z");

    /** A fresh transaction: new transaction id, new event id, strictly increasing time. */
    public Delivery pay(String state, long amount, String reference) {
        int n = COUNTER.incrementAndGet();
        return send(state, amount, reference, "tx-" + n, "evt-" + n, BASE.plusSeconds(sequence.incrementAndGet()));
    }

    /** A later event about an existing transaction. */
    public Delivery update(String transactionId, String state, long amount, String reference) {
        int n = COUNTER.incrementAndGet();
        return send(state, amount, reference, transactionId, "evt-" + n, BASE.plusSeconds(sequence.incrementAndGet()));
    }

    public TestApi.Response post(String raw, String signature) {
        Map<String, String> headers = signature == null ? Map.of() : Map.of(SimulatedProviderAdapter.SIGNATURE_HEADER, signature);
        return TestApi.anonymous(mvc, HttpMethod.POST, "/api/v1/integrations/equity-mock/events", raw, headers);
    }

    public Instant at(int seconds) {
        return BASE.plusSeconds(seconds);
    }
}
