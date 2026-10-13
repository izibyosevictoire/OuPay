package rw.oupay.auth;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.net.URI;
import java.util.Set;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Defence in depth on top of SameSite cookies and the CSRF token: a state-changing browser request whose
 * {@code Origin} header names a different site is refused. The Origin must be the host the request was
 * sent to, or one of the configured allowed origins. Requests without an Origin (non-browser clients)
 * pass this check and still need the CSRF token. The cookie-less public and provider surfaces are exempt.
 */
public class OriginCheckFilter extends OncePerRequestFilter {

    private static final Set<String> SAFE_METHODS = Set.of("GET", "HEAD", "OPTIONS", "TRACE");

    private final Set<String> allowedOrigins;

    public OriginCheckFilter(Set<String> allowedOrigins) {
        this.allowedOrigins = allowedOrigins;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI();
        return SAFE_METHODS.contains(request.getMethod())
                || path.startsWith("/api/v1/public/") || path.startsWith("/api/v1/integrations/");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        String origin = request.getHeader("Origin");
        if (origin != null && !permitted(origin, request)) {
            response.setStatus(403);
            response.setContentType("application/json");
            response.getWriter().write("{\"code\":\"forbidden\",\"message\":\"The request could not be verified or is not allowed.\",\"fields\":[]}");
            return;
        }
        chain.doFilter(request, response);
    }

    private boolean permitted(String origin, HttpServletRequest request) {
        if (allowedOrigins.contains(origin)) {
            return true;
        }
        try {
            URI uri = URI.create(origin);
            String host = request.getHeader("Host");
            if (uri.getHost() == null || host == null) {
                return false;
            }
            String originAuthority = uri.getPort() == -1 ? uri.getHost() : uri.getHost() + ":" + uri.getPort();
            return originAuthority.equalsIgnoreCase(host);
        } catch (IllegalArgumentException e) {
            return false;
        }
    }
}
