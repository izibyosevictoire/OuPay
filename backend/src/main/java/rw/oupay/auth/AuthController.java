package rw.oupay.auth;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.time.Duration;
import java.time.Instant;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    private final AuthService auth;
    private final SecurityProperties properties;

    public AuthController(AuthService auth, SecurityProperties properties) {
        this.auth = auth;
        this.properties = properties;
    }

    @PostMapping("/register")
    ResponseEntity<AuthDtos.SessionDto> register(@Valid @RequestBody AuthDtos.RegisterRequest body, HttpServletRequest request) {
        var result = auth.register(body, request.getRemoteAddr(), request.getHeader(HttpHeaders.USER_AGENT));
        return signedIn(result);
    }

    @PostMapping("/login")
    ResponseEntity<AuthDtos.SessionDto> login(@Valid @RequestBody AuthDtos.LoginRequest body, HttpServletRequest request) {
        var result = auth.login(body, request.getRemoteAddr(), request.getHeader(HttpHeaders.USER_AGENT));
        return signedIn(result);
    }

    /** 204 when signed out, so the client can treat "no session" as a normal answer. */
    @GetMapping("/session")
    ResponseEntity<AuthDtos.SessionDto> session() {
        return auth.currentSession().map(ResponseEntity::ok).orElseGet(() -> ResponseEntity.noContent().build());
    }

    @PostMapping("/logout")
    ResponseEntity<Void> logout() {
        CurrentUser.find().ifPresent(auth::logout);
        // Overwrite the cookie so the browser drops it, whether or not a session existed.
        return ResponseEntity.noContent()
                .header(HttpHeaders.SET_COOKIE, cookie("", Duration.ZERO).toString())
                .build();
    }

    // ---- Password reset: contract only (needs an email channel and single-use expiring tokens). ----

    @PostMapping("/password-reset/request")
    void requestReset() {
        throw rw.oupay.common.ApiException.notImplemented("Password reset is not implemented yet (needs an email channel).");
    }

    @GetMapping("/password-reset/verify")
    void verifyReset() {
        throw rw.oupay.common.ApiException.notImplemented("Password reset is not implemented yet (needs an email channel).");
    }

    @PostMapping("/password-reset/confirm")
    void confirmReset() {
        throw rw.oupay.common.ApiException.notImplemented("Password reset is not implemented yet (needs an email channel).");
    }

    private ResponseEntity<AuthDtos.SessionDto> signedIn(AuthService.SignedIn result) {
        var session = result.issued().session();
        // A "remember me" cookie persists; otherwise it is a browser-session cookie.
        Duration maxAge = session.isRememberMe()
                ? Duration.between(Instant.now(), session.getAbsoluteExpiresAt())
                : null;
        return ResponseEntity.ok()
                .header(HttpHeaders.SET_COOKIE, cookie(result.issued().rawToken(), maxAge).toString())
                .body(result.session());
    }

    private ResponseCookie cookie(String value, Duration maxAge) {
        var cfg = properties.session();
        ResponseCookie.ResponseCookieBuilder builder = ResponseCookie.from(cfg.cookieName(), value)
                .httpOnly(true)
                .secure(cfg.secureCookie())
                .sameSite(cfg.sameSite())
                .path("/");
        if (maxAge != null) {
            builder.maxAge(maxAge);
        }
        return builder.build();
    }
}
