package rw.oupay.support;

import java.util.List;
import java.util.Map;
import java.util.UUID;
import rw.oupay.membership.MembershipStatus;
import rw.oupay.membership.Role;

/**
 * A realistic small world, built through the real API where it matters:
 * <ul>
 *   <li>Shop: owner (registers the business), manager, two cashiers, one active branch both
 *       cashiers work at, one inactive branch.</li>
 *   <li>Cafe: a second business with its own owner, for isolation tests.</li>
 * </ul>
 */
public class World {

    public TestApi owner;
    public TestApi manager;
    public TestApi cashier;
    public TestApi otherCashier;
    public TestApi cafeOwner;

    public Fixtures.Person ownerPerson;
    public Fixtures.Person managerPerson;
    public Fixtures.Person cashierPerson;
    public Fixtures.Person otherCashierPerson;
    public Fixtures.Person cafePerson;

    public UUID merchantId;
    public UUID cafeMerchantId;
    public UUID branchId;
    public UUID inactiveBranchId;
    public UUID cafeBranchId;
    public UUID cashierMembershipId;
    public UUID managerMembershipId;
    public UUID ownerMembershipId;
    public Bank bank;

    public static World create(IntegrationTest test) {
        World w = new World();
        var f = test.fixtures;
        var mvc = test.mvc;
        w.ownerPerson = f.user("owner@shop.rw", "Olive Owner");
        w.managerPerson = f.user("manager@shop.rw", "Grace Manager");
        w.cashierPerson = f.user("aline@shop.rw", "Aline Cashier");
        w.otherCashierPerson = f.user("eric@shop.rw", "Eric Cashier");
        w.cafePerson = f.user("owner@cafe.rw", "Claudine Cafe");

        w.owner = f.signIn(mvc, w.ownerPerson);
        w.merchantId = w.createMerchant(w.owner, "Sample Shop Ltd", "123456789", "RC-1001");
        w.cafeOwner = f.signIn(mvc, w.cafePerson);
        w.cafeMerchantId = w.createMerchant(w.cafeOwner, "Sample Cafe", "987654321", "RC-2002");

        w.ownerMembershipId = test.jdbc.queryForObject("select id from memberships where merchant_id = ? and role = 'OWNER'", UUID.class, w.merchantId);
        w.managerMembershipId = f.member(w.merchantId, w.managerPerson, Role.MANAGER, MembershipStatus.ACTIVE);
        w.cashierMembershipId = f.member(w.merchantId, w.cashierPerson, Role.CASHIER, MembershipStatus.ACTIVE);
        UUID otherCashierMembership = f.member(w.merchantId, w.otherCashierPerson, Role.CASHIER, MembershipStatus.ACTIVE);

        w.branchId = f.branch(w.merchantId, "RM01", "ACTIVE");
        w.inactiveBranchId = f.branch(w.merchantId, "OLD1", "INACTIVE");
        w.cafeBranchId = f.branch(w.cafeMerchantId, "CAF1", "ACTIVE");
        f.assign(w.merchantId, w.cashierMembershipId, w.branchId);
        f.assign(w.merchantId, otherCashierMembership, w.branchId);
        f.assign(w.merchantId, w.managerMembershipId, w.branchId);
        f.assign(w.cafeMerchantId, test.jdbc.queryForObject("select id from memberships where merchant_id = ?", UUID.class, w.cafeMerchantId), w.cafeBranchId);

        w.bank = Bank.link(mvc, w.owner, w.merchantId);
        w.manager = f.signIn(mvc, w.managerPerson);
        w.cashier = f.signIn(mvc, w.cashierPerson);
        w.otherCashier = f.signIn(mvc, w.otherCashierPerson);
        return w;
    }

    private UUID createMerchant(TestApi api, String name, String tin, String registrationNumber) {
        var response = api.post("/api/v1/merchants", Map.of(
                "legalName", name, "businessType", "registered_company",
                "registration", Map.of("tin", tin, "registrationNumber", registrationNumber),
                "location", Map.of("province", "Kigali City", "district", "Gasabo", "sector", "Remera", "physicalAddress", "KG 11 Ave"),
                "contact", Map.of("fullName", "Contact Person", "email", "contact@example.rw", "phoneNumber", "+250788123456")));
        if (response.status() != 201) {
            throw new IllegalStateException("merchant creation failed: " + response.body());
        }
        return UUID.fromString(response.json().path("id").asString());
    }

    /** A valid invoice draft body for the shop: one line, 18% VAT exclusive. */
    public Map<String, Object> draft(UUID assignee, long unitPrice) {
        return Map.of(
                "branchId", branchId.toString(),
                "assignedToUserId", assignee.toString(),
                "customer", Map.of("name", "Imena Stationery"),
                "items", List.of(Map.of("description", "Printer paper", "quantity", 1, "unitPrice", unitPrice, "discount", 0,
                        "taxRate", Map.of("category", "NOT_APPLICABLE", "rateBp", 0))),
                "taxMode", "EXCLUSIVE",
                "dueAt", java.time.LocalDate.now().plusDays(14).toString());
    }

    /** Creates and issues an invoice (no tax) of exactly {@code total} RWF; returns its id. */
    public UUID issuedInvoice(long total) {
        var created = owner.post("/api/v1/merchants/" + merchantId + "/invoices", draft(cashierPerson.userId(), total));
        if (created.status() != 201) {
            throw new IllegalStateException("draft failed: " + created.body());
        }
        UUID id = UUID.fromString(created.json().path("id").asString());
        long version = created.json().path("version").asLong();
        var issued = owner.post("/api/v1/merchants/" + merchantId + "/invoices/" + id + "/issue?expectedVersion=" + version, null);
        if (issued.status() != 200) {
            throw new IllegalStateException("issue failed: " + issued.body());
        }
        return id;
    }
}
