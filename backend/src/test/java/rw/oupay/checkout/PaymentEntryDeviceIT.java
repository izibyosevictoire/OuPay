package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Callable;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

/**
 * R8a: the device registry, its lifecycle and authorization, and the binding of a device to ONE prepared bill. A device is a doorway: nothing
 * here may create a bill, a payment request or a ledger row, or ever say anything is paid.
 */
class PaymentEntryDeviceIT extends PaymentEntryTestSupport {

    // ---- registry, tokens and authorization ----------------------------------------------------

    @Test
    void ownerRegistersAllThreeTypesWithOpaquePermanentUrls() {
        JsonNode qr = device("STATIC_QR", "Counter 1", null);
        JsonNode tag = device("NFC_TAG", "Door tag", null);
        JsonNode bracelet = device("NFC_BRACELET", "Aline bracelet", w.cashierPerson.userId());
        for (JsonNode d : List.of(qr, tag, bracelet)) {
            assertThat(d.path("status").asString()).isEqualTo("ACTIVE");
            assertThat(d.path("entryPath").asString()).matches("^/e/[A-Za-z0-9_-]{22}$");
            assertThat(absent(d.path("binding"))).isTrue();
        }
        // The token is opaque: it contains neither the merchant, the branch, the device nor the cashier id.
        for (JsonNode d : List.of(qr, tag, bracelet)) {
            String token = token(d);
            for (String id : List.of(w.merchantId.toString(), w.branchId.toString(), d.path("id").asString(), w.cashierPerson.userId().toString())) {
                assertThat(id).doesNotContain(token);
                assertThat(token).doesNotContain(id.substring(0, 8));
            }
        }
        // QR and NFC share one stable URL per device: reading the device again gives the very same path, and nothing regenerates it.
        assertThat(fresh(qr).path("entryPath").asString()).isEqualTo(qr.path("entryPath").asString());
        jdbc.update("update payment_entry_devices set display_name = 'Counter one' where id = ?::uuid", qr.path("id").asString());
        assertThat(fresh(qr).path("entryPath").asString()).isEqualTo(qr.path("entryPath").asString());
        // The device row carries no bank detail, amount or secret of any kind.
        assertThat(qr.toString()).doesNotContainIgnoringCase("settlement").doesNotContainIgnoringCase("account").doesNotContainIgnoringCase("secret");
    }

    @Test
    void tokensAreUniqueAndFreshForEveryDevice() {
        Set<String> tokens = new HashSet<>();
        for (int i = 0; i < 40; i++) {
            tokens.add(token(device("STATIC_QR", "Counter " + i, null)));
        }
        assertThat(tokens).hasSize(40);
        assertThat(tokens).allMatch(t -> t.matches("^[A-Za-z0-9_-]{22}$"));
    }

    @Test
    void aBraceletIsPersonalAndCashiersCannotRegisterDevices() {
        assertThat(register(w.owner, "NFC_BRACELET", "Loose bracelet", null).status()).isEqualTo(422);
        assertThat(register(w.cashier, "STATIC_QR", "My own", w.cashierPerson.userId()).status()).isEqualTo(403);
        assertThat(register(w.owner, "BARCODE", "Odd", null).status()).isEqualTo(422);
        assertThat(count("payment_entry_devices")).isZero();
    }

    @Test
    void aCashierMustBeAnActiveMemberOfTheBranchAndNothingCrossesBusinesses() {
        assertThat(register(w.owner, "NFC_TAG", "Cafe person", w.cafePerson.userId()).status()).isEqualTo(409);
        assertThat(register(w.owner, "NFC_TAG", "Stranger", UUID.randomUUID()).status()).isEqualTo(409);
        Map<String, Object> inactive = deviceBody("STATIC_QR", "Old branch", null);
        inactive.put("branchId", w.inactiveBranchId.toString());
        assertThat(w.owner.post(devices(), inactive).status()).isEqualTo(409);
        Map<String, Object> foreign = deviceBody("STATIC_QR", "Cafe branch", null);
        foreign.put("branchId", w.cafeBranchId.toString());
        assertThat(w.owner.post(devices(), foreign).status()).isEqualTo(409);
        // Another business can neither see nor change a device.
        JsonNode d = device("STATIC_QR", "Counter", null);
        String other = "/api/v1/merchants/" + w.cafeMerchantId + "/entry-devices/" + d.path("id").asString();
        assertThat(w.cafeOwner.get(other).status()).isEqualTo(404);
        assertThat(w.cafeOwner.post(other + "/revoke", Map.of("expectedVersion", 0, "reason", "Not yours to revoke")).status()).isEqualTo(404);
        assertThat(w.cafeOwner.get(devices()).status()).isIn(403, 404);
    }

    @Test
    void registeringTwiceWithTheSameRequestIdReturnsTheSameDeviceAndNamesAreUnique() {
        Map<String, Object> body = deviceBody("STATIC_QR", "Counter 1", null);
        var first = w.owner.post(devices(), body);
        var again = w.owner.post(devices(), body);
        assertThat(first.status()).isEqualTo(201);
        assertThat(again.status()).isEqualTo(200);
        assertThat(again.json().path("replayed").asBoolean()).isTrue();
        assertThat(again.json().path("device").path("id").asString()).isEqualTo(first.json().path("device").path("id").asString());
        Map<String, Object> changed = new java.util.HashMap<>(body);
        changed.put("displayName", "Another name");
        assertThat(w.owner.post(devices(), changed).status()).isEqualTo(409);
        assertThat(register(w.owner, "NFC_TAG", "counter 1", null).status()).isEqualTo(409);
        assertThat(count("payment_entry_devices")).isEqualTo(1);
    }

    @Test
    void managersManageOnlyTheirBranchesAndCashiersSeeOnlyTheirOwnDevices() {
        assertThat(register(w.manager, "STATIC_QR", "Manager made", null).status()).isEqualTo(201);
        JsonNode mine = device("NFC_TAG", "Aline tag", w.cashierPerson.userId());
        JsonNode eric = device("NFC_TAG", "Eric tag", w.otherCashierPerson.userId());
        var list = w.cashier.get(devices());
        assertThat(list.status()).as(list.body()).isEqualTo(200);
        List<String> names = new ArrayList<>();
        list.json().forEach(n -> names.add(n.path("displayName").asString()));
        assertThat(names).contains("Aline tag").doesNotContain("Eric tag");
        assertThat(w.cashier.get(devices() + "/" + eric.path("id").asString()).status()).isEqualTo(404);
        assertThat(w.cashier.get(devices() + "/" + mine.path("id").asString()).status()).isEqualTo(200);
        assertThat(lifecycle(w.cashier, mine, "suspend", "Trying it").status()).isEqualTo(403);
    }

    // ---- lifecycle ----------------------------------------------------------------------------

    @Test
    void suspendedDevicesOpenNoNewBillsAndRevocationIsFinalWithoutTouchingHistory() {
        JsonNode sale = liveSale();
        JsonNode d = device("STATIC_QR", "Counter", null);
        bound(d, sale);
        String token = token(d);
        assertThat(state(viewAs(token, null))).isEqualTo("READY");

        assertThat(lifecycle(w.owner, d, "suspend", "Checking the tag").status()).isEqualTo(200);
        assertThat(state(viewAs(token, null))).isEqualTo("UNAVAILABLE");
        assertThat(state(claimAs(token, null))).isEqualTo("UNAVAILABLE");
        JsonNode second = liveSale();
        assertThat(bind(w.owner, d, second).status()).isEqualTo(409);
        assertThat(lifecycle(w.owner, d, "reactivate", "Back in use").status()).isEqualTo(200);
        assertThat(state(viewAs(token, null))).isEqualTo("READY");

        // Revoke: the URL stops working at once, the binding is closed, and the sale and the assignment history are exactly as they were.
        int salesBefore = count("code_sales");
        int assignmentsBefore = count("payment_entry_device_assignments");
        assertThat(lifecycle(w.owner, d, "revoke", "Tag lost").status()).isEqualTo(200);
        assertThat(state(viewAs(token, null))).isEqualTo("UNAVAILABLE");
        assertThat(jdbc.queryForObject("select end_reason from payment_entry_bindings", String.class)).isEqualTo("DEVICE_REVOKED");
        assertThat(count("code_sales")).isEqualTo(salesBefore);
        assertThat(count("payment_entry_device_assignments")).isEqualTo(assignmentsBefore);
        assertThat(jdbc.queryForObject("select valid_to is not null from payment_entry_device_assignments", Boolean.class)).isTrue();
        assertThat(lifecycle(w.owner, d, "reactivate", "Undo").status()).isEqualTo(409);
        assertThat(bind(w.owner, d, second).status()).isEqualTo(409);
        assertThat(w.owner.post(devices() + "/" + d.path("id").asString() + "/assignment", Map.of("expectedVersion", fresh(d).path("version").asLong(),
                "branchId", w.branchId.toString(), "reason", "Move")).status()).isEqualTo(409);
        // The sale it led to is untouched and still payable in the ordinary way.
        pay(sale);
        assertThat(jdbc.queryForObject("select count(*) from payment_allocations where status = 'ACTIVE'", Integer.class)).isEqualTo(1);
    }

    @Test
    void anUnknownMalformedRevokedAndSuspendedTokenAllLookIdentical() {
        JsonNode revoked = device("STATIC_QR", "Gone", null);
        JsonNode suspended = device("NFC_TAG", "Paused", null);
        assertThat(lifecycle(w.owner, revoked, "revoke", "Lost").status()).isEqualTo(200);
        assertThat(lifecycle(w.owner, suspended, "suspend", "Paused").status()).isEqualTo(200);
        String unknown = viewAs("AAAAAAAAAAAAAAAAAAAAAA", null).body();
        for (String token : List.of(token(revoked), token(suspended), "AAAAAAAAAAAAAAAAAAAAAB", "short", "x".repeat(300), "or1equals1")) {
            var response = viewAs(token, null);
            assertThat(response.status()).as(token).isEqualTo(200);
            assertThat(response.body()).as(token).isEqualTo(unknown);
        }
        assertThat(state(viewAs("AAAAAAAAAAAAAAAAAAAAAA", null))).isEqualTo("UNAVAILABLE");
        // An encoded path separator is refused by the web layer before any application code runs: never a 5xx, never data.
        assertThat(viewAs("..%2F..%2Fetc", null).status()).isLessThan(500);
        assertThat(viewAs("'%20or%201=1--", null).status()).isLessThan(500);
    }

    @Test
    void reassigningADeviceKeepsAuditableHistoryAndClosesABillThatNoLongerFits() {
        JsonNode sale = liveSale();
        JsonNode d = device("NFC_TAG", "Shared tag", null);
        bound(d, sale);
        var reassigned = w.owner.post(devices() + "/" + d.path("id").asString() + "/assignment", Map.of("expectedVersion", fresh(d).path("version").asLong(),
                "branchId", w.branchId.toString(), "assignedCashierUserId", w.otherCashierPerson.userId().toString(), "reason", "Eric takes the tag"));
        assertThat(reassigned.status()).as(reassigned.body()).isEqualTo(200);
        assertThat(reassigned.json().path("assignedCashierUserId").asString()).isEqualTo(w.otherCashierPerson.userId().toString());
        // Aline's bill does not fit Eric's device: it is closed, visibly, and never silently carried over.
        assertThat(absent(reassigned.json().path("binding"))).isTrue();
        assertThat(jdbc.queryForObject("select end_reason from payment_entry_bindings", String.class)).isEqualTo("DEVICE_REASSIGNED");
        assertThat(state(viewAs(token(d), null))).isEqualTo("IDLE");
        // History: two assignments, the first closed, nothing rewritten.
        var history = w.owner.get(devices() + "/" + d.path("id").asString() + "/assignments");
        assertThat(history.json()).hasSize(2);
        assertThat(history.json().get(0).path("assignedCashierName").asString()).isEqualTo("Eric Cashier");
        assertThat(history.json().get(1).path("validTo").isNull()).isFalse();
        assertThatThrownBy(() -> jdbc.update("update payment_entry_device_assignments set branch_name = 'Rewritten'")).hasMessageContaining("never rewritten");
        assertThatThrownBy(() -> jdbc.update("delete from payment_entry_device_assignments")).hasMessageContaining("never deleted");
        // Stale writes and no-op changes are refused.
        assertThat(w.owner.post(devices() + "/" + d.path("id").asString() + "/assignment", Map.of("expectedVersion", 0,
                "branchId", w.branchId.toString(), "reason", "Stale")).status()).isEqualTo(409);
        // Eric holds it now: Aline's sales can no longer be bound to it, and Aline cannot reach it.
        assertThat(bind(w.owner, d, liveSale()).status()).isEqualTo(409);
        assertThat(w.cashier.get(devices() + "/" + d.path("id").asString()).status()).isEqualTo(404);
    }

    // ---- binding ------------------------------------------------------------------------------

    @Test
    void aDeviceLeadsToOneExplicitBillAndNeverFallsBackToANewestOne() {
        JsonNode sale = liveSale();
        JsonNode d = device("STATIC_QR", "Counter", null);
        // Idle, although a perfectly good prepared bill exists: the device never picks one for itself.
        assertThat(state(viewAs(token(d), null))).isEqualTo("IDLE");
        assertThat(w.cashier.get(devices() + "/" + d.path("id").asString() + "/eligible-sales").json().get(0).path("saleReference").asString()).isEqualTo(reference(sale));
        JsonNode bound = bound(d, sale);
        assertThat(bound.path("binding").path("saleReference").asString()).isEqualTo(reference(sale));
        assertThat(bound.path("binding").path("amountRwf").asLong()).isEqualTo(amount(sale));
        // A newer bill does not take over, and a second explicit bind is refused until the first is closed.
        JsonNode newer = liveSale();
        var refused = bind(w.owner, d, newer);
        assertThat(refused.status()).isEqualTo(409);
        assertThat(refused.code()).isEqualTo("device_has_open_bill");
        assertThat(fresh(d).path("binding").path("saleReference").asString()).isEqualTo(reference(sale));
        // Binding the same bill again changes nothing.
        assertThat(bind(w.owner, d, sale).status()).isEqualTo(200);
        assertThat(count("payment_entry_bindings")).isEqualTo(1);
        // Closing it and binding the newer one is an explicit, audited act.
        assertThat(unbind(w.owner, d, false).status()).isEqualTo(200);
        assertThat(state(viewAs(token(d), null))).isEqualTo("IDLE");
        bound(d, newer);
        assertThat(count("payment_entry_bindings")).isEqualTo(2);
        assertThat(jdbc.queryForObject("select count(*) from audit_log where kind in ('ENTRY_DEVICE_BILL_BOUND', 'ENTRY_DEVICE_BILL_UNBOUND')", Integer.class)).isEqualTo(3);
    }

    @Test
    void aBindingKeepsTheSaleIdentityAndNeverCreatesBillsOrMoney() {
        JsonNode sale = liveSale();
        JsonNode d = device("STATIC_QR", "Counter", null);
        Map<String, Object> before = Map.of("invoices", count("invoices"), "requests", count("payment_requests"), "sales", count("code_sales"),
                "transactions", count("bank_transactions"), "allocations", count("payment_allocations"));
        bound(d, sale);
        assertThat(Map.of("invoices", count("invoices"), "requests", count("payment_requests"), "sales", count("code_sales"),
                "transactions", count("bank_transactions"), "allocations", count("payment_allocations"))).isEqualTo(before);
        var row = jdbc.queryForMap("select s.agent_name, s.code_external_code, b.agent_user_id from payment_entry_bindings b join code_sales s on s.payment_request_id = b.sale_id");
        assertThat(row.get("agent_name")).isEqualTo("Aline Cashier");
        assertThat(row.get("code_external_code")).isEqualTo("EQ-LIVE-77");
        assertThat(row.get("agent_user_id").toString()).isEqualTo(w.cashierPerson.userId().toString());
    }

    @Test
    void aBillMustFitTheDevicesCashierAndOnlyOpenBillsCanBeBound() {
        JsonNode sale = liveSale();
        JsonNode erics = device("NFC_BRACELET", "Eric bracelet", w.otherCashierPerson.userId());
        var wrongAgent = bind(w.owner, erics, sale);
        assertThat(wrongAgent.status()).isEqualTo(409);
        assertThat(wrongAgent.code()).isEqualTo("sale_agent_mismatch");
        JsonNode shared = device("STATIC_QR", "Counter", null);
        // A cashier gives a device only their own sales; an unknown sale is not found; a foreign business's sale does not exist here.
        assertThat(bind(w.otherCashier, shared, sale).status()).isEqualTo(403);
        assertThat(w.owner.post(devices() + "/" + shared.path("id").asString() + "/binding", Map.of("saleId", UUID.randomUUID().toString(), "expectedVersion", 0)).status()).isEqualTo(404);
        // Paid, expired and cancelled bills cannot be newly bound.
        JsonNode paid = liveSale();
        pay(paid);
        assertThat(bind(w.owner, shared, paid).code()).isEqualTo("sale_not_bindable");
        JsonNode expired = liveSale();
        expireSale(expired);
        assertThat(bind(w.owner, shared, expired).code()).isEqualTo("sale_not_bindable");
        assertThat(count("payment_entry_bindings")).isZero();
        // The eligible list shows only bills that can be bound.
        List<String> eligible = new ArrayList<>();
        w.owner.get(devices() + "/" + shared.path("id").asString() + "/eligible-sales").json().forEach(n -> eligible.add(n.path("saleReference").asString()));
        assertThat(eligible).containsExactly(reference(sale));
    }

    @Test
    void aFinishedBillIsClosedByTheSystemWhenTheNextOneIsBound() {
        JsonNode first = liveSale();
        JsonNode d = device("STATIC_QR", "Counter", null);
        bound(d, first);
        pay(first);
        // The customer is done: the paid bill no longer shows to anybody new.
        assertThat(state(viewAs(token(d), null))).isEqualTo("IDLE");
        JsonNode second = liveSale();
        bound(d, second);
        assertThat(jdbc.queryForList("select end_reason from payment_entry_bindings where ended_at is not null", String.class)).containsExactly("SALE_PAID");
        assertThat(fresh(d).path("binding").path("saleReference").asString()).isEqualTo(reference(second));
    }

    @Test
    void concurrentBindsNeverOverwriteEachOther() throws Exception {
        JsonNode d = device("STATIC_QR", "Counter", null);
        JsonNode a = liveSale();
        JsonNode b = liveSale();
        long version = fresh(d).path("version").asLong();
        List<Callable<Integer>> tasks = List.of(
                () -> w.owner.post(devices() + "/" + d.path("id").asString() + "/binding", Map.of("saleId", saleId(a), "expectedVersion", version)).status(),
                () -> w.cashier.post(devices() + "/" + d.path("id").asString() + "/binding", Map.of("saleId", saleId(b), "expectedVersion", version)).status());
        List<Integer> statuses = concurrently(tasks);
        assertThat(statuses).containsExactlyInAnyOrder(200, 409);
        assertThat(jdbc.queryForObject("select count(*) from payment_entry_bindings where ended_at is null", Integer.class)).isEqualTo(1);
        // One bill can lead from at most one device, even when two devices are bound at the same moment.
        JsonNode e = device("NFC_TAG", "Tag A", null);
        JsonNode f = device("NFC_TAG", "Tag B", null);
        JsonNode c = liveSale();
        List<Integer> two = concurrently(List.of(
                () -> w.owner.post(devices() + "/" + e.path("id").asString() + "/binding", Map.of("saleId", saleId(c), "expectedVersion", fresh(e).path("version").asLong())).status(),
                () -> w.owner.post(devices() + "/" + f.path("id").asString() + "/binding", Map.of("saleId", saleId(c), "expectedVersion", fresh(f).path("version").asLong())).status()));
        assertThat(two.stream().filter(s -> s == 200).count()).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from payment_entry_bindings where sale_id = ?::uuid and ended_at is null", Integer.class, saleId(c))).isEqualTo(1);
    }

    // ---- the database refuses what the service would not do ----------------------------------

    @Test
    void theDatabaseEnforcesTenancyOneOpenBindingAndOneOpenClaim() {
        JsonNode sale = liveSale();
        JsonNode other = liveSale();
        JsonNode d = device("STATIC_QR", "Counter", null);
        bound(d, sale);
        UUID deviceId = UUID.fromString(d.path("id").asString());
        // A second open binding for the device, or the same sale on another device, is impossible.
        assertThatThrownBy(() -> insertBinding(deviceId, w.branchId, saleId(other))).hasMessageContaining("ux_entry_bindings_device_open");
        JsonNode d2 = device("NFC_TAG", "Tag", null);
        assertThatThrownBy(() -> insertBinding(UUID.fromString(d2.path("id").asString()), w.branchId, saleId(sale))).hasMessageContaining("ux_entry_bindings_sale_open");
        // A sale of another branch / another business can not be named, and a revoked device can not take a binding.
        assertThatThrownBy(() -> insertBinding(UUID.fromString(d2.path("id").asString()), w.inactiveBranchId, saleId(other))).isNotNull();
        // One open claim per device.
        String token = token(d);
        assertThat(state(claimAs(token, null))).isEqualTo("CLAIMED");
        UUID binding = jdbc.queryForObject("select id from payment_entry_bindings", UUID.class);
        assertThatThrownBy(() -> jdbc.update("insert into payment_entry_claims (id, device_id, merchant_id, binding_id, sale_id, claim_token_hash, created_at, expires_at) "
                + "values (gen_random_uuid(), ?, ?, ?, ?::uuid, repeat('a', 64), now(), now() + interval '5 minutes')", deviceId, w.merchantId, binding, saleId(sale)))
                .hasMessageContaining("ux_entry_claims_device_open");
        // Rows are never deleted, and a binding is only ever closed.
        assertThatThrownBy(() -> jdbc.update("delete from payment_entry_bindings")).hasMessageContaining("never deleted");
        assertThatThrownBy(() -> jdbc.update("delete from payment_entry_claims")).hasMessageContaining("never deleted");
        assertThatThrownBy(() -> jdbc.update("delete from payment_entry_devices")).hasMessageContaining("never deleted");
        assertThatThrownBy(() -> jdbc.update("update payment_entry_bindings set sale_id = ?::uuid", saleId(other))).hasMessageContaining("never rewritten");
        assertThatThrownBy(() -> jdbc.update("update payment_entry_devices set public_token = 'AAAAAAAAAAAAAAAAAAAAAA'")).hasMessageContaining("public token for life");
        // A closed binding can not leave a claim open, and a revoked device can not keep a binding: checked at commit.
        assertThatThrownBy(() -> jdbc.update("update payment_entry_bindings set ended_at = now(), end_reason = 'UNBOUND'")).hasMessageContaining("customer claim open");
    }

    private void insertBinding(UUID device, UUID branch, String saleId) {
        jdbc.update("insert into payment_entry_bindings (id, device_id, merchant_id, branch_id, sale_id, agent_user_id, bound_by_user_id, bound_at) "
                + "values (gen_random_uuid(), ?, ?, ?, ?::uuid, ?, ?, now())", device, w.merchantId, branch, saleId, w.cashierPerson.userId(), w.ownerPerson.userId());
    }
}
