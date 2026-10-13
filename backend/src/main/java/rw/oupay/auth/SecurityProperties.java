package rw.oupay.auth;

import java.time.Duration;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/** Tunable security settings. Defaults are conservative; production sets secure-cookie=true. */
@ConfigurationProperties("oupay.security")
public record SecurityProperties(
        @DefaultValue Session session,
        @DefaultValue Login login,
        @DefaultValue Recovery recovery,
        @DefaultValue Proxy proxy,
        @DefaultValue Origins origins) {

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

    /** Lifetimes of the single-use links that are e-mailed, and how often one may be requested. */
    public record Recovery(
            @DefaultValue("1h") Duration passwordResetTtl,
            @DefaultValue("48h") Duration emailVerificationTtl,
            @DefaultValue("7d") Duration invitationTtl,
            /** Per account and purpose: further requests inside the hour are answered the same but send nothing. */
            @DefaultValue("3") int maxLinksPerHour) {}

    /**
     * Reverse proxies whose X-Forwarded-For header is believed (exact IPs or CIDR ranges). Empty means the
     * header is ignored entirely, which is the only safe choice when the application is exposed directly.
     */
    public record Proxy(@DefaultValue List<String> trusted) {}

    /** Extra browser origins allowed to make state-changing calls (same-host requests are always allowed). */
    public record Origins(@DefaultValue List<String> allowed) {}
}
