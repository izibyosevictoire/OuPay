package rw.oupay.audit;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.World;

class AuditIT extends IntegrationTest {

    World w;

    @BeforeEach
    void world() {
        w = World.create(this);
    }

    private String log() {
        return "/api/v1/merchants/" + w.merchantId + "/audit-log";
    }

    @Test
    void importantActionsLeaveAnAuditTrailThatOwnersAndManagersCanRead() {
        var invoice = w.issuedInvoice(10_000);
        w.bank.pay("POSTED", 4_000, jdbc.queryForObject("select invoice_number from invoices where id = ?", String.class, invoice));
        var entries = w.manager.get(log() + "?limit=200").json();
        var kinds = new java.util.HashSet<String>();
        entries.forEach(e -> kinds.add(e.path("kind").asString()));
        assertThat(kinds).contains("MERCHANT_REGISTERED", "BANK_LINK_COMPLETED", "INVOICE_DRAFT_CREATED", "INVOICE_ISSUED",
                "TRANSACTION_CREATED", "AUTO_ALLOCATED");
        assertThat(w.owner.get(log()).status()).isEqualTo(200);
    }

    @Test
    void cashiersAndOtherBusinessesCannotReadItAndNobodyCanWriteIt() {
        assertThat(w.cashier.get(log()).status()).isEqualTo(403);
        assertThat(w.cafeOwner.get(log()).status()).isEqualTo(404);
        assertThat(w.owner.post(log(), Map.of("message", "forged")).status()).isEqualTo(405);
        assertThat(w.owner.put(log(), Map.of("message", "forged")).status()).isEqualTo(405);
        assertThat(w.owner.delete(log()).status()).isEqualTo(405);
    }

    @Test
    void entriesNeverContainSecretsOrPayloads() {
        w.bank.pay("POSTED", 1_000, "SOME-REFERENCE");
        String all = String.join("\n", jdbc.queryForList("select message from audit_log", String.class));
        assertThat(all.toLowerCase()).doesNotContain("password").doesNotContain("token").doesNotContain("secret")
                .doesNotContain("simulated\":true").doesNotContain("Correct-horse");
    }

    @Test
    void auditEntriesAreWrittenInTheSameTransactionAsTheChange() {
        // A failing operation leaves neither the change nor its audit entry.
        int before = jdbc.queryForObject("select count(*) from audit_log", Integer.class);
        var bad = w.owner.post("/api/v1/merchants/" + w.merchantId + "/branches", Map.of("name", "Xx", "code", "RM01",
                "location", Map.of("province", "p", "district", "d", "sector", "s", "physicalAddress", "a")));
        assertThat(bad.status()).isEqualTo(409);
        assertThat(jdbc.queryForObject("select count(*) from audit_log", Integer.class)).isEqualTo(before);
    }
}
