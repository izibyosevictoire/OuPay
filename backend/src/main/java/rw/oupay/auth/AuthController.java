package rw.oupay.auth;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import java.time.Duration;
import java.time.Instant;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.ResponseStatus;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    private final AuthService auth;
    private final AccountRecoveryService recovery;
    private final SecurityProperties properties;
    private final ClientIpResolver clientIps;

    public AuthController(AuthService auth, AccountRecoveryService recovery, SecurityProperties properties, ClientIpResolver clientIps) {
        this.auth = auth;
        this.recovery = recovery;
        this.properties = properties;
        this.clientIps = clientIps;
    }

    @PostMapping("/register")
    ResponseEntity<AuthDtos.SessionDto> register(@Valid @RequestBody AuthDtos.RegisterRequest body, HttpServletRequest request) {
        var result = auth.register(body, clientIps.resolve(request), request.getHeader(HttpHeaders.USER_AGENT));
        return signedIn(result);
    }

    @PostMapping("/login")
    ResponseEntity<AuthDtos.SessionDto> login(@Valid @RequestBody AuthDtos.LoginRequest body, HttpServletRequest request) {
        var result = auth.login(body, clientIps.resolve(request), request.getHeader(HttpHeaders.USER_AGENT));
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

    // ---- Password reset (public): answers are identical whether or not the account exists. ----

    /** Always 204. Whether anything was sent is invisible, so this cannot be used to probe for accounts. */
    @PostMapping("/password-reset/request")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void requestReset(@Valid @RequestBody AuthDtos.PasswordResetRequest body, HttpServletRequest request) {
        recovery.requestPasswordReset(body.email(), clientIps.resolve(request));
    }

    /** POST with a body, not GET: the token must not end up in a URL, an access log or a Referer header. */
    @PostMapping("/password-reset/verify")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void verifyReset(@Valid @RequestBody AuthDtos.TokenRequest body) {
        recovery.verifyPasswordResetToken(body.token());
    }

    @PostMapping("/password-reset/confirm")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void confirmReset(@Valid @RequestBody AuthDtos.PasswordResetConfirm body) {
        recovery.resetPassword(body.token(), body.newPassword());
    }

    // ---- Signed-in account security ----

    @PostMapping("/password/change")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void changePassword(@Valid @RequestBody AuthDtos.ChangePasswordRequest body) {
        recovery.changePassword(CurrentUser.require(), body.currentPassword(), body.newPassword());
    }

    /** Sends a fresh verification link (rate limited per account). 204 whether or not one was needed. */
    @PostMapping("/email-verification/request")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void requestEmailVerification(HttpServletRequest request) {
        recovery.sendEmailVerification(CurrentUser.require().userId(), clientIps.resolve(request));
    }

    /** Public: the link itself is the credential. */
    @PostMapping("/email-verification/confirm")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    void confirmEmailVerification(@Valid @RequestBody AuthDtos.TokenRequest body) {
        recovery.confirmEmailVerification(body.token());
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
