package rw.oupay.email;

import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedDeque;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.stereotype.Component;
import rw.oupay.common.Masking;

/**
 * Local development mail sink: nothing leaves the machine. Messages are kept in memory (the last 200)
 * so a developer or a test can read the link in them. The log line carries the subject only, never the
 * body, because the body holds a one-time link.
 */
@Component
@ConditionalOnProperty(prefix = "oupay.email", name = "provider", havingValue = "sink", matchIfMissing = true)
public class DevMailSink implements EmailSender {

    private static final Logger log = LoggerFactory.getLogger(DevMailSink.class);
    private static final int CAPACITY = 200;

    private final ConcurrentLinkedDeque<EmailMessage> messages = new ConcurrentLinkedDeque<>();

    @Override
    public void send(EmailMessage message) {
        messages.addLast(message);
        while (messages.size() > CAPACITY) {
            messages.pollFirst();
        }
        log.info("mail sink captured a message to {} with subject '{}'", Masking.email(message.to()), message.subject());
    }

    public List<EmailMessage> messages() {
        return new ArrayList<>(messages);
    }

    public void clear() {
        messages.clear();
    }
}
