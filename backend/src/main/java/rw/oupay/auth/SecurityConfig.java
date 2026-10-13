package rw.oupay.auth;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.time.Clock;
import java.util.function.Supplier;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.Customizer;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;
import org.springframework.security.web.csrf.CookieCsrfTokenRepository;
import org.springframework.security.web.csrf.CsrfToken;
import org.springframework.security.web.csrf.CsrfTokenRequestAttributeHandler;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Browser sessions use an opaque HttpOnly cookie plus a double-submit CSRF token (readable
 * XSRF-TOKEN cookie echoed in the X-XSRF-TOKEN header). The public payment API and the provider
 * webhook boundary use no cookies, so they are exempt from CSRF; they have their own controls
 * (rate limiting, input validation, and signature verification respectively).
 */
@Configuration

public class SecurityConfig {

    @Bean
    SecurityFilterChain filterChain(HttpSecurity http, SessionService sessions, SecurityProperties properties,
                                    Clock clock, ClientIpResolver clientIps, io.micrometer.core.instrument.MeterRegistry meters,
                                    @Value("${oupay.rate-limit.public-read-per-minute:120}") int publicRead,
                                    @Value("${oupay.rate-limit.public-write-per-minute:20}") int publicWrite,
                                    @Value("${oupay.rate-limit.auth-per-minute:20}") int auth,
                                    @Value("${oupay.rate-limit.recovery-per-minute:10}") int recovery,
                                    @Value("${oupay.rate-limit.webhook-per-minute:600}") int webhook) throws Exception {
        CookieCsrfTokenRepository csrfRepository = CookieCsrfTokenRepository.withHttpOnlyFalse();
        csrfRepository.setCookieCustomizer(cookie -> cookie.secure(properties.session().secureCookie()).sameSite("Lax"));
        CsrfTokenRequestAttributeHandler csrfHandler = new CsrfTokenRequestAttributeHandler();

        http
                .csrf(csrf -> csrf
                        .csrfTokenRepository(csrfRepository)
                        .csrfTokenRequestHandler(csrfHandler)
                        .ignoringRequestMatchers("/api/v1/public/**", "/api/v1/integrations/**"))
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .httpBasic(AbstractHttpConfigurer::disable)
                .formLogin(AbstractHttpConfigurer::disable)
                .logout(AbstractHttpConfigurer::disable)
                .headers(h -> h
                        .contentSecurityPolicy(csp -> csp.policyDirectives("default-src 'none'; frame-ancestors 'none'"))
                        .referrerPolicy(r -> r.policy(org.springframework.security.web.header.writers.ReferrerPolicyHeaderWriter.ReferrerPolicy.NO_REFERRER))
                        .permissionsPolicyHeader(p -> p.policy("camera=(), microphone=(), geolocation=(), payment=()"))
                        .httpStrictTransportSecurity(hsts -> {
                            if (properties.session().secureCookie()) {
                                // Production sits behind TLS termination, so the request may look like plain http to us.
                                hsts.maxAgeInSeconds(31_536_000).includeSubDomains(true)
                                        .requestMatcher(org.springframework.security.web.util.matcher.AnyRequestMatcher.INSTANCE);
                            }
                        }))
                .authorizeHttpRequests(a -> a
                        .requestMatchers("/api/v1/public/**", "/api/v1/integrations/**",
                                "/api/v1/auth/login", "/api/v1/auth/register", "/api/v1/auth/session", "/api/v1/auth/password-reset/**",
                                "/api/v1/auth/email-verification/confirm", "/api/v1/dev/mail",
                                "/actuator/health", "/actuator/health/**").permitAll()
                        .requestMatchers("/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html").permitAll()
                        .anyRequest().authenticated())
                .exceptionHandling(e -> e
                        .authenticationEntryPoint((request, response, ex) ->
                                writeError(response, 401, "unauthenticated", "Please sign in to continue."))
                        .accessDeniedHandler((request, response, ex) ->
                                writeError(response, 403, "forbidden", "The request could not be verified or is not allowed.")))
                .addFilterBefore(new RateLimitFilter(new RateLimitFilter.Limits(publicRead, publicWrite, auth, recovery, webhook), clientIps, meters, clock),
                        UsernamePasswordAuthenticationFilter.class)
                .addFilterBefore(new OriginCheckFilter(java.util.Set.copyOf(properties.origins().allowed())),
                        UsernamePasswordAuthenticationFilter.class)
                .addFilterBefore(new SessionAuthenticationFilter(sessions, properties.session().cookieName()),
                        UsernamePasswordAuthenticationFilter.class)
                .addFilterAfter(new CsrfCookieFilter(), org.springframework.security.web.csrf.CsrfFilter.class);
        return http.build();
    }

    private static void writeError(HttpServletResponse response, int status, String code, String message) throws IOException {
        response.setStatus(status);
        response.setContentType("application/json");
        response.getWriter().write("{\"code\":\"" + code + "\",\"message\":\"" + message + "\",\"fields\":[]}");
    }

    /** Spring defers creating the CSRF cookie; touching the token makes every response carry it. */
    static final class CsrfCookieFilter extends OncePerRequestFilter {
        /** Cookie-less surfaces (public pages, provider webhooks) never receive any cookie at all. */
        @Override
        protected boolean shouldNotFilter(HttpServletRequest request) {
            String path = request.getRequestURI();
            return path.startsWith("/api/v1/public/") || path.startsWith("/api/v1/integrations/");
        }

        @Override
        protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                        jakarta.servlet.FilterChain chain) throws jakarta.servlet.ServletException, IOException {
            Object attribute = request.getAttribute(CsrfToken.class.getName());
            if (attribute instanceof CsrfToken token) {
                token.getToken();
            } else if (attribute instanceof Supplier<?> supplier && supplier.get() instanceof CsrfToken token) {
                token.getToken();
            }
            chain.doFilter(request, response);
        }
    }
}
