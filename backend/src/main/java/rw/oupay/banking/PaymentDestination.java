package rw.oupay.banking;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import java.time.Instant;
import java.util.UUID;

/** Where a customer's money should go, as a payment profile sees it. */
@Entity
@Table(name = "payment_destinations")
public class PaymentDestination {

    @Id
    private UUID id;

    @Column(name = "merchant_id", nullable = false, updatable = false)
    private UUID merchantId;

    @Column(name = "bank_connection_id", nullable = false, updatable = false)
    private UUID bankConnectionId;

    @Column(nullable = false)
    private String label;

    @Enumerated(EnumType.STRING)
    @Column(name = "provider_id", nullable = false, updatable = false)
    private ProviderId providerId;

    @Column(name = "provider_account_id", nullable = false, updatable = false)
    private String providerAccountId;

    @Column(name = "masked_account", nullable = false)
    private String maskedAccount;

    @Column(name = "is_simulated", nullable = false)
    private boolean simulated;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    protected PaymentDestination() {}

    public PaymentDestination(UUID id, UUID merchantId, BankConnection connection, Instant now) {
        this.id = id;
        this.merchantId = merchantId;
        this.bankConnectionId = connection.getId();
        this.label = connection.getAccountNickname();
        this.providerId = connection.getProviderId();
        this.providerAccountId = connection.getProviderAccountId();
        this.maskedAccount = connection.getMaskedAccount();
        this.simulated = connection.isSimulated();
        this.createdAt = now;
    }

    public UUID getId() { return id; }
    public UUID getMerchantId() { return merchantId; }
    public UUID getBankConnectionId() { return bankConnectionId; }
    public String getLabel() { return label; }
    public ProviderId getProviderId() { return providerId; }
    public String getProviderAccountId() { return providerAccountId; }
    public String getMaskedAccount() { return maskedAccount; }
    public boolean isSimulated() { return simulated; }
    public Instant getCreatedAt() { return createdAt; }
}
