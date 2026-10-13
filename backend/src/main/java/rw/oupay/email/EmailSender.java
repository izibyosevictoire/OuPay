package rw.oupay.email;

/**
 * Provider-independent way to deliver one message. Implementations: {@link SmtpEmailSender} for real
 * delivery and {@link DevMailSink} for local development. Nothing else in the application talks to a
 * mail provider; business code only ever writes to the outbox.
 */
public interface EmailSender {

    void send(EmailMessage message) throws EmailDeliveryException;
}
