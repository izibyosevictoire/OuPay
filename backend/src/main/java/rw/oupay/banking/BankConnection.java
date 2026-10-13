package rw.oupay.banking;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.util.UUID;

/** A merchant's link to one provider account. Holds only opaque and masked identifiers. */
@Entity
@Table(name = "bank_connections")
public class BankConnection {

    public enum Status { PENDING, CONNECTED, ERROR, DISABLED }

    @Id
    private UUID id;

    @Column(name = "merchant_id", nullable = false, updatable = false)
    private UUID merchantId;

    @Enumerated(EnumType.STRING)
    @Column(name = "provider_id", nullable = false, updatable = false)
    private ProviderId providerId;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private Status status;

    @Column(name = "account_nickname", nullable = false)
    private String accountNickname;

    @Column(name = "provider_account_id")
    private String providerAccountId;

    @Column(name = "masked_account")
    private String maskedAccount;

    @Column(name = "is_simulated", nullable = false)
    private boolean simulated;

    @Column(name = "last_error")
    private String lastError;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    private long version;

    protected BankConnection() {}

    public BankConnection(UUID id, UUID merchantId, ProviderId providerId, Status status, String accountNickname,
                          String providerAccountId, String maskedAccount, boolean simulated, String lastError, Instant now) {
        this.id = id;
        this.merchantId = merchantId;
        this.providerId = providerId;
        this.status = status;
        this.accountNickname = accountNickname;
        this.providerAccountId = providerAccountId;
        this.maskedAccount = maskedAccount;
        this.simulated = simulated;
        this.lastError = lastError;
        this.createdAt = now;
        this.updatedAt = now;
    }

    public UUID getId() { return id; }
    public UUID getMerchantId() { return merchantId; }
    public ProviderId getProviderId() { return providerId; }
    public Status getStatus() { return status; }
    public String getAccountNickname() { return accountNickname; }
    public String getProviderAccountId() { return providerAccountId; }
    public String getMaskedAccount() { return maskedAccount; }
    public boolean isSimulated() { return simulated; }
    public String getLastError() { return lastError; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }

    public void changeStatus(Status status, Instant now) {
        this.status = status;
        this.updatedAt = now;
    }
}
