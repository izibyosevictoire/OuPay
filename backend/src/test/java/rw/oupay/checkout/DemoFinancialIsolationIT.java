package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.TestPropertySource;
import tools.jackson.databind.JsonNode;

/**
 * R6c: a DEMONSTRATION code sale is a real issued invoice (the checkout demonstration needs one) but it must never distort the business's
 * financial records. The flag {@code invoices.is_demonstration} is set once, when the invoice is created, kept equal to the sale's mode
 * by the database, and tested by every list, count, total and report. These tests prove the exclusion on the real endpoints, and that
 * ordinary and LIVE code invoices are counted exactly as before.
 */
@TestPropertySource(properties = {
        "oupay.collection-codes.approval-enabled=true",
        "oupay.code-checkout.live-enabled=true"})
class DemoFinancialIsolationIT extends CodeCheckoutTestSupport {

    private String m(String path) {
        return "/api/v1/merchants/" + w.merchantId + path;
    }

    private JsonNode report() {
        var response = w.owner.get(m("/reports/summary"));
        assertThat(response.status()).as(response.body()).isEqualTo(200);
        return response.json();
    }

    private JsonNode dashboard() {
        return w.owner.get(m("/dashboard/summary")).json();
    }

    private List<String> listedIds(JsonNode page) {
        List<String> ids = new ArrayList<>();
        page.path("items").forEach(i -> ids.add(i.path("id").asString()));
        return ids;
    }

    private JsonNode demoSale(long amount) {
        ensureProfile();
        JsonNode code = activeCode("Demo", "EQ-DEMO-1");
        assertThat(assign(code, cashierMembership).status()).isEqualTo(201);
        var created = bill(w.cashier, "key-" + UUID.randomUUID(), body(amount, null, null, UUID.randomUUID()));
        assertThat(created.status()).as(created.body()).isEqualTo(201);
        assertThat(created.json().path("code").path("mode").asString()).isEqualTo("DEMONSTRATION");
        return created.json();
    }

    private JsonNode liveSale(long amount) {
        makeAccountReal();
        ensureProfile();
        JsonNode code = activeCode("Live", "EQ-LIVE-77");
        assertThat(assign(code, cashierMembership).status()).isEqualTo(201);
        var created = bill(w.cashier, "key-" + UUID.randomUUID(), body(amount, null, null, UUID.randomUUID()));
        assertThat(created.status()).as(created.body()).isEqualTo(201);
        assertThat(created.json().path("code").path("mode").asString()).isEqualTo("LIVE");
        return created.json();
    }

    // ---- 1. the demonstration still works ---------------------------------------------------------

    @Test
    void aDemonstrationSaleExistsIsNumberedApartAndRemainsViewable() {
        JsonNode sale = demoSale(90_000);
        String invoiceId = sale.path("invoiceId").asString();
        assertThat(sale.path("invoiceNumber").asString()).matches("DEMO-\\d{4}");

        // The demo workflow: the sale itself, and its invoice by id, clearly identified.
        assertThat(w.cashier.get(sale() + "/" + sale.path("saleId").asString()).status()).isEqualTo(200);
        var invoice = w.owner.get(m("/invoices/" + invoiceId));
        assertThat(invoice.status()).isEqualTo(200);
        assertThat(invoice.json().path("demonstration").asBoolean()).isTrue();
        assertThat(invoice.json().path("saleChannel").asString()).isEqualTo("CODE");
        assertThat(invoice.json().path("status").asString()).isEqualTo("ISSUED");
        assertThat(publicSale(sale.path("saleReference").asString()).status()).isEqualTo(200);
        assertThat(jdbc.queryForObject("select is_demonstration from invoices where id = ?::uuid", Boolean.class, invoiceId)).isTrue();
    }

    // ---- 2 and 3. operational receivables, lists and financial totals ------------------------------

    @Test
    void aDemonstrationContributesNothingToListsReceivablesReportsOrTheDashboard() {
        UUID ordinary = w.issuedInvoice(30_000);
        JsonNode reportBefore = report();
        JsonNode dashboardBefore = dashboard();
        JsonNode listBefore = w.owner.get(m("/invoices")).json();
        long totalBefore = listBefore.path("totalCount").asLong();
        assertThat(reportBefore.path("issuedInvoiceCount").asLong()).isEqualTo(1);

        JsonNode sale = demoSale(90_000);
        String demoInvoice = sale.path("invoiceId").asString();

        // Invoice lists (owner, and the cashier's "assigned to me" list) and their counts.
        JsonNode list = w.owner.get(m("/invoices")).json();
        assertThat(listedIds(list)).contains(ordinary.toString()).doesNotContain(demoInvoice);
        assertThat(list.path("totalCount").asLong()).isEqualTo(totalBefore);
        var cashierList = w.cashier.get(m("/invoices")).json();
        assertThat(listedIds(cashierList)).doesNotContain(demoInvoice);

        // Operational receivables: the manual-reconciliation picker never offers it.
        List<String> payable = new ArrayList<>();
        w.owner.get(m("/payable-invoices")).json().forEach(p -> payable.add(p.path("invoiceId").asString()));
        assertThat(payable).contains(ordinary.toString()).doesNotContain(demoInvoice);

        // Financial reports and dashboard figures are exactly what they were.
        JsonNode reportAfter = report();
        assertThat(reportAfter).isEqualTo(reportBefore);
        assertThat(reportAfter.path("issuedInvoiceCount").asLong()).isEqualTo(1);
        assertThat(reportAfter.path("issuedTotalRwf").asLong()).isEqualTo(30_000);
        assertThat(reportAfter.path("outstandingForIssuedInvoicesRwf").asLong()).isEqualTo(30_000);
        assertThat(dashboard()).isEqualTo(dashboardBefore);
    }

    @Test
    void bankMoneyThatNamesADemonstrationChangesNoFinancialFigureEither() {
        w.issuedInvoice(30_000);
        JsonNode sale = demoSale(90_000);
        JsonNode reportBefore = report();
        w.bank.pay("POSTED", 90_000, sale.path("saleReference").asString());
        // The real transaction is a verified, unmatched collection (as the ledger always reports it); invoices and receivables did not move.
        JsonNode after = report();
        assertThat(after.path("issuedInvoiceCount").asLong()).isEqualTo(reportBefore.path("issuedInvoiceCount").asLong());
        assertThat(after.path("issuedTotalRwf").asLong()).isEqualTo(reportBefore.path("issuedTotalRwf").asLong());
        assertThat(after.path("outstandingForIssuedInvoicesRwf").asLong()).isEqualTo(reportBefore.path("outstandingForIssuedInvoicesRwf").asLong());
        assertThat(after.path("activeAllocatedToIssuedInvoicesRwf").asLong()).isZero();
        assertThat(count("payment_allocations")).isZero();
    }

    // ---- 5 and 6. ordinary and LIVE invoices are counted as before ----------------------------------

    @Test
    void anOrdinaryInvoiceIsStillCountedAndNumberedWithoutAGapNextToADemonstration() {
        UUID first = w.issuedInvoice(30_000);
        demoSale(90_000);
        UUID second = w.issuedInvoice(20_000);
        String firstNumber = jdbc.queryForObject("select invoice_number from invoices where id = ?", String.class, first);
        String secondNumber = jdbc.queryForObject("select invoice_number from invoices where id = ?", String.class, second);
        // Real numbers stay consecutive: the demonstration took DEMO-0001, never an INV- number.
        int a = Integer.parseInt(firstNumber.substring(4));
        int b = Integer.parseInt(secondNumber.substring(4));
        assertThat(b).isEqualTo(a + 1);
        assertThat(jdbc.queryForList("select invoice_number from invoices where is_demonstration", String.class)).containsExactly("DEMO-0001");
        JsonNode report = report();
        assertThat(report.path("issuedInvoiceCount").asLong()).isEqualTo(2);
        assertThat(report.path("issuedTotalRwf").asLong()).isEqualTo(50_000);
        assertThat(report.path("outstandingForIssuedInvoicesRwf").asLong()).isEqualTo(50_000);
    }

    @Test
    void aLiveCodeSaleIsACountedBusinessInvoice() {
        UUID ordinary = w.issuedInvoice(30_000);
        JsonNode sale = liveSale(12_000);
        String liveInvoice = sale.path("invoiceId").asString();
        assertThat(sale.path("invoiceNumber").asString()).startsWith("INV-");
        var invoice = w.owner.get(m("/invoices/" + liveInvoice)).json();
        assertThat(invoice.path("demonstration").asBoolean()).isFalse();
        assertThat(listedIds(w.owner.get(m("/invoices")).json())).contains(ordinary.toString(), liveInvoice);
        JsonNode report = report();
        assertThat(report.path("issuedInvoiceCount").asLong()).isEqualTo(2);
        assertThat(report.path("issuedTotalRwf").asLong()).isEqualTo(42_000);
        assertThat(report.path("outstandingForIssuedInvoicesRwf").asLong()).isEqualTo(42_000);
        List<String> payable = new ArrayList<>();
        w.owner.get(m("/payable-invoices")).json().forEach(p -> payable.add(p.path("invoiceId").asString()));
        assertThat(payable).contains(liveInvoice);
    }

    // ---- 7. the flag is a fact the database keeps ------------------------------------------------------

    @Test
    void theFlagCannotBeChangedAndNothingButACodeSaleCanCarryIt() {
        JsonNode sale = demoSale(90_000);
        UUID demoInvoice = UUID.fromString(sale.path("invoiceId").asString());
        // A demonstration cannot be turned into a real invoice (which would let it be paid, reported or sent on)...
        assertThatThrownBy(() -> jdbc.update("update invoices set is_demonstration = false where id = ?", demoInvoice))
                .hasMessageContaining("provenance is fixed");
        // ...and a real invoice cannot be turned into a demonstration to hide it from the books.
        UUID real = w.issuedInvoice(30_000);
        assertThatThrownBy(() -> jdbc.update("update invoices set is_demonstration = true where id = ?", real))
                .hasMessageContaining("provenance is fixed");
        // Only the CODE channel may be a demonstration.
        assertThatThrownBy(() -> jdbc.update("update invoices set sale_channel = 'SIMPLIFIED' where id = ?", demoInvoice)).isNotNull();
        // No allocation, by any origin, reaches it (the V13 guard, now reading the invoice's own flag).
        w.bank.pay("POSTED", 90_000, null);
        UUID transaction = jdbc.queryForObject("select id from bank_transactions", UUID.class);
        for (String origin : List.of("MANUAL", "AUTO_REFERENCE")) {
            assertThatThrownBy(() -> jdbc.update("insert into payment_allocations (id, merchant_id, bank_transaction_id, invoice_id, amount_rwf, status, "
                            + "origin, created_by_user_id, created_at) values (?, ?, ?, ?, 90000, 'ACTIVE', ?, ?, now())",
                    UUID.randomUUID(), w.merchantId, transaction, demoInvoice, origin, w.ownerPerson.userId()))
                    .hasMessageContaining("demonstration code sale");
        }
        assertThat(count("payment_allocations")).isZero();
    }

    // ---- 8. isolation between businesses --------------------------------------------------------------

    @Test
    void anotherBusinessCannotSeeTheDemonstrationInvoiceOrItsNumbersAffectItsFigures() {
        JsonNode sale = demoSale(90_000);
        String demoInvoice = sale.path("invoiceId").asString();
        assertThat(w.cafeOwner.get("/api/v1/merchants/" + w.cafeMerchantId + "/invoices/" + demoInvoice).status()).isEqualTo(404);
        assertThat(w.cafeOwner.get(m("/invoices/" + demoInvoice)).status()).isIn(403, 404);
        var cafeReport = w.cafeOwner.get("/api/v1/merchants/" + w.cafeMerchantId + "/reports/summary").json();
        assertThat(cafeReport.path("issuedInvoiceCount").asLong()).isZero();
        // The demonstration series belongs to one business.
        assertThat(jdbc.queryForObject("select count(*) from demo_invoice_number_sequences where merchant_id = ?", Integer.class, w.cafeMerchantId)).isZero();
    }
}
