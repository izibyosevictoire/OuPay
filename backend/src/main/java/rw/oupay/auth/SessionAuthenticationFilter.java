package rw.oupay.auth;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.List;
import org.slf4j.MDC;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

/** Turns a valid session cookie into an authenticated principal. Anything else stays anonymous. */
public class SessionAuthenticationFilter extends OncePerRequestFilter {

    private final SessionService sessions;
    private final String cookieName;

    public SessionAuthenticationFilter(SessionService sessions, String cookieName) {
        this.sessions = sessions;
        this.cookieName = cookieName;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        Cookie[] cookies = request.getCookies();
        if (cookies != null) {
            for (Cookie cookie : cookies) {
                if (cookieName.equals(cookie.getName())) {
                    sessions.authenticate(cookie.getValue()).ifPresent(principal -> {
                        var authentication = UsernamePasswordAuthenticationToken.authenticated(principal, null, List.of());
                        SecurityContextHolder.getContext().setAuthentication(authentication);
                        MDC.put("userId", principal.userId().toString());
                    });
                    break;
                }
            }
        }
        chain.doFilter(request, response);
    }
}
