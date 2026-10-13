package rw.oupay.email;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/**
 * E-mail settings. {@code provider} is {@code sink} (development: messages are kept in memory) or
 * {@code smtp} (production: needs the standard {@code spring.mail.*} settings).
 */
@ConfigurationProperties("oupay.email")
public record EmailProperties(
        @DefaultValue("sink") String provider,
        @DefaultValue("OuPay <no-reply@oupay.rw>") String from,
        /** Exposes GET /api/v1/dev/mail so a developer can read the messages the sink captured. Never in production. */
        @DefaultValue("false") boolean sinkEndpointEnabled,
        @DefaultValue Dispatcher dispatcher) {

    public record Dispatcher(
            @DefaultValue("true") boolean enabled,
            @DefaultValue("5s") Duration pollInterval,
            @DefaultValue("20") int batchSize,
            @DefaultValue("8") int maxAttempts,
            @DefaultValue("30s") Duration baseBackoff,
            @DefaultValue("1h") Duration maxBackoff,
            /** A message claimed longer ago than this (a crashed dispatcher) is picked up again. */
            @DefaultValue("2m") Duration lease) {}
}
