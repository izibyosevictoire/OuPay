package rw.oupay.invoice;

import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.EnumType;
import jakarta.persistence.Enumerated;
import jakarta.persistence.FetchType;
import jakarta.persistence.Id;
import jakarta.persistence.JoinColumn;
import jakarta.persistence.ManyToOne;
import jakarta.persistence.Table;
import java.util.UUID;

@Entity
@Table(name = "invoice_items")
public class InvoiceItem {

    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "invoice_id", nullable = false, updatable = false)
    private Invoice invoice;

    @Column(name = "line_no", nullable = false)
    private int lineNo;

    @Column(nullable = false)
    private String description;

    @Column(name = "quantity_milli", nullable = false)
    private long quantityMilli;

    @Column(name = "unit_price_rwf", nullable = false)
    private long unitPriceRwf;

    @Column(name = "discount_rwf", nullable = false)
    private long discountRwf;

    @Enumerated(EnumType.STRING)
    @Column(name = "tax_category", nullable = false)
    private InvoiceCalculator.TaxCategory taxCategory;

    @Column(name = "tax_rate_bp", nullable = false)
    private int taxRateBp;

    @Column(name = "net_amount_rwf", nullable = false)
    private long netAmountRwf;

    @Column(name = "tax_amount_rwf", nullable = false)
    private long taxAmountRwf;

    @Column(name = "line_total_rwf", nullable = false)
    private long lineTotalRwf;

    protected InvoiceItem() {}

    InvoiceItem(UUID id, Invoice invoice, int lineNo, InvoiceCalculator.Line line) {
        this.id = id;
        this.invoice = invoice;
        this.lineNo = lineNo;
        this.description = line.description();
        this.quantityMilli = line.quantityMilli();
        this.unitPriceRwf = line.unitPrice();
        this.discountRwf = line.discount();
        this.taxCategory = line.taxCategory();
        this.taxRateBp = line.taxRateBp();
        this.netAmountRwf = line.netAmount();
        this.taxAmountRwf = line.taxAmount();
        this.lineTotalRwf = line.lineTotal();
    }

    public UUID getId() { return id; }
    public int getLineNo() { return lineNo; }
    public String getDescription() { return description; }
    public long getQuantityMilli() { return quantityMilli; }
    public long getUnitPriceRwf() { return unitPriceRwf; }
    public long getDiscountRwf() { return discountRwf; }
    public InvoiceCalculator.TaxCategory getTaxCategory() { return taxCategory; }
    public int getTaxRateBp() { return taxRateBp; }
    public long getNetAmountRwf() { return netAmountRwf; }
    public long getTaxAmountRwf() { return taxAmountRwf; }
    public long getLineTotalRwf() { return lineTotalRwf; }
}
