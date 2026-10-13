package rw.oupay.banking;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import java.time.Instant;
import java.util.UUID;

/** Wire shapes matching the frontend's banking types. No credential, PIN, password or OTP exists anywhere here. */
public final class BankingDtos {

    private BankingDtos() {}

    public record ProviderDto(ProviderId id, String displayName, boolean isSimulated, boolean isAvailable,
                              ProviderCapabilities capabilities) {}

    public record LinkRequest(@NotNull ProviderId providerId,
                              /** An opaque reference chosen with the bank, NOT an online-banking login. */
                              @NotBlank @Size(max = 64) String accountReference,
                              @NotBlank @Size(max = 60) String accountNickname) {}

    public record ConnectionDto(UUID id, UUID merchantId, ProviderId providerId, BankConnection.Status status,
                                String accountNickname, String bankAccountId, String maskedAccount, boolean isSimulated,
                                String lastError, Instant createdAt, Instant updatedAt) {
        static ConnectionDto of(BankConnection c) {
            return new ConnectionDto(c.getId(), c.getMerchantId(), c.getProviderId(), c.getStatus(), c.getAccountNickname(),
                    c.getProviderAccountId(), c.getMaskedAccount(), c.isSimulated(), c.getLastError(), c.getCreatedAt(), c.getUpdatedAt());
        }
    }

    public record DestinationDto(UUID id, UUID merchantId, UUID bankConnectionId, String label, String bankAccountId,
                                 String maskedAccount, ProviderId providerId, boolean isSimulated, Instant createdAt) {
        public static DestinationDto of(PaymentDestination d) {
            return new DestinationDto(d.getId(), d.getMerchantId(), d.getBankConnectionId(), d.getLabel(), d.getProviderAccountId(),
                    d.getMaskedAccount(), d.getProviderId(), d.isSimulated(), d.getCreatedAt());
        }
    }
}
