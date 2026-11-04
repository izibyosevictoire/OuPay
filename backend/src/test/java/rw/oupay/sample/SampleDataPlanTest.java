package rw.oupay.sample;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Set;
import java.util.stream.Collectors;
import org.junit.jupiter.api.Test;

/** R9b: the dataset definition is what was asked for, recognisable as sample data, and internally consistent. */
class SampleDataPlanTest {

    @Test
    void theDatasetIsExactlyWhatWasAskedFor() {
        assertThat(SampleDataPlan.BRANCHES).extracting(SampleDataPlan.BranchPlan::name)
                .containsExactly("DEMO - Kigali Main", "DEMO - Remera", "DEMO - Kimironko");
        assertThat(SampleDataPlan.ITEMS.stream().filter(SampleDataPlan.ItemPlan::goods)).hasSize(10);
        assertThat(SampleDataPlan.ITEMS.stream().filter(i -> !i.goods())).hasSize(2);
        assertThat(SampleDataPlan.STAFF).extracting(SampleDataPlan.StaffPlan::role).containsExactly("MANAGER", "CASHIER", "CASHIER");
        assertThat(SampleDataPlan.DEVICES).extracting(SampleDataPlan.DevicePlan::type).containsExactly("STATIC_QR", "STATIC_QR", "NFC_TAG");
    }

    @Test
    void everyRecordIsRecognisableAsSampleData() {
        assertThat(SampleDataPlan.BRANCHES).allSatisfy(b -> assertThat(b.code()).startsWith("DEMO").matches("^[A-Za-z0-9]{2,12}$"));
        assertThat(SampleDataPlan.BRANCHES).allSatisfy(b -> assertThat(b.name()).startsWith("DEMO - "));
        assertThat(SampleDataPlan.ITEMS).allSatisfy(i -> {
            assertThat(i.code()).startsWith("DEMO-");
            assertThat(i.name()).startsWith("DEMO - ");
            assertThat(i.description()).contains(SampleDataPlan.BATCH).hasSizeLessThanOrEqualTo(500);
        });
        assertThat(SampleDataPlan.DEVICES).allSatisfy(d -> assertThat(d.name()).startsWith("DEMO - ").hasSizeLessThanOrEqualTo(60));
        assertThat(SampleDataPlan.DRAFTS).allSatisfy(d -> assertThat(d.note()).startsWith("DEMO - ").hasSizeLessThanOrEqualTo(200));
        assertThat(SampleDataPlan.BATCH).startsWith("R9B-");
    }

    @Test
    void referencesAreConsistentAndStockIsForGoodsOnly() {
        Set<String> branches = SampleDataPlan.BRANCHES.stream().map(SampleDataPlan.BranchPlan::code).collect(Collectors.toSet());
        Set<String> goods = SampleDataPlan.ITEMS.stream().filter(SampleDataPlan.ItemPlan::goods).map(SampleDataPlan.ItemPlan::code).collect(Collectors.toSet());
        Set<String> items = SampleDataPlan.ITEMS.stream().map(SampleDataPlan.ItemPlan::code).collect(Collectors.toSet());
        assertThat(SampleDataPlan.STOCK).allSatisfy(s -> {
            assertThat(branches).contains(s.branchCode());
            assertThat(goods).contains(s.itemCode());
        });
        assertThat(SampleDataPlan.PACKAGES).allSatisfy(p -> assertThat(goods).contains(p.itemCode()));
        assertThat(SampleDataPlan.DEVICES).allSatisfy(d -> assertThat(branches).contains(d.branchCode()));
        assertThat(SampleDataPlan.STAFF).allSatisfy(s -> assertThat(branches).containsAll(s.branchCodes()));
        assertThat(SampleDataPlan.DRAFTS).allSatisfy(d -> d.lines().forEach(l -> assertThat(items).contains(l.itemCode())));
        // Every good has stock somewhere; no branch/item pair is listed twice; keys are unique.
        assertThat(SampleDataPlan.STOCK.stream().map(SampleDataPlan.StockPlan::itemCode).collect(Collectors.toSet())).isEqualTo(goods);
        List<String> pairs = SampleDataPlan.STOCK.stream().map(s -> s.branchCode() + "/" + s.itemCode()).toList();
        assertThat(pairs).doesNotHaveDuplicates();
        assertThat(SampleDataPlan.ITEMS.stream().map(SampleDataPlan.ItemPlan::code)).doesNotHaveDuplicates();
        assertThat(SampleDataPlan.DEVICES.stream().map(SampleDataPlan.DevicePlan::key)).doesNotHaveDuplicates();
        assertThat(SampleDataPlan.DRAFTS.stream().map(SampleDataPlan.DraftPlan::key)).doesNotHaveDuplicates();
    }

    @Test
    void theDatasetHasNoMoneyApprovalOrTaxDecisionInIt() {
        // Prices are catalog prices only; nothing in the plan can express a payment, a balance, a settlement, an approval or a tax treatment.
        String all = SampleDataPlan.ITEMS.toString() + SampleDataPlan.STOCK + SampleDataPlan.DEVICES + SampleDataPlan.DRAFTS;
        assertThat(all.toLowerCase(java.util.Locale.ROOT)).doesNotContain("bank").doesNotContain("settlement").doesNotContain("balance")
                .doesNotContain("approved").doesNotContain("tax");
    }
}
