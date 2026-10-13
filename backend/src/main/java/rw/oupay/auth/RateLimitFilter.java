package rw.oupay.auth;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Clock;
import java.util.concurrent.ConcurrentHashMap;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * A simple fixed-window, per-client-IP limiter for the unauthenticated surface (public payment
 * pages, login, registration, provider webhooks).
 *
 * <p>LIMITATION: counters live in this process. Behind several instances each has its own window,
 * and behind a proxy the client IP is only right if forwarded headers are trusted correctly.
 * A production deployment should also rate limit at the edge (gateway/WAF) or use a shared store.
 */
public class RateLimitFilter extends OncePerRequestFilter {

    public record Limits(int publicReadPerMinute, int publicWritePerMinute, int authPerMinute, int webhookPerMinute) {}

    private record Window(long startedAtSecond, int count) {}

    private static final long WINDOW_SECONDS = 60;

    private final Limits limits;
    private final Clock clock;
    private final ConcurrentHashMap<String, Window> windows = new ConcurrentHashMap<>();

    public RateLimitFilter(Limits limits, Clock clock) {
        this.limits = limits;
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
        } else if (path.startsWith("/api/v1/integrations/")) {
            bucket = "webhook";
            limit = limits.webhookPerMinute();
        } else {
            chain.doFilter(request, response);
            return;
        }

        long now = clock.instant().getEpochSecond();
        String key = bucket + "|" + request.getRemoteAddr();
        Window window = windows.compute(key, (k, w) ->
                (w == null || now - w.startedAtSecond() >= WINDOW_SECONDS) ? new Window(now, 1) : new Window(w.startedAtSecond(), w.count() + 1));
        if (windows.size() > 50_000) {
            windows.entrySet().removeIf(e -> now - e.getValue().startedAtSecond() >= WINDOW_SECONDS);
        }
        if (window.count() > limit) {
            long retryAfter = Math.max(1, WINDOW_SECONDS - (now - window.startedAtSecond()));
            response.setStatus(429);
            response.setHeader("Retry-After", Long.toString(retryAfter));
            response.setContentType("application/json");
            response.getWriter().write("{\"code\":\"rate_limited\",\"message\":\"Too many requests. Please slow down.\",\"fields\":[]}");
            return;
        }
        chain.doFilter(request, response);
    }
}
