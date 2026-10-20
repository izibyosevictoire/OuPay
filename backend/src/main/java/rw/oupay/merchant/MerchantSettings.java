package rw.oupay.merchant;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.util.UUID;

/** One row per business. Changing it never touches historical records: it only says how the business works from now on. */
@Entity
@Table(name = "merchant_settings")
public class MerchantSettings {

    @Id
    @Column(name = "merchant_id")
    private UUID merchantId;

    @Enumerated(EnumType.STRING)
    @Column(name = "operating_mode", nullable = false)
    private OperatingMode operatingMode;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    private long version;

    protected MerchantSettings() {}

    public MerchantSettings(UUID merchantId, OperatingMode operatingMode, Instant now) {
        this.merchantId = merchantId;
        this.operatingMode = operatingMode;
        this.updatedAt = now;
    }

    public UUID getMerchantId() { return merchantId; }
    public OperatingMode getOperatingMode() { return operatingMode; }
    public Instant getUpdatedAt() { return updatedAt; }
    public long getVersion() { return version; }

    public void changeOperatingMode(OperatingMode mode, Instant now) {
        this.operatingMode = mode;
        this.updatedAt = now;
    }
}
