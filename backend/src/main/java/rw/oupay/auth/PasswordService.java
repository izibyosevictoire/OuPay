package rw.oupay.auth;

import java.util.Map;
import org.springframework.security.crypto.argon2.Argon2PasswordEncoder;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.DelegatingPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import rw.oupay.common.ApiException;

/**
 * Password hashing with Argon2id (memory-hard, the current OWASP first choice). Hashes carry their
 * algorithm id, so parameters can be raised later and old hashes upgraded on next login.
 */
@Service
public class PasswordService {

    static final int MIN_LENGTH = 8;
    static final int MAX_LENGTH = 128;
    private static final String CURRENT = "argon2";

    private final PasswordEncoder encoder = new DelegatingPasswordEncoder(CURRENT, Map.of(
            CURRENT, Argon2PasswordEncoder.defaultsForSpringSecurity_v5_8(),
            "bcrypt", new BCryptPasswordEncoder(12)));

    /** Hash of a random value, used to spend equal time when the account does not exist. */
    private final String dummyHash = encoder.encode("not-a-real-password-" + System.nanoTime());

    public String hash(String rawPassword) {
        return encoder.encode(rawPassword);
    }

    public boolean matches(String rawPassword, String hash) {
        if (hash == null) {
            // An invited placeholder has no password: spend the same time as a real check.
            burnTime(rawPassword);
            return false;
        }
        return encoder.matches(rawPassword, hash);
    }

    /** Equalises response time for unknown accounts, so login cannot be used to probe for emails. */
    public void burnTime(String rawPassword) {
        encoder.matches(rawPassword, dummyHash);
    }

    public boolean needsUpgrade(String hash) {
        return encoder.upgradeEncoding(hash);
    }

    public void validatePolicy(String rawPassword, String email) {
        if (rawPassword == null || rawPassword.length() < MIN_LENGTH) {
            throw ApiException.validation("The password must be at least " + MIN_LENGTH + " characters.");
        }
        if (rawPassword.length() > MAX_LENGTH) {
            throw ApiException.validation("The password is too long.");
        }
        boolean hasLetter = rawPassword.chars().anyMatch(Character::isLetter);
        boolean hasDigit = rawPassword.chars().anyMatch(Character::isDigit);
        if (!hasLetter || !hasDigit) {
            throw ApiException.validation("The password needs at least one letter and one number.");
        }
        if (email != null && rawPassword.equalsIgnoreCase(email)) {
            throw ApiException.validation("The password must not be your email address.");
        }
    }
}
