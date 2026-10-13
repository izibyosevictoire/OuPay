package rw.oupay.banking;

import jakarta.servlet.http.HttpServletRequest;
import java.util.Collections;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;
import rw.oupay.common.ApiException;
import rw.oupay.ledger.BankEventProcessor;

/**
 * THE TRUSTED INTEGRATION BOUNDARY for provider events.
 *
 * <p>This is the only HTTP entry point that can cause a bank transaction to exist. It is
 * provider-specific and authenticated by the PROVIDER, not by a browser session:
 * <ol>
 *   <li>unknown provider: 404; provider without an adapter (real Equity, MTN, Airtel): 501, because
 *       no integration exists until the bank's documentation and approval are provided;</li>
 *   <li>the adapter must be able to authenticate events, and the event must verify BEFORE it is parsed;
 *       anything else is refused with a generic 401 (no detail about why);</li>
 *   <li>the payload is normalised by the adapter and handed to the idempotent processor.</li>
 * </ol>
 * It is not covered by CSRF (no cookies are involved) and is rate limited per client address.
 */
@RestController
@RequestMapping("/api/v1/integrations")
public class ProviderWebhookController {

    private static final Logger log = LoggerFactory.getLogger(ProviderWebhookController.class);
    private static final int MAX_BODY_CHARS = 64 * 1024;

    private final ProviderRegistry registry;
    private final BankEventProcessor processor;
    private final SimulatedProviderProperties simulatedProperties;

    public ProviderWebhookController(ProviderRegistry registry, BankEventProcessor processor,
                                     SimulatedProviderProperties simulatedProperties) {
        this.registry = registry;
        this.processor = processor;
        this.simulatedProperties = simulatedProperties;
    }

    @PostMapping("/{provider}/events")
    ResponseEntity<Map<String, Object>> receive(@PathVariable String provider, @RequestBody String rawBody, HttpServletRequest request) {
        ProviderId id = resolve(provider);
        var adapter = registry.adapter(id).orElseThrow(() -> ApiException.notImplemented(
                "No integration exists for this provider yet. It needs the bank's documentation and approval."));
        // The simulator is a development tool: when disabled it does not even admit to existing.
        if (adapter.isSimulated() && !simulatedProperties.enabled()) {
            throw ApiException.notFound("Not found.");
        }
        if (rawBody.length() > MAX_BODY_CHARS) {
            throw new ApiException(HttpStatus.CONTENT_TOO_LARGE, "payload_too_large", "The event is too large.");
        }
        if (!(adapter instanceof BankingProviderAdapter.EventAuthenticating authenticating)) {
            // An adapter that cannot authenticate events can never be exposed.
            throw ApiException.notImplemented("This provider cannot authenticate events, so it is not enabled.");
        }
        if (!authenticating.isAuthentic(headersOf(request), rawBody)) {
            log.warn("Rejected an unauthenticated {} event", id);
            throw new ApiException(HttpStatus.UNAUTHORIZED, "unauthenticated", "The event could not be verified.");
        }
        BankingProviderAdapter.NormalizedBankEvent event;
        try {
            event = adapter.normalizeTransactionEvent(rawBody);
        } catch (BankingProviderAdapter.InvalidProviderEventException e) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "invalid_event", e.getMessage());
        }
        var result = processor.process(event, rawBody);
        Map<String, Object> body = new HashMap<>();
        body.put("outcome", result.outcome().name());
        // Duplicates and stale events are successes from the provider's point of view: do not make it retry.
        return ResponseEntity.ok(body);
    }

    private static ProviderId resolve(String slug) {
        return switch (slug.toLowerCase(Locale.ROOT)) {
            case "equity-mock" -> ProviderId.EQUITY_MOCK;
            case "mtn-momo" -> ProviderId.MTN_MOMO;
            case "airtel-money" -> ProviderId.AIRTEL_MONEY;
            // The real Equity Bank integration: not built, not approved, nothing assumed about it.
            case "equity" -> throw ApiException.notImplemented(
                    "Equity Bank Rwanda is not integrated. It needs the bank's documentation and approval.");
            default -> throw ApiException.notFound("Not found.");
        };
    }

    private static Map<String, String> headersOf(HttpServletRequest request) {
        Map<String, String> headers = new HashMap<>();
        for (String name : Collections.list(request.getHeaderNames())) {
            headers.put(name.toLowerCase(Locale.ROOT), request.getHeader(name));
        }
        return headers;
    }
}
