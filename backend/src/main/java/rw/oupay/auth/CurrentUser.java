package rw.oupay.auth;

import java.util.Optional;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import rw.oupay.common.ApiException;

/** Access to the signed-in user. Services use this, so authorisation never depends on controllers. */
public final class CurrentUser {

    private CurrentUser() {}

    public static Optional<AuthenticatedUser> find() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication != null && authentication.getPrincipal() instanceof AuthenticatedUser user) {
            return Optional.of(user);
        }
        return Optional.empty();
    }

    public static AuthenticatedUser require() {
        return find().orElseThrow(ApiException::unauthenticated);
    }
}
