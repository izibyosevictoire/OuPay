package rw.oupay.invoice;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.World;

class InvoiceIT extends IntegrationTest {

    World w;

    @BeforeEach
    void world() {
        w = World.create(this);
    }

    private String inv(String path) {
        return "/api/v1/merchants/" + w.merchantId + "/invoices" + path;
    }

    private Map<String, Object> line(String description, Object quantity, long price, long discount, String category, int rateBp) {
        return Map.of("description", description, "quantity", quantity, "unitPrice", price, "discount", discount,
                "taxRate", Map.of("category", category, "rateBp", rateBp));
    }

    private Map<String, Object> draftWith(UUID assignee, List<Map<String, Object>> items, String taxMode) {
        Map<String, Object> body = new HashMap<>(w.draft(assignee, 1000));
        body.put("items", items);
        body.put("taxMode", taxMode);
        return body;
    }

    // ---- arithmetic done by the server ---------------------------------------------------------

    @Test
    void theServerComputesEveryAmountAndIgnoresClientTotals() {
        Map<String, Object> body = draftWith(w.cashierPerson.userId(),
                List.of(line("Cement bags", 10, 12_500, 0, "STANDARD", 1800), line("Paint 5L", 3, 22_000, 3_000, "STANDARD", 1800)), "EXCLUSIVE");
        body.put("grandTotal", 1);
        body.put("subtotal", 1);
        var created = w.owner.post(inv(""), body);
        assertThat(created.status()).isEqualTo(201);
        var json = created.json();
        // lines: 125,000 + 66,000 gross; discount 3,000; tax 18% of 125,000 and of 63,000.
        assertThat(json.path("subtotal").asLong()).isEqualTo(191_000);
        assertThat(json.path("discountTotal").asLong()).isEqualTo(3_000);
        assertThat(json.path("taxTotal").asLong()).isEqualTo(22_500 + 11_340);
        assertThat(json.path("grandTotal").asLong()).isEqualTo(191_000 - 3_000 + 33_840);
        assertThat(json.path("paymentStatus").asString()).isEqualTo("UNPAID");
        assertThat(json.path("payment").path("remainingBalance").asLong()).isEqualTo(221_840);
    }

    @Test
    void inclusivePricingAndHalfUpRoundingMatchTheDocumentedRules() {
        var created = w.owner.post(inv(""), draftWith(w.cashierPerson.userId(),
                List.of(line("Printer paper", 12, 6_000, 0, "STANDARD", 1800)), "INCLUSIVE"));
        assertThat(created.json().path("grandTotal").asLong()).isEqualTo(72_000);
        assertThat(created.json().path("taxTotal").asLong()).isEqualTo(10_983); // 72,000 x 1800 / 11,800 = 10,983.05
        var fractional = w.owner.post(inv(""), draftWith(w.cashierPerson.userId(),
                List.of(line("Rice", 1.5, 1_001, 0, "NOT_APPLICABLE", 0)), "EXCLUSIVE"));
        assertThat(fractional.json().path("grandTotal").asLong()).isEqualTo(1_502); // 1,501.5 rounds half up
    }

    @Test
    void invalidAmountsAreRejected() {
        var cashier = w.cashierPerson.userId();
        assertThat(w.owner.post(inv(""), draftWith(cashier, List.of(line("x", 1, 1000, 2000, "NOT_APPLICABLE", 0)), "EXCLUSIVE")).status()).isEqualTo(422);
        assertThat(w.owner.post(inv(""), draftWith(cashier, List.of(line("x", 1.2345, 1000, 0, "NOT_APPLICABLE", 0)), "EXCLUSIVE")).status()).isEqualTo(422);
        assertThat(w.owner.post(inv(""), draftWith(cashier, List.of(line("x", 0, 1000, 0, "NOT_APPLICABLE", 0)), "EXCLUSIVE")).status()).isEqualTo(422);
        assertThat(w.owner.post(inv(""), draftWith(cashier, List.of(line("x", 1, -5, 0, "NOT_APPLICABLE", 0)), "EXCLUSIVE")).status()).isEqualTo(422);
        assertThat(w.owner.post(inv(""), draftWith(cashier, List.of(line("x", 1, 1000, 0, "STANDARD", 20_000)), "EXCLUSIVE")).status()).isEqualTo(422);
        assertThat(w.owner.post(inv(""), draftWith(cashier, List.of(), "EXCLUSIVE")).status()).isEqualTo(422);
    }

    // ---- lifecycle -----------------------------------------------------------------------------

    @Test
    void draftsAreEditableIssuedInvoicesAreFrozenAndNumbersNeverRepeat() {
        var first = w.owner.post(inv(""), w.draft(w.cashierPerson.userId(), 5_000));
        var second = w.owner.post(inv(""), w.draft(w.cashierPerson.userId(), 6_000));
        assertThat(first.json().path("invoiceNumber").asString()).isEqualTo("INV-0001");
        assertThat(second.json().path("invoiceNumber").asString()).isEqualTo("INV-0002");

        UUID id = UUID.fromString(first.json().path("id").asString());
        long version = first.json().path("version").asLong();
        var edited = w.owner.put(inv("/" + id + "?expectedVersion=" + version), w.draft(w.cashierPerson.userId(), 7_000));
        assertThat(edited.status()).isEqualTo(200);
        assertThat(edited.json().path("grandTotal").asLong()).isEqualTo(7_000);

        var issued = w.owner.post(inv("/" + id + "/issue?expectedVersion=" + edited.json().path("version").asLong()), null);
        assertThat(issued.status()).isEqualTo(200);
        assertThat(issued.json().path("status").asString()).isEqualTo("ISSUED");
        assertThat(issued.json().path("paymentStatus").asString()).isEqualTo("UNPAID");

        var editIssued = w.owner.put(inv("/" + id + "?expectedVersion=" + issued.json().path("version").asLong()), w.draft(w.cashierPerson.userId(), 1));
        assertThat(editIssued.status()).isEqualTo(409);
        assertThat(editIssued.code()).isEqualTo("invalid_transition");
        var cancelIssued = w.owner.post(inv("/" + id + "/cancel?expectedVersion=" + issued.json().path("version").asLong()), null);
        assertThat(cancelIssued.code()).isEqualTo("invalid_transition");

        // Cancelled drafts keep their number: the next one is still 3.
        UUID secondId = UUID.fromString(second.json().path("id").asString());
        assertThat(w.owner.post(inv("/" + secondId + "/cancel?expectedVersion=" + second.json().path("version").asLong()), null).status()).isEqualTo(200);
        assertThat(w.owner.post(inv(""), w.draft(w.cashierPerson.userId(), 1_000)).json().path("invoiceNumber").asString()).isEqualTo("INV-0003");
    }

    @Test
    void staleVersionsAreRejectedSoNobodyOverwritesAnotherUsersChange() {
        var created = w.owner.post(inv(""), w.draft(w.cashierPerson.userId(), 5_000));
        UUID id = UUID.fromString(created.json().path("id").asString());
        long version = created.json().path("version").asLong();
        assertThat(w.manager.put(inv("/" + id + "?expectedVersion=" + version), w.draft(w.cashierPerson.userId(), 6_000)).status()).isEqualTo(200);
        var stale = w.owner.put(inv("/" + id + "?expectedVersion=" + version), w.draft(w.cashierPerson.userId(), 9_000));
        assertThat(stale.status()).isEqualTo(409);
        assertThat(stale.code()).isEqualTo("version_conflict");
        assertThat(w.owner.post(inv("/" + id + "/issue?expectedVersion=" + version), null).code()).isEqualTo("version_conflict");
    }

    @Test
    void issuedInvoiceAmountsAreImmutableEvenToDirectSql() {
        UUID id = w.issuedInvoice(10_000);
        assertThatThrownBy(() -> jdbc.update("update invoices set grand_total_rwf = 1, subtotal_rwf = 1 where id = ?", id))
                .hasMessageContaining("immutable");
        assertThatThrownBy(() -> jdbc.update("update invoice_items set unit_price_rwf = 1 where invoice_id = ?", id))
                .hasMessageContaining("immutable");
        assertThatThrownBy(() -> jdbc.update("update invoices set status = 'DRAFT' where id = ?", id))
                .hasMessageContaining("illegal invoice status transition");
    }

    @Test
    void theDatabaseRefusesArithmeticThatDoesNotAddUp() {
        UUID id = w.issuedInvoice(10_000);
        UUID draft = UUID.fromString(w.owner.post(inv(""), w.draft(w.cashierPerson.userId(), 5_000)).json().path("id").asString());
        assertThatThrownBy(() -> jdbc.update("update invoices set grand_total_rwf = grand_total_rwf + 1 where id = ?", draft))
                .hasMessageContaining("ck_invoices_identity");
        assertThat(id).isNotNull();
    }

    @Test
    void onlyOwnersVoidAndOnlyWithAReason() {
        UUID id = w.issuedInvoice(10_000);
        long version = w.owner.get(inv("/" + id)).json().path("version").asLong();
        assertThat(w.manager.post(inv("/" + id + "/void?expectedVersion=" + version), Map.of("reason", "Wrong customer")).status()).isEqualTo(403);
        assertThat(w.cashier.post(inv("/" + id + "/void?expectedVersion=" + version), Map.of("reason", "Wrong customer")).status()).isEqualTo(403);
        assertThat(w.owner.post(inv("/" + id + "/void?expectedVersion=" + version), Map.of("reason", "x")).status()).isEqualTo(422);
        var voided = w.owner.post(inv("/" + id + "/void?expectedVersion=" + version), Map.of("reason", "Issued to the wrong customer"));
        assertThat(voided.status()).isEqualTo(200);
        assertThat(voided.json().path("status").asString()).isEqualTo("VOIDED");
        assertThat(voided.json().path("voidReason").asString()).isEqualTo("Issued to the wrong customer");
    }

    @Test
    void issuingNeedsAnEligibleAssigneeAndAnActiveBranch() {
        var created = w.owner.post(inv(""), w.draft(w.cashierPerson.userId(), 5_000));
        UUID id = UUID.fromString(created.json().path("id").asString());
        // The cashier stops working at the branch between draft and issue.
        jdbc.update("update branch_assignments set status = 'ENDED', ended_at = now() where membership_id = ?", w.cashierMembershipId);
        var issue = w.owner.post(inv("/" + id + "/issue?expectedVersion=" + created.json().path("version").asLong()), null);
        assertThat(issue.status()).isEqualTo(409);
        assertThat(issue.code()).isEqualTo("assignee_not_eligible");
    }

    @Test
    void draftsRejectUnassignedPeopleInactiveBranchesAndOtherBusinesses() {
        Map<String, Object> inactive = new HashMap<>(w.draft(w.cashierPerson.userId(), 1000));
        inactive.put("branchId", w.inactiveBranchId.toString());
        var inactiveResponse = w.owner.post(inv(""), inactive);
        assertThat(inactiveResponse.status()).isEqualTo(409);
        assertThat(inactiveResponse.code()).isEqualTo("branch_inactive");

        var stranger = w.owner.post(inv(""), w.draft(w.cafePerson.userId(), 1000));
        assertThat(stranger.code()).isEqualTo("assignee_not_eligible");

        Map<String, Object> foreignBranch = new HashMap<>(w.draft(w.cashierPerson.userId(), 1000));
        foreignBranch.put("branchId", w.cafeBranchId.toString());
        assertThat(w.owner.post(inv(""), foreignBranch).status()).isEqualTo(422);
    }

    // ---- record-level authorisation and isolation -----------------------------------------------

    @Test
    void cashiersSeeAndTouchOnlyInvoicesAssignedToThem() {
        UUID mine = UUID.fromString(w.owner.post(inv(""), w.draft(w.cashierPerson.userId(), 1_000)).json().path("id").asString());
        UUID theirs = UUID.fromString(w.owner.post(inv(""), w.draft(w.otherCashierPerson.userId(), 2_000)).json().path("id").asString());

        var list = w.cashier.get(inv(""));
        assertThat(list.json().path("items").size()).isEqualTo(1);
        assertThat(list.json().path("items").get(0).path("id").asString()).isEqualTo(mine.toString());
        assertThat(list.json().path("totalCount").asInt()).isEqualTo(1);

        var peek = w.cashier.get(inv("/" + theirs));
        assertThat(peek.status()).isEqualTo(404);
        assertThat(peek.body()).isEqualTo(w.cashier.get(inv("/" + UUID.randomUUID())).body());
        assertThat(w.cashier.put(inv("/" + theirs + "?expectedVersion=0"), w.draft(w.cashierPerson.userId(), 1)).status()).isEqualTo(404);
        assertThat(w.cashier.post(inv("/" + theirs + "/issue?expectedVersion=0"), null).status()).isEqualTo(404);
        assertThat(w.owner.get(inv("")).json().path("items").size()).isEqualTo(2);
    }

    @Test
    void cashiersCreateOnlyForThemselves() {
        assertThat(w.cashier.post(inv(""), w.draft(w.cashierPerson.userId(), 1_000)).status()).isEqualTo(201);
        assertThat(w.cashier.post(inv(""), w.draft(w.otherCashierPerson.userId(), 1_000)).status()).isEqualTo(403);
        var options = w.cashier.get(inv("/form-options")).json();
        assertThat(options.path("assignees").size()).isEqualTo(1);
        assertThat(w.owner.get(inv("/form-options")).json().path("assignees").size()).isEqualTo(3);
    }

    @Test
    void anotherBusinessCannotReadOrChangeThisBusinessInvoices() {
        UUID id = w.issuedInvoice(10_000);
        String cafe = "/api/v1/merchants/" + w.cafeMerchantId + "/invoices";
        // Using the right invoice id under the cafe's own merchant id finds nothing.
        assertThat(w.cafeOwner.get(cafe + "/" + id).status()).isEqualTo(404);
        // Using the shop's merchant id is refused outright.
        assertThat(w.cafeOwner.get(inv("/" + id)).status()).isEqualTo(404);
        assertThat(w.cafeOwner.get(cafe).json().path("items").size()).isZero();
        assertThat(w.cafeOwner.post(inv(""), w.draft(w.cashierPerson.userId(), 1)).status()).isEqualTo(404);
    }

    @Test
    void noOneCanMarkAnInvoicePaidThroughTheInvoiceApi() {
        UUID id = w.issuedInvoice(10_000);
        long version = w.owner.get(inv("/" + id)).json().path("version").asLong();
        Map<String, Object> forged = new HashMap<>(w.draft(w.cashierPerson.userId(), 10_000));
        forged.put("paymentStatus", "PAID");
        forged.put("status", "ISSUED");
        w.owner.put(inv("/" + id + "?expectedVersion=" + version), forged);
        assertThat(w.owner.get(inv("/" + id)).json().path("paymentStatus").asString()).isEqualTo("UNPAID");
        assertThat(w.owner.get(inv("/" + id)).json().path("payment").path("allocatedAmount").asLong()).isZero();
    }
}
