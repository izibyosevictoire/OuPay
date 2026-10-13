package rw.oupay.banking;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/** The simulated provider is OFF unless explicitly enabled, and it has no default secret. */
@ConfigurationProperties("oupay.integrations.simulated")
public record SimulatedProviderProperties(@DefaultValue("false") boolean enabled, @DefaultValue("") String sharedSecret) {}
