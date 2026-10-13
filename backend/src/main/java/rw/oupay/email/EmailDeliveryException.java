package rw.oupay.email;

/** A provider could not deliver a message. The outbox retries these. */
public class EmailDeliveryException extends Exception {

    public EmailDeliveryException(String message, Throwable cause) {
        super(message, cause);
    }
}
