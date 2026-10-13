package rw.oupay.auth;

import io.micrometer.core.instrument.MeterRegistry;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Clock;
import java.util.concurrent.ConcurrentHashMap;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * A fixed-window, per-client-address limiter for the surfaces an anonymous caller (or a credential
 * guesser) can reach: public payment pages and invitation links, sign-in and registration, the account
 * recovery endpoints, and provider webhooks. Each surface has its own bucket, so a flood on one cannot
 * lock people out of another.
 *
 * <p>The client address comes from {@link ClientIpResolver}: forwarded headers are believed only from
 * configured trusted proxies, so a caller cannot dodge the limit by inventing {@code X-Forwarded-For}.
 *
 * <p>LIMITATION: counters live in this process. Behind several instances each has its own window, so the
 * effective limit is multiplied by the instance count. Production should ALSO rate limit at the edge
 * (gateway/WAF) or use a shared store. Per-account protections (login lockout, reset-link budget) live in
 * the database and are exact across instances.
 */
public class RateLimitFilter extends OncePerRequestFilter {

    public record Limits(int publicReadPerMinute, int publicWritePerMinute, int authPerMinute, int recoveryPerMinute,
                         int webhookPerMinute) {}

    private record Window(long startedAtSecond, int count) {}

    private static final Logger log = LoggerFactory.getLogger(RateLimitFilter.class);
    private static final long WINDOW_SECONDS = 60;
    private static final int SOFT_CAP = 50_000;
    private static final int HARD_CAP = 250_000;

    private final Limits limits;
    private final ClientIpResolver clientIps;
    private final MeterRegistry meters;
    private final Clock clock;
    private final ConcurrentHashMap<String, Window> windows = new ConcurrentHashMap<>();

    public RateLimitFilter(Limits limits, ClientIpResolver clientIps, MeterRegistry meters, Clock clock) {
        this.limits = limits;
        this.clientIps = clientIps;
        this.meters = meters;
        this.clock = clock;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String path = request.getRequestURI();
        boolean write = !"GET".equals(request.getMethod()) && !"HEAD".equals(request.getMethod());
        String bucket;
        int limit;
        if (path.startsWith("/api/v1/public/")) {
            bucket = write ? "public-write" : "public-read";
            limit = write ? limits.publicWritePerMinute() : limits.publicReadPerMinute();
        } else if (path.equals("/api/v1/auth/login") || path.equals("/api/v1/auth/register")) {
            bucket = "auth";
            limit = limits.authPerMinute();
        } else if (path.startsWith("/api/v1/auth/password-reset/") || path.startsWith("/api/v1/auth/email-verification/")
                || path.equals("/api/v1/auth/password/change") || path.startsWith("/api/v1/invitations/")) {
            bucket = "recovery";
            limit = limits.recoveryPerMinute();
        } else if (path.startsWith("/api/v1/integrations/")) {
            bucket = "webhook";
            limit = limits.webhookPerMinute();
        } else {
            chain.doFilter(request, response);
            return;
        }

        long now = clock.instant().getEpochSecond();
        String client = clientIps.resolve(request);
        String key = bucket + "|" + client;
        Window window = windows.compute(key, (k, w) ->
                (w == null || now - w.startedAtSecond() >= WINDOW_SECONDS) ? new Window(now, 1) : new Window(w.startedAtSecond(), w.count() + 1));
        if (windows.size() > SOFT_CAP) {
            windows.entrySet().removeIf(e -> now - e.getValue().startedAtSecond() >= WINDOW_SECONDS);
            if (windows.size() > HARD_CAP) {
                windows.clear(); // a flood of distinct addresses: bounded memory beats perfect accounting
            }
        }
        if (window.count() > limit) {
            long retryAfter = Math.max(1, WINDOW_SECONDS - (now - window.startedAtSecond()));
            if (window.count() == limit + 1) {
                log.warn("rate limit reached bucket={} client={}", bucket, client);
            }
            meters.counter("oupay.rate_limited", "bucket", bucket).increment();
            response.setStatus(429);
            response.setHeader("Retry-After", Long.toString(retryAfter));
            response.setContentType("application/json");
            response.getWriter().write("{\"code\":\"rate_limited\",\"message\":\"Too many requests. Please slow down.\",\"fields\":[]}");
            return;
        }
        chain.doFilter(request, response);
    }
}
