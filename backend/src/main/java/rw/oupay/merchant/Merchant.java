package rw.oupay.merchant;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "merchants")
public class Merchant {

    @Id
    private UUID id;

    @Column(name = "owner_user_id", nullable = false, updatable = false)
    private UUID ownerUserId;

    @Column(name = "legal_name", nullable = false, updatable = false)
    private String legalName;

    @Column(name = "trading_name")
    private String tradingName;

    @Column(name = "business_type", nullable = false, updatable = false)
    private String businessType;

    /** pending_verification until a back-office review (not built) grants {@code active}. */
    @Column(nullable = false)
    private String status;

    @Column(name = "registration_number", updatable = false)
    private String registrationNumber;

    @Column(updatable = false)
    private String tin;

    @Column(nullable = false, updatable = false)
    private String country = "RW";

    @Column(nullable = false, updatable = false)
    private String province;

    @Column(nullable = false, updatable = false)
    private String district;

    @Column(nullable = false, updatable = false)
    private String sector;

    @Column(name = "physical_address", nullable = false)
    private String physicalAddress;

    @Column(name = "contact_full_name", nullable = false)
    private String contactFullName;

    @Column(name = "contact_email", nullable = false)
    private String contactEmail;

    @Column(name = "contact_phone", nullable = false)
    private String contactPhone;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    private long version;

    protected Merchant() {}

    public Merchant(UUID id, UUID ownerUserId, String legalName, String tradingName, String businessType,
                    String registrationNumber, String tin, String province, String district, String sector,
                    String physicalAddress, String contactFullName, String contactEmail, String contactPhone, Instant now) {
        this.id = id;
        this.ownerUserId = ownerUserId;
        this.legalName = legalName;
        this.tradingName = tradingName;
        this.businessType = businessType;
        this.status = "pending_verification";
        this.registrationNumber = registrationNumber;
        this.tin = tin;
        this.province = province;
        this.district = district;
        this.sector = sector;
        this.physicalAddress = physicalAddress;
        this.contactFullName = contactFullName;
        this.contactEmail = contactEmail;
        this.contactPhone = contactPhone;
        this.createdAt = now;
        this.updatedAt = now;
    }

    public UUID getId() { return id; }
    public UUID getOwnerUserId() { return ownerUserId; }
    public String getLegalName() { return legalName; }
    public String getTradingName() { return tradingName; }
    public String getBusinessType() { return businessType; }
    public String getStatus() { return status; }
    public String getRegistrationNumber() { return registrationNumber; }
    public String getTin() { return tin; }
    public String getCountry() { return country; }
    public String getProvince() { return province; }
    public String getDistrict() { return district; }
    public String getSector() { return sector; }
    public String getPhysicalAddress() { return physicalAddress; }
    public String getContactFullName() { return contactFullName; }
    public String getContactEmail() { return contactEmail; }
    public String getContactPhone() { return contactPhone; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }

    /** Display name shown publicly and on invoices. */
    public String displayName() {
        return tradingName != null && !tradingName.isBlank() ? tradingName : legalName;
    }

    public void updateProfile(String tradingName, String physicalAddress, String contactFullName,
                              String contactEmail, String contactPhone, Instant now) {
        this.tradingName = tradingName;
        this.physicalAddress = physicalAddress;
        this.contactFullName = contactFullName;
        this.contactEmail = contactEmail;
        this.contactPhone = contactPhone;
        this.updatedAt = now;
    }
}
