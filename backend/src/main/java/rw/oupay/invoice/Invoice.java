package rw.oupay.invoice;

import jakarta.persistence.CascadeType;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.OneToMany;
import jakarta.persistence.OrderBy;
import jakarta.persistence.Table;
import jakarta.persistence.Version;
import java.time.Instant;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

/**
 * A commercial invoice. Amounts are whole RWF. The payment status and balance are NOT fields: they
 * are derived from active allocations on every read (see the ledger module).
 */
@Entity
@Table(name = "invoices")
public class Invoice {

    @Id
    private UUID id;

    @Column(name = "merchant_id", nullable = false, updatable = false)
    private UUID merchantId;

    @Column(name = "invoice_number", nullable = false, updatable = false)
    private String invoiceNumber;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private InvoiceStatus status;

    @Column(name = "branch_id", nullable = false)
    private UUID branchId;

    @Column(name = "created_by_user_id", nullable = false, updatable = false)
    private UUID createdByUserId;

    @Column(name = "assigned_to_user_id", nullable = false)
    private UUID assignedToUserId;

    @Column(name = "created_by_name", nullable = false, updatable = false)
    private String createdByName;

    @Column(name = "assigned_to_name", nullable = false)
    private String assignedToName;

    @Column(name = "customer_name", nullable = false)
    private String customerName;

    @Column(name = "customer_email")
    private String customerEmail;

    @Column(name = "customer_phone")
    private String customerPhone;

    @Column(name = "customer_address")
    private String customerAddress;

    @Column(name = "customer_tin")
    private String customerTin;

    @Column(name = "merchant_snapshot", nullable = false)
    private String merchantSnapshot;

    @Column(name = "branch_snapshot", nullable = false)
    private String branchSnapshot;

    @Column(nullable = false, updatable = false)
    private String currency = "RWF";

    @Enumerated(EnumType.STRING)
    @Column(name = "tax_mode", nullable = false)
    private InvoiceCalculator.TaxMode taxMode;

    @Column(name = "subtotal_rwf", nullable = false)
    private long subtotalRwf;

    @Column(name = "discount_total_rwf", nullable = false)
    private long discountTotalRwf;

    @Column(name = "tax_total_rwf", nullable = false)
    private long taxTotalRwf;

    @Column(name = "grand_total_rwf", nullable = false)
    private long grandTotalRwf;

    @Column(name = "due_on", nullable = false)
    private LocalDate dueOn;

    @Column(name = "issued_at")
    private Instant issuedAt;

    @Column(name = "cancelled_at")
    private Instant cancelledAt;

    @Column(name = "voided_at")
    private Instant voidedAt;

    @Column(name = "void_reason")
    private String voidReason;

    private String notes;

    /** Where the invoice came from. Empty on invoices created before provenance existed: read it through {@link #getSaleChannel()}. */
    @Enumerated(EnumType.STRING)
    @Column(name = "sale_channel", updatable = false)
    private SaleChannel saleChannel;

    /** The durable identity of the original sale-creation request, when there was one. Fixed at creation. */
    @Column(name = "client_request_id", updatable = false)
    private UUID clientRequestId;

    /** SHA-256 of that original request, computed by the server (never supplied by a client). Exists exactly when the id does. */
    @Column(name = "client_request_sha256", updatable = false)
    private String clientRequestSha256;

    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    private long version;

    @OneToMany(mappedBy = "invoice", cascade = CascadeType.ALL, orphanRemoval = true, fetch = FetchType.LAZY)
    @OrderBy("lineNo ASC")
    private List<InvoiceItem> items = new ArrayList<>();

    protected Invoice() {}

    /**
     * @param clientRequestSha256 the server-computed fingerprint of the creating request: required when {@code creation} has a
     *                            client request id, and absent otherwise (the database enforces the same pairing)
     */
    public Invoice(UUID id, UUID merchantId, String invoiceNumber, UUID createdByUserId, String createdByName,
                   InvoiceCreation creation, String clientRequestSha256, Instant now) {
        if ((creation.clientRequestId() == null) != (clientRequestSha256 == null)) {
            throw new IllegalArgumentException("A client request id and its fingerprint go together.");
        }
        this.id = id;
        this.merchantId = merchantId;
        this.invoiceNumber = invoiceNumber;
        this.createdByUserId = createdByUserId;
        this.createdByName = createdByName;
        this.saleChannel = creation.channel();
        this.clientRequestId = creation.clientRequestId();
        this.clientRequestSha256 = clientRequestSha256;
        this.status = InvoiceStatus.DRAFT;
        this.createdAt = now;
        this.updatedAt = now;
    }

    public UUID getId() { return id; }
    public UUID getMerchantId() { return merchantId; }
    public String getInvoiceNumber() { return invoiceNumber; }
    public InvoiceStatus getStatus() { return status; }
    public UUID getBranchId() { return branchId; }
    public UUID getCreatedByUserId() { return createdByUserId; }
    public UUID getAssignedToUserId() { return assignedToUserId; }
    public String getCreatedByName() { return createdByName; }
    public String getAssignedToName() { return assignedToName; }
    public String getCustomerName() { return customerName; }
    public String getCustomerEmail() { return customerEmail; }
    public String getCustomerPhone() { return customerPhone; }
    public String getCustomerAddress() { return customerAddress; }
    public String getCustomerTin() { return customerTin; }
    public String getMerchantSnapshot() { return merchantSnapshot; }
    public String getBranchSnapshot() { return branchSnapshot; }
    public String getCurrency() { return currency; }
    public InvoiceCalculator.TaxMode getTaxMode() { return taxMode; }
    public long getSubtotalRwf() { return subtotalRwf; }
    public long getDiscountTotalRwf() { return discountTotalRwf; }
    public long getTaxTotalRwf() { return taxTotalRwf; }
    public long getGrandTotalRwf() { return grandTotalRwf; }
    public LocalDate getDueOn() { return dueOn; }
    public Instant getIssuedAt() { return issuedAt; }
    public Instant getCancelledAt() { return cancelledAt; }
    public Instant getVoidedAt() { return voidedAt; }
    public String getVoidReason() { return voidReason; }
    public String getNotes() { return notes; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public long getVersion() { return version; }
    public List<InvoiceItem> getItems() { return items; }

    /** The channel the invoice was created through. An invoice with no stored value predates provenance: a traditional INVOICE. */
    public SaleChannel getSaleChannel() { return saleChannel == null ? SaleChannel.INVOICE : saleChannel; }

    public UUID getClientRequestId() { return clientRequestId; }
    public String getClientRequestSha256() { return clientRequestSha256; }

    public void applyContent(UUID branchId, UUID assignedToUserId, String assignedToName, String customerName,
                             String customerEmail, String customerPhone, String customerAddress, String customerTin,
                             String merchantSnapshot, String branchSnapshot, InvoiceCalculator.TaxMode taxMode,
                             InvoiceCalculator.Result result, LocalDate dueOn, String notes, Instant now) {
        this.branchId = branchId;
        this.assignedToUserId = assignedToUserId;
        this.assignedToName = assignedToName;
        this.customerName = customerName;
        this.customerEmail = customerEmail;
        this.customerPhone = customerPhone;
        this.customerAddress = customerAddress;
        this.customerTin = customerTin;
        this.merchantSnapshot = merchantSnapshot;
        this.branchSnapshot = branchSnapshot;
        this.taxMode = taxMode;
        this.subtotalRwf = result.subtotal();
        this.discountTotalRwf = result.discountTotal();
        this.taxTotalRwf = result.taxTotal();
        this.grandTotalRwf = result.grandTotal();
        this.dueOn = dueOn;
        this.notes = notes;
        this.updatedAt = now;
        this.items.clear();
        int lineNo = 1;
        for (InvoiceCalculator.Line line : result.lines()) {
            this.items.add(new InvoiceItem(UUID.randomUUID(), this, lineNo++, line));
        }
    }

    /** Freezes merchant, branch and staff details as they are at issue time. */
    public void issue(String merchantSnapshot, String branchSnapshot, String assignedToName, Instant now) {
        this.status = InvoiceStatus.ISSUED;
        this.merchantSnapshot = merchantSnapshot;
        this.branchSnapshot = branchSnapshot;
        this.assignedToName = assignedToName;
        this.issuedAt = now;
        this.updatedAt = now;
    }

    public void cancel(Instant now) {
        this.status = InvoiceStatus.CANCELLED;
        this.cancelledAt = now;
        this.updatedAt = now;
    }

    public void voidInvoice(String reason, Instant now) {
        this.status = InvoiceStatus.VOIDED;
        this.voidedAt = now;
        this.voidReason = reason;
        this.updatedAt = now;
    }
}
