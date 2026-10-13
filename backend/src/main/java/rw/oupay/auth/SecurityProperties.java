package rw.oupay.auth;

import java.time.Duration;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/** Tunable security settings. Defaults are conservative; production sets secure-cookie=true. */
@ConfigurationProperties("oupay.security")
public record SecurityProperties(
        @DefaultValue Session session,
        @DefaultValue Login login) {

    public record Session(
            @DefaultValue("oupay_session") String cookieName,
            /** Must be true in production: the cookie is then only ever sent over HTTPS. */
            @DefaultValue("true") boolean secureCookie,
            @DefaultValue("Lax") String sameSite,
            @DefaultValue("30m") Duration idleTimeout,
            @DefaultValue("12h") Duration absoluteTimeout,
            @DefaultValue("7d") Duration rememberIdleTimeout,
            @DefaultValue("30d") Duration rememberAbsoluteTimeout) {}

    public record Login(
            @DefaultValue("5") int maxFailedAttempts,
            @DefaultValue("15m") Duration lockoutDuration) {}
}
