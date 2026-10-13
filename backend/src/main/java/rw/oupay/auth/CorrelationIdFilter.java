package rw.oupay.auth;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.UUID;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;
import org.springframework.web.servlet.HandlerMapping;

/**
 * Gives every request a correlation id (the caller's {@code X-Request-Id} if it is well formed, otherwise a
 * new one), puts it in the logging context so every log line of the request carries it, and returns it in
 * the response header so a user report can be matched to the logs. Runs before everything else, so even
 * rejected requests (401, 429) have one.
 *
 * <p>The access log line records the route PATTERN ({@code /api/v1/public/invitations/{token}}), never the
 * concrete URL, because URLs can carry tokens. Query strings are never logged.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class CorrelationIdFilter extends OncePerRequestFilter {

    public static final String HEADER = "X-Request-Id";
    public static final String MDC_KEY = "correlationId";

    private static final Pattern ACCEPTABLE = Pattern.compile("^[A-Za-z0-9._-]{8,64}$");
    private static final Logger access = LoggerFactory.getLogger("rw.oupay.access");

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String supplied = request.getHeader(HEADER);
        String id = supplied != null && ACCEPTABLE.matcher(supplied).matches() ? supplied : UUID.randomUUID().toString();
        MDC.put(MDC_KEY, id);
        response.setHeader(HEADER, id);
        long started = System.nanoTime();
        try {
            chain.doFilter(request, response);
        } finally {
            if (!request.getRequestURI().startsWith("/actuator/")) {
                Object pattern = request.getAttribute(HandlerMapping.BEST_MATCHING_PATTERN_ATTRIBUTE);
                access.info("request method={} route={} status={} durationMs={}", request.getMethod(),
                        pattern == null ? "unmatched" : pattern, response.getStatus(), (System.nanoTime() - started) / 1_000_000);
            }
            MDC.clear();
        }
    }
}
