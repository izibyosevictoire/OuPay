package rw.oupay.demo;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.sql.Timestamp;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.env.Environment;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import rw.oupay.audit.AuditService;
import rw.oupay.auth.AuthDtos;
import rw.oupay.auth.AuthService;
import rw.oupay.auth.AuthenticatedUser;
import rw.oupay.branch.BranchDtos;
import rw.oupay.branch.BranchService;
import rw.oupay.catalog.CatalogDtos;
import rw.oupay.catalog.CatalogItemType;
import rw.oupay.catalog.CatalogService;
import rw.oupay.email.DevMailSink;
import rw.oupay.email.EmailMessage;
import rw.oupay.email.EmailOutboxDispatcher;
import rw.oupay.entry.EntryDeviceService;
import rw.oupay.entry.EntryDtos;
import rw.oupay.inventory.InventoryDtos;
import rw.oupay.inventory.InventoryService;
import rw.oupay.membership.Role;
import rw.oupay.merchant.MerchantDtos;
import rw.oupay.merchant.MerchantService;
import rw.oupay.staff.InvitationService;
import rw.oupay.staff.StaffDtos;

/**
 * Seeds ONE isolated demonstration business as ordinary, properly authorised application records, through the SAME services, validation, audit
 * and tenant rules as the user interface. It is an operator tool, not a back door:
 *
 * <ul>
 *   <li><b>It authenticates.</b> It registers or signs in the demonstration owner with a password the operator supplies at run time (never in the
 *       repository) and then acts as that owner. A wrong password stops the run. Staff accounts are created through the real invitation flow, whose
 *       one-time link is delivered to the demonstration mail sink (it refuses to run unless the sink is the mail provider, so it can never send a
 *       real email). No verification flag is set by hand.</li>
 *   <li><b>It is idempotent and non-destructive.</b> Every record is found by its natural key (registration number, branch code, item code, device
 *       request id, ...) and CREATED ONLY IF MISSING. An existing record is never updated, reset or deleted, whatever a person has done to it since.</li>
 *   <li><b>It never touches money, approvals or tax.</b> No bank transaction, allocation, ledger entry, collection code or code approval is created,
 *       no tax treatment is configured or approved, and no POS draft is made (a draft needs a tax decision to be billed, and billing needs an approved
 *       code, both gates a seeder must not bypass).</li>
 *   <li><b>It is locked three ways</b> (see {@link DemoSeedStartupGuard}): its own profile and never prod; a database an operator designated by hand
 *       ({@code demo_environment}); an allow-listed database host and a confirmation of the database name.</li>
 * </ul>
 */
@Component
@ConditionalOnProperty(prefix = "oupay.demo-seed", name = "enabled", havingValue = "true")
public class DemoSeeder {

    private static final Logger log = LoggerFactory.getLogger(DemoSeeder.class);

    static final String REGISTRATION_NUMBER = "DEMO-RC-0001";
    static final String TIN = "990000001";
    private static final String AGENT = "oupay-demo-seeder";
    private static final String IP = "127.0.0.1";
    private static final Pattern INVITATION_LINK = Pattern.compile("/accept-invitation/([A-Za-z0-9_\\-]+)");
    private static final Pattern DB_HOST = Pattern.compile("^jdbc:postgresql://([^/:?]+)");

    private final JdbcClient jdbc;
    private final AuthService auth;
    private final MerchantService merchants;
    private final BranchService branches;
    private final InvitationService invitations;
    private final CatalogService catalog;
    private final InventoryService inventory;
    private final EntryDeviceService devices;
    private final AuditService audit;
    private final EmailOutboxDispatcher dispatcher;
    private final Optional<DevMailSink> sink;
    private final Environment environment;
    private final DemoSeedSettings settings;
    private final Clock clock;

    public DemoSeeder(JdbcClient jdbc, AuthService auth, MerchantService merchants, BranchService branches, InvitationService invitations,
                      CatalogService catalog, InventoryService inventory, EntryDeviceService devices, AuditService audit, EmailOutboxDispatcher dispatcher,
                      Optional<DevMailSink> sink, Environment environment, DemoSeedSettings settings, Clock clock) {
        this.jdbc = jdbc;
        this.auth = auth;
        this.merchants = merchants;
        this.branches = branches;
        this.invitations = invitations;
        this.catalog = catalog;
        this.inventory = inventory;
        this.devices = devices;
        this.audit = audit;
        this.dispatcher = dispatcher;
        this.sink = sink;
        this.environment = environment;
        this.settings = settings;
        this.clock = clock;
    }

    // ---------------------------------------------------------------------------------------------
    // The run
    // ---------------------------------------------------------------------------------------------

    public SeedReport seed() {
        verifyDesignatedDemoDatabase();
        SeedReport report = new SeedReport();
        String domain = settings.emailDomain();
        AuthenticatedUser owner = signInOwner("owner@" + domain);
        try {
            return acting(owner, () -> seedAs(owner, domain, report));
        } finally {
            auth.logout(owner);
        }
    }

    private SeedReport seedAs(AuthenticatedUser owner, String domain, SeedReport report) {
        UUID merchantId = ensureMerchant(owner, domain, report);
        for (DemoSeedPlan.BranchPlan plan : DemoSeedPlan.BRANCHES) {
            ensureBranch(merchantId, plan, report);
        }
        ensureStaff(merchantId, "manager@" + domain, "Demo Manager", Role.MANAGER, DemoSeedPlan.MANAGER_BRANCHES, settings.managerPassword(), report);
        ensureStaff(merchantId, "cashier@" + domain, "Demo Cashier", Role.CASHIER, DemoSeedPlan.CASHIER_BRANCHES, settings.cashierPassword(), report);
        for (DemoSeedPlan.ItemPlan plan : DemoSeedPlan.ITEMS) {
            ensureItem(merchantId, plan, report);
        }
        for (DemoSeedPlan.PackagePlan plan : DemoSeedPlan.PACKAGES) {
            ensurePackage(merchantId, plan, report);
        }
        for (DemoSeedPlan.StockPlan plan : DemoSeedPlan.STOCK) {
            ensureOpeningStock(merchantId, plan, report);
        }
        for (DemoSeedPlan.DevicePlan plan : DemoSeedPlan.DEVICES) {
            ensureDevice(merchantId, domain, plan, report);
        }
        if (report.created() > 0) {
            audit.record(merchantId, owner.userId(), "DEMO_SEED_RUN", "merchant", merchantId,
                    "Demonstration seed (operator tool): " + report.created() + " record(s) created; existing records were left untouched.");
        }
        log.info("demonstration seed finished: {} record(s) created", report.created());
        return report;
    }

    // ---------------------------------------------------------------------------------------------
    // The locks
    // ---------------------------------------------------------------------------------------------

    /** The database must be one an operator designated BY HAND, named, and reached through an allow-listed host. Otherwise nothing at all happens. */
    void verifyDesignatedDemoDatabase() {
        Integer marker = jdbc.sql("select count(*) from demo_environment").query(Integer.class).single();
        if (marker == null || marker == 0) {
            throw refuse("this database is not designated as a demonstration environment (demo_environment is empty). An operator must insert the "
                    + "single marker row by hand, on the disposable demonstration database only");
        }
        String database = jdbc.sql("select current_database()").query(String.class).single();
        if (settings.confirmDatabase().isEmpty() || !settings.confirmDatabase().equals(database)) {
            throw refuse("oupay.demo-seed.confirm-database must equal the name of the database being seeded (" + database + ")");
        }
        String url = environment.getProperty("spring.datasource.url", "");
        Matcher host = DB_HOST.matcher(url);
        if (!host.find() || settings.allowedDbHosts().stream().noneMatch(h -> h.equalsIgnoreCase(host.group(1)))) {
            throw refuse("the database host is not in oupay.demo-seed.allowed-db-hosts");
        }
        if (sink.isEmpty()) {
            throw refuse("the demonstration seeder needs the mail sink (oupay.email.provider=sink): invitation links must stay inside the demonstration "
                    + "environment and no real email may ever be sent");
        }
    }

    private static IllegalStateException refuse(String why) {
        return new IllegalStateException("Refusing to seed: " + why);
    }

    // ---------------------------------------------------------------------------------------------
    // Identity: the owner authenticates, staff go through the real invitation flow
    // ---------------------------------------------------------------------------------------------

    private AuthenticatedUser signInOwner(String email) {
        String password = settings.ownerPassword();
        if (password == null || password.isBlank()) {
            throw refuse("the owner password must be supplied at run time (OUPAY_DEMO_SEED_OWNER_PASSWORD); it is used to sign in and is never stored or reset");
        }
        Optional<UUID> existing = userId(email);
        var signedIn = existing.isPresent()
                ? auth.login(new AuthDtos.LoginRequest(email, password, false), IP, AGENT)
                : auth.register(new AuthDtos.RegisterRequest("Demo Owner", email, "", password, null), IP, AGENT);
        UUID userId = existing.orElseGet(() -> userId(email).orElseThrow());
        return new AuthenticatedUser(userId, signedIn.issued().session().getId());
    }

    private void ensureStaff(UUID merchantId, String email, String fullName, Role role, List<String> branchCodes, String password, SeedReport report) {
        Optional<UUID> existing = userId(email);
        if (existing.isPresent()) {
            boolean member = jdbc.sql("select count(*) from memberships where merchant_id = :m and user_id = :u and status = 'ACTIVE'")
                    .param("m", merchantId).param("u", existing.get()).query(Integer.class).single() > 0;
            if (member) {
                report.addKept("staff");
            } else {
                report.attention(email + " already exists but is not an active member of the demonstration business: left untouched");
            }
            return;
        }
        if (password == null || password.isBlank()) {
            String who = role.name().toLowerCase(java.util.Locale.ROOT);
            throw refuse("the " + who + " account does not exist yet: supply its password at run time (oupay.demo-seed." + who + "-password, for example "
                    + "OUPAY_DEMO_SEED_" + role.name() + "_PASSWORD)");
        }
        List<UUID> branchIds = new ArrayList<>();
        for (String code : branchCodes) {
            branchIds.add(branchId(merchantId, code).orElseThrow());
        }
        // The owner invites, as in the application. The one-time link goes to the demonstration mailbox (the mail sink).
        invitations.invite(merchantId, new StaffDtos.InviteRequest(email, role, branchIds, "Demonstration account"));
        String token = awaitInvitationToken(email);
        // The invitee accepts anonymously, through the link, exactly like a person would: that proves the mailbox and activates the membership.
        withoutContext(() -> auth.register(new AuthDtos.RegisterRequest(fullName, email, "", password, token), IP, AGENT));
        report.addCreated("staff");
    }

    private String awaitInvitationToken(String email) {
        DevMailSink mailbox = sink.orElseThrow();
        long deadline = System.nanoTime() + settings.mailboxTimeout().toNanos();
        do {
            dispatcher.dispatchDue();
            List<EmailMessage> messages = mailbox.messages();
            for (int i = messages.size() - 1; i >= 0; i--) {
                EmailMessage message = messages.get(i);
                if (message.to() != null && message.to().equalsIgnoreCase(email)) {
                    String body = (message.text() == null ? "" : message.text()) + (message.html() == null ? "" : message.html());
                    Matcher link = INVITATION_LINK.matcher(body);
                    if (link.find()) {
                        return link.group(1);
                    }
                }
            }
            try {
                Thread.sleep(200);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                throw refuse("interrupted while waiting for the invitation email in the demonstration mailbox");
            }
        } while (System.nanoTime() < deadline);
        throw refuse("the invitation email for " + email + " did not reach the demonstration mailbox in time");
    }

    // ---------------------------------------------------------------------------------------------
    // The business, its branches, catalog, stock and payment points: create only if missing
    // ---------------------------------------------------------------------------------------------

    private UUID ensureMerchant(AuthenticatedUser owner, String domain, SeedReport report) {
        Optional<UUID> found = jdbc.sql("select id from merchants where registration_number = :r").param("r", REGISTRATION_NUMBER).query(UUID.class).optional();
        if (found.isPresent()) {
            // Adopted only when its owner is the demonstration owner: a business that merely shares the reserved number is never touched.
            boolean ours = jdbc.sql("select count(*) from memberships where merchant_id = :m and user_id = :u and role = 'OWNER' and status = 'ACTIVE'")
                    .param("m", found.get()).param("u", owner.userId()).query(Integer.class).single() > 0;
            if (!ours) {
                throw refuse("a business with the reserved demonstration registration number exists but is not owned by the demonstration owner: not touching it");
            }
            remember("merchant", "merchant", found.get(), found.get());
            report.addKept("merchant");
            return found.get();
        }
        var created = merchants.create(new MerchantDtos.CreateRequest("Umurava Demo Traders Ltd (demonstration)", "Umurava Demo Shop", "registered_company",
                new MerchantDtos.Registration(REGISTRATION_NUMBER, TIN),
                new MerchantDtos.Location("Kigali City", "Gasabo", "Remera", "KG 11 Ave (demonstration data)", "Rwanda"),
                new MerchantDtos.Contact("Demo Owner", "owner@" + domain, "+250000000000"), null));
        remember("merchant", "merchant", created.id(), created.id());
        report.addCreated("merchant");
        return created.id();
    }

    private void ensureBranch(UUID merchantId, DemoSeedPlan.BranchPlan plan, SeedReport report) {
        Optional<UUID> existing = branchId(merchantId, plan.code());
        if (existing.isPresent()) {
            remember("branch:" + plan.code(), "branch", existing.get(), merchantId);
            report.addKept("branch");
            return;
        }
        var created = branches.create(merchantId, new BranchDtos.CreateRequest(plan.name(), plan.code(),
                new BranchDtos.Location("Kigali City", plan.district(), plan.sector(), plan.address()), null, "ACTIVE"));
        remember("branch:" + plan.code(), "branch", created.id(), merchantId);
        report.addCreated("branch");
    }

    private void ensureItem(UUID merchantId, DemoSeedPlan.ItemPlan plan, SeedReport report) {
        Optional<UUID> existing = itemId(merchantId, plan.code());
        if (existing.isPresent()) {
            remember("item:" + plan.code(), "catalog_item", existing.get(), merchantId);
            report.addKept("catalog item");
            return;
        }
        var created = catalog.create(merchantId, new CatalogDtos.CreateItemRequest(plan.goods() ? CatalogItemType.GOODS : CatalogItemType.SERVICE, plan.name(),
                plan.description(), plan.code(), plan.dimension(), plan.unit(), BigDecimal.valueOf(plan.priceRwf()), true));
        remember("item:" + plan.code(), "catalog_item", created.id(), merchantId);
        report.addCreated("catalog item");
    }

    private void ensurePackage(UUID merchantId, DemoSeedPlan.PackagePlan plan, SeedReport report) {
        UUID item = itemId(merchantId, plan.itemCode()).orElseThrow();
        Optional<UUID> existing = jdbc.sql("select id from catalog_item_packages where item_id = :i and lower(label) = lower(:l)")
                .param("i", item).param("l", plan.label()).query(UUID.class).optional();
        if (existing.isPresent()) {
            report.addKept("package");
            return;
        }
        var created = catalog.createPackage(merchantId, item, new CatalogDtos.CreatePackageRequest(plan.label(), plan.amount(), plan.unit()));
        remember("package:" + plan.itemCode() + ":" + plan.label(), "catalog_package", created.id(), merchantId);
        report.addCreated("package");
    }

    private void ensureOpeningStock(UUID merchantId, DemoSeedPlan.StockPlan plan, SeedReport report) {
        UUID branch = branchId(merchantId, plan.branchCode()).orElseThrow();
        UUID item = itemId(merchantId, plan.itemCode()).orElseThrow();
        // Any stock history for this branch and item (a person's own opening, a receipt, an adjustment) means: leave it alone.
        boolean touched = jdbc.sql("select count(*) from stock_movements where merchant_id = :m and branch_id = :b and item_id = :i")
                .param("m", merchantId).param("b", branch).param("i", item).query(Integer.class).single() > 0;
        if (touched) {
            report.addKept("opening stock");
            return;
        }
        UUID operation = deterministic("opening:" + plan.branchCode() + ":" + plan.itemCode());
        inventory.recordOpening(merchantId, new InventoryDtos.OpeningRequest(operation, branch, item, plan.amount(), plan.unit(), null, null,
                "DEMO-SEED", "Demonstration opening stock"));
        report.addCreated("opening stock");
    }

    private void ensureDevice(UUID merchantId, String domain, DemoSeedPlan.DevicePlan plan, SeedReport report) {
        UUID requestId = deterministic("device:" + plan.key());
        Optional<UUID> existing = jdbc.sql("select id from payment_entry_devices where merchant_id = :m and client_request_id = :c")
                .param("m", merchantId).param("c", requestId).query(UUID.class).optional();
        if (existing.isPresent()) {
            remember("device:" + plan.key(), "payment_entry_device", existing.get(), merchantId);
            report.addKept("payment point");
            return;
        }
        UUID branch = branchId(merchantId, plan.branchCode()).orElseThrow();
        UUID cashier = plan.cashier() ? userId("cashier@" + domain).orElseThrow() : null;
        var written = devices.register(merchantId, new EntryDtos.CreateRequest(requestId, plan.type(), plan.name(), branch, cashier));
        remember("device:" + plan.key(), "payment_entry_device", written.device().id(), merchantId);
        report.addCreated("payment point");
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    private Optional<UUID> userId(String email) {
        return jdbc.sql("select id from users where lower(email) = lower(:e)").param("e", email).query(UUID.class).optional();
    }

    private Optional<UUID> branchId(UUID merchantId, String code) {
        return jdbc.sql("select id from branches where merchant_id = :m and code = :c").param("m", merchantId).param("c", code).query(UUID.class).optional();
    }

    private Optional<UUID> itemId(UUID merchantId, String code) {
        return jdbc.sql("select id from catalog_items where merchant_id = :m and code = :c").param("m", merchantId).param("c", code).query(UUID.class).optional();
    }

    private static UUID deterministic(String key) {
        return UUID.nameUUIDFromBytes(("oupay-demo-seed:" + key).getBytes(StandardCharsets.UTF_8));
    }

    /** Insert-only record of what the seeder made, so a run can be inspected. */
    private void remember(String key, String type, UUID entityId, UUID merchantId) {
        jdbc.sql("insert into demo_seed_registry (seed_key, entity_type, entity_id, merchant_id, created_at) values (:k, :t, :e, :m, :now) on conflict (seed_key) do nothing")
                .param("k", key).param("t", type).param("e", entityId).param("m", merchantId).param("now", Timestamp.from(clock.instant())).update();
    }

    private static <T> T acting(AuthenticatedUser principal, Supplier<T> work) {
        SecurityContext previous = SecurityContextHolder.getContext();
        SecurityContext context = SecurityContextHolder.createEmptyContext();
        context.setAuthentication(new UsernamePasswordAuthenticationToken(principal, null, List.of()));
        SecurityContextHolder.setContext(context);
        try {
            return work.get();
        } finally {
            SecurityContextHolder.setContext(previous);
            SecurityContextHolder.clearContext();
        }
    }

    private static void withoutContext(Runnable work) {
        SecurityContext saved = SecurityContextHolder.getContext();
        SecurityContextHolder.clearContext();
        try {
            work.run();
        } finally {
            SecurityContextHolder.setContext(saved);
        }
    }
}
