package rw.oupay.banking;

import java.util.EnumMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.springframework.stereotype.Component;

/** Finds the adapter for a provider. Providers without an adapter are placeholders. */
@Component
public class ProviderRegistry {

    public record Description(ProviderId id, String displayName, boolean simulated, boolean available) {}

    private final Map<ProviderId, BankingProviderAdapter> adapters = new EnumMap<>(ProviderId.class);

    public ProviderRegistry(List<BankingProviderAdapter> all) {
        all.forEach(a -> adapters.put(a.providerId(), a));
    }

    public Optional<BankingProviderAdapter> adapter(ProviderId id) {
        return Optional.ofNullable(adapters.get(id));
    }

    public List<Description> descriptions() {
        return List.of(
                describe(ProviderId.EQUITY_MOCK, "Equity Bank (simulated)"),
                describe(ProviderId.MTN_MOMO, "MTN MoMo"),
                describe(ProviderId.AIRTEL_MONEY, "Airtel Money"));
    }

    public ProviderCapabilities capabilities(ProviderId id) {
        return adapter(id).map(BankingProviderAdapter::capabilities).orElseGet(ProviderCapabilities::allUnconfirmed);
    }

    private Description describe(ProviderId id, String name) {
        var adapter = adapter(id);
        return new Description(id, name, adapter.map(BankingProviderAdapter::isSimulated).orElse(false), adapter.isPresent());
    }
}
