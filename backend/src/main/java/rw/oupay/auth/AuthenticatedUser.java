package rw.oupay.auth;

import java.util.UUID;

/** The principal placed in the security context after a valid session cookie. */
public record AuthenticatedUser(UUID userId, UUID sessionId) {}
