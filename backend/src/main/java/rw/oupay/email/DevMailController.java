package rw.oupay.email;

import java.util.List;
import org.springframework.boot.autoconfigure.condition.ConditionalOnBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Development only (the property is false everywhere else): lets a developer read the sink's messages. */
@RestController
@RequestMapping("/api/v1/dev/mail")
@ConditionalOnBean(DevMailSink.class)
@ConditionalOnProperty(prefix = "oupay.email", name = "sink-endpoint-enabled", havingValue = "true")
public class DevMailController {

    private final DevMailSink sink;

    public DevMailController(DevMailSink sink) {
        this.sink = sink;
    }

    @GetMapping
    List<EmailMessage> list() {
        return sink.messages();
    }
}
