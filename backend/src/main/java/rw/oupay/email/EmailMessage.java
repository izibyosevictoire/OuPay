package rw.oupay.email;

import java.util.UUID;

/**
 * A rendered email ready for delivery.
 *
 * messageId identifies the original outbox record and remains
 * stable across delivery retries.
 */
public record EmailMessage(
        UUID messageId,
        String to,
        String from,
        String subject,
        String text,
        String html
) {
    // Preserve compatibility with existing SMTP and test callers.
    public EmailMessage(
            String to,
            String from,
            String subject,
            String text,
            String html
    ) {
        this(null, to, from, subject, text, html);
    }
}
