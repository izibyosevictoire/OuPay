package rw.oupay.pos;

import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import rw.oupay.invoice.InvoiceCalculator.TaxCategory;

/**
 * WHICH tax treatments POS billing may issue. A catalog item carries an explicit classification (category and, for STANDARD, a rate) or
 * none at all; this policy is the separate, configuration-controlled statement of which classifications the business has APPROVED for
 * payable POS invoices ({@code oupay.pos.approved-tax-treatments}, for example {@code EXEMPT:0,ZERO_RATED:0,STANDARD:1800}).
 *
 * <p>The default is EMPTY: until a business owner and OuPay have approved the treatments, no POS invoice can be issued, whatever the
 * catalog says. OuPay does not decide what is taxable, does not infer treatment from a name, and does not claim tax compliance or
 * RRA EBM certification: it only refuses to bill a configuration nobody approved, and snapshots what it billed.
 */
@Component
public final class PosTaxPolicy {

    public record Treatment(TaxCategory category, int rateBp) {
        public String label() {
            return category == TaxCategory.STANDARD ? "STANDARD " + rateBp / 100 + "." + String.format("%02d", rateBp % 100) + "%" : category.name();
        }
    }

    private final Set<Treatment> approved;

    public PosTaxPolicy(@Value("${oupay.pos.approved-tax-treatments:}") String configured) {
        this.approved = parse(configured);
    }

    private static Set<Treatment> parse(String configured) {
        Set<Treatment> parsed = new LinkedHashSet<>();
        for (String entry : configured.split(",")) {
            String text = entry.trim();
            if (text.isEmpty()) {
                continue;
            }
            String[] parts = text.split(":");
            if (parts.length != 2) {
                throw new IllegalStateException("oupay.pos.approved-tax-treatments: expected CATEGORY:rateBp, found '" + text + "'");
            }
            TaxCategory category;
            int rate;
            try {
                category = TaxCategory.valueOf(parts[0].trim());
                rate = Integer.parseInt(parts[1].trim());
            } catch (IllegalArgumentException e) {
                throw new IllegalStateException("oupay.pos.approved-tax-treatments: unsupported entry '" + text + "'", e);
            }
            boolean valid = category == TaxCategory.STANDARD ? rate >= 1 && rate <= 10_000 : rate == 0;
            if (!valid) {
                throw new IllegalStateException("oupay.pos.approved-tax-treatments: '" + text + "' is not a valid treatment");
            }
            parsed.add(new Treatment(category, rate));
        }
        return Set.copyOf(parsed);
    }

    public boolean isApproved(TaxCategory category, int rateBp) {
        return approved.contains(new Treatment(category, rateBp));
    }

    /** What has been approved, for display. Empty until a decision is made. */
    public List<String> approvedLabels() {
        List<String> labels = new ArrayList<>(approved.stream().map(Treatment::label).toList());
        labels.sort(String::compareTo);
        return labels;
    }
}
