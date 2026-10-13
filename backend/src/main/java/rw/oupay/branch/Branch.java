package rw.oupay.branch;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "branches")
public class Branch {

    @Id
    private UUID id;

    @Column(name = "merchant_id", nullable = false, updatable = false)
    private UUID merchantId;

    @Column(nullable = false)
    private String name;

    @Column(nullable = false)
    private String code;

    @Column(nullable = false)
    private String province;

    @Column(nullable = false)
    private String district;

    @Column(nullable = false)
    private String sector;

    @Column(name = "physical_address", nullable = false)
    private String physicalAddress;

    @Column(name = "contact_phone")
    private String contactPhone;

    /** ACTIVE or INACTIVE. */
    @Column(nullable = false)
    private String status;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    private long version;

    protected Branch() {}

    public Branch(UUID id, UUID merchantId, String name, String code, String province, String district, String sector,
                  String physicalAddress, String contactPhone, String status, Instant now) {
        this.id = id;
        this.merchantId = merchantId;
        this.name = name;
        this.code = code;
        this.province = province;
        this.district = district;
        this.sector = sector;
        this.physicalAddress = physicalAddress;
        this.contactPhone = contactPhone;
        this.status = status;
        this.createdAt = now;
        this.updatedAt = now;
    }

    public UUID getId() { return id; }
    public UUID getMerchantId() { return merchantId; }
    public String getName() { return name; }
    public String getCode() { return code; }
    public String getProvince() { return province; }
    public String getDistrict() { return district; }
    public String getSector() { return sector; }
    public String getPhysicalAddress() { return physicalAddress; }
    public String getContactPhone() { return contactPhone; }
    public String getStatus() { return status; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }

    public boolean isActive() {
        return "ACTIVE".equals(status);
    }

    public void update(String name, String code, String province, String district, String sector,
                       String physicalAddress, String contactPhone, Instant now) {
        this.name = name;
        this.code = code;
        this.province = province;
        this.district = district;
        this.sector = sector;
        this.physicalAddress = physicalAddress;
        this.contactPhone = contactPhone;
        this.updatedAt = now;
    }

    public void changeStatus(String status, Instant now) {
        this.status = status;
        this.updatedAt = now;
    }
}
