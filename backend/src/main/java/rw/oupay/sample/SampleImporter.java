package rw.oupay.sample;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.core.env.Environment;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.context.SecurityContext;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import rw.oupay.audit.AuditService;
import rw.oupay.auth.AuthDtos;
import rw.oupay.auth.AuthService;
import rw.oupay.auth.AuthenticatedUser;
import rw.oupay.auth.PasswordService;
import rw.oupay.branch.BranchDtos;
import rw.oupay.branch.BranchService;
import rw.oupay.catalog.CatalogDtos;
import rw.oupay.catalog.CatalogItemType;
import rw.oupay.catalog.CatalogService;
import rw.oupay.entry.EntryDeviceService;
import rw.oupay.entry.EntryDtos;
import rw.oupay.inventory.InventoryDtos;
import rw.oupay.inventory.InventoryService;
import rw.oupay.membership.Role;
import rw.oupay.pos.PosDtos;
import rw.oupay.pos.PosService;
import rw.oupay.staff.InvitationService;
import rw.oupay.staff.StaffDtos;

/**
 * R9b: adds the sample dataset to ONE EXISTING merchant, as ordinary, properly authorised application records, through the SAME services,
 * validation, audit and tenant rules as the user interface. An operator tool, not a back door:
 *
 * <ul>
 *   <li><b>One merchant, chosen and authorised.</b> The operator names the merchant by id and the merchant's OWNER by email; the owner's password
 *       (supplied at run time) is checked and the owner must hold an ACTIVE owner membership of exactly that merchant. Every write is then made AS that
 *       owner, so tenant isolation, permissions and audit apply as for a person. No other merchant is ever read for writing.</li>
 *   <li><b>Preview first.</b> {@link #preview()} is read-only and lists every record as CREATE, KEEP or SKIP, with a fingerprint of that exact plan.
 *       {@link #apply(String)} writes only when given that fingerprint again: if anything changed since the preview, it refuses.</li>
 *   <li><b>Idempotent and non-destructive.</b> Every record is found by its natural key and CREATED ONLY IF MISSING. An existing record is never
 *       updated, reset or deleted, whatever a person has done to it since; stock history of any kind for a branch and item means "leave it alone".</li>
 *   <li><b>No back door to identity.</b> Staff are invited through the real invitation flow to addresses the operator supplies; the invitee sets their own
 *       password through the link. No password, verification flag or session is created for anyone else.</li>
 *   <li><b>Never money.</b> No bank transaction, allocation, ledger entry, balance, settlement, collection code or approval, and no tax decision.</li>
 *   <li><b>No direct SQL writes</b> to business tables: every write is a service call. Plain SQL here only READS.</li>
 * </ul>
 */
@Component
@ConditionalOnProperty(prefix = "oupay.sample-import", name = "enabled", havingValue = "true")
public class SampleImporter {

    private static final Logger log = LoggerFactory.getLogger(SampleImporter.class);

    private static final String AGENT = "oupay-sample-importer";
    private static final String IP = "127.0.0.1";
    private static final Pattern DB_HOST = Pattern.compile("^jdbc:postgresql://([^/:?]+)");
    private static final Pattern MIGRATION = Pattern.compile("V(\\d+)__.*\\.sql");

    /** What the importer will do about one record. */
    public enum Action { CREATE, KEEP, SKIP }

    /** One line of the plan. {@code run} is what CREATE does; it is never called for KEEP or SKIP. */
    public record Step(String key, String kind, String label, Action action, String reason, Runnable run) {}

    /** The read-only preview of an import: nothing has been written when you hold one. */
    public record Preview(UUID merchantId, String merchantName, String merchantStatus, String database, String host, List<Step> steps,
                          String fingerprint) {

        public Preview {
            steps = List.copyOf(steps);
        }

        public long count(Action action) {
            return steps.stream().filter(s -> s.action() == action).count();
        }

        public boolean writesAnything() {
            return count(Action.CREATE) > 0;
        }

        public String render() {
            StringBuilder text = new StringBuilder();
            String eol = System.lineSeparator();
            text.append("Sample data batch ").append(SampleDataPlan.BATCH).append(" (plan v").append(SampleDataPlan.PLAN_VERSION).append(')').append(eol);
            text.append("  merchant : ").append(merchantName).append(" [").append(merchantStatus).append("] ").append(merchantId).append(eol);
            text.append("  database : ").append(database).append(" on ").append(host).append(eol);
            for (Step step : steps) {
                text.append(String.format("  %-6s %-13s %s%s%n", step.action(), step.kind(), step.label(), step.reason() == null ? "" : "  -- " + step.reason()));
            }
            text.append("  total    : ").append(count(Action.CREATE)).append(" to create, ").append(count(Action.KEEP)).append(" already there, ")
                    .append(count(Action.SKIP)).append(" skipped").append(eol);
            text.append("  plan fingerprint: ").append(fingerprint).append(eol);
            return text.toString();
        }
    }

    /** What an applied import did. Never contains a secret. */
    public record Result(int created, int kept, int skipped, String fingerprint) {}

    private final JdbcClient jdbc;
    private final AuthService auth;
    private final PasswordService passwords;
    private final BranchService branches;
    private final InvitationService invitations;
    private final CatalogService catalog;
    private final InventoryService inventory;
    private final EntryDeviceService devices;
    private final PosService pos;
    private final AuditService audit;
    private final Environment environment;
    private final SampleImportSettings settings;

    public SampleImporter(JdbcClient jdbc, AuthService auth, PasswordService passwords, BranchService branches, InvitationService invitations,
                          CatalogService catalog, InventoryService inventory, EntryDeviceService devices, PosService pos, AuditService audit,
                          Environment environment, SampleImportSettings settings) {
        this.jdbc = jdbc;
        this.auth = auth;
        this.passwords = passwords;
        this.branches = branches;
        this.invitations = invitations;
        this.catalog = catalog;
        this.inventory = inventory;
        this.devices = devices;
        this.pos = pos;
        this.audit = audit;
        this.environment = environment;
        this.settings = settings;
    }

    // ---------------------------------------------------------------------------------------------
    // Preview (read-only)
    // ---------------------------------------------------------------------------------------------

    /**
     * Checks the preconditions and builds the plan. It WRITES NOTHING: it does not even sign in (the owner's password is verified against its hash,
     * which records nothing). Refuses with {@link SampleImportRefusedException} when the target is not valid.
     */
    public Preview preview() {
        UUID merchantId = settings.merchantId();
        verifySchemaMatchesThisBuild();
        Owner owner = verifyOwner(merchantId);
        Row merchant = jdbc.sql("select coalesce(nullif(btrim(trading_name), ''), legal_name) as display_name, status from merchants where id = :m").param("m", merchantId)
                .query((rs, n) -> new Row(rs.getString("display_name"), rs.getString("status"))).optional()
                .orElseThrow(() -> new SampleImportRefusedException("that merchant does not exist"));
        if (Set.of("suspended", "rejected").contains(merchant.status())) {
            throw new SampleImportRefusedException("that merchant is " + merchant.status() + ": sample data is not added to it");
        }
        String database = jdbc.sql("select current_database()").query(String.class).single();
        Matcher host = DB_HOST.matcher(environment.getProperty("spring.datasource.url", ""));
        List<Step> steps = new ArrayList<>();
        Plan plan = new Plan(merchantId, owner, steps);
        planBranches(plan);
        planStaff(plan);
        planItems(plan);
        planPackages(plan);
        planStock(plan);
        planDevices(plan);
        planDrafts(plan);
        return new Preview(merchantId, merchant.name(), merchant.status(), database, host.find() ? host.group(1) : "(unknown)", steps,
                fingerprint(database, merchantId, steps));
    }

    private record Row(String name, String status) {}

    private record Owner(UUID userId) {}

    /** The build must match the database schema it writes to: the importer never migrates, and never writes through a schema it was not built for. */
    private void verifySchemaMatchesThisBuild() {
        int built = 0;
        try {
            for (Resource r : new PathMatchingResourcePatternResolver().getResources("classpath:db/migration/V*__*.sql")) {
                Matcher m = MIGRATION.matcher(String.valueOf(r.getFilename()));
                if (m.matches()) {
                    built = Math.max(built, Integer.parseInt(m.group(1)));
                }
            }
        } catch (java.io.IOException e) {
            throw new SampleImportRefusedException("could not read this build's migrations", e);
        }
        Integer applied = jdbc.sql("select max(version::int) from flyway_schema_history where success and version is not null").query(Integer.class).optional()
                .orElse(null);
        if (applied == null || applied != built) {
            throw new SampleImportRefusedException("the database schema (version " + applied + ") does not match this build (version " + built
                    + "): run the importer from the same commit that is deployed. The importer never migrates a database");
        }
    }

    private Owner verifyOwner(UUID merchantId) {
        String email = settings.ownerEmail();
        String password = settings.ownerPassword();
        Optional<UUID> userId = jdbc.sql("select id from users where lower(email) = lower(:e) and status = 'ACTIVE'").param("e", email).query(UUID.class).optional();
        Optional<String> hash = userId.flatMap(id -> jdbc.sql("select password_hash from users where id = :u").param("u", id).query(String.class).optional());
        // One message for every failure: the importer must not tell an operator whether an address is registered.
        if (userId.isEmpty() || hash.isEmpty() || !passwords.matches(password, hash.get())) {
            throw new SampleImportRefusedException("the owner credentials were not accepted");
        }
        boolean owns = jdbc.sql("select count(*) from memberships where merchant_id = :m and user_id = :u and role = 'OWNER' and status = 'ACTIVE'")
                .param("m", merchantId).param("u", userId.get()).query(Integer.class).single() > 0;
        if (!owns) {
            throw new SampleImportRefusedException("that user is not an active OWNER of that merchant: only the owner can authorise sample data");
        }
        return new Owner(userId.get());
    }

    private static final class Plan {
        final UUID merchantId;
        final Owner owner;
        final List<Step> steps;
        /** What exists, or will exist once the plan has run: dependants are planned only on that. */
        final Set<String> branches = new java.util.HashSet<>();
        final Set<String> items = new java.util.HashSet<>();

        Plan(UUID merchantId, Owner owner, List<Step> steps) {
            this.merchantId = merchantId;
            this.owner = owner;
            this.steps = steps;
        }
    }

    private void planBranches(Plan plan) {
        for (SampleDataPlan.BranchPlan b : SampleDataPlan.BRANCHES) {
            String key = "branch:" + b.code();
            String label = b.name() + " (" + b.code() + ")";
            if (branchId(plan.merchantId, b.code()).isPresent()) {
                plan.steps.add(new Step(key, "branch", label, Action.KEEP, "already there; left exactly as it is", null));
            } else {
                plan.steps.add(new Step(key, "branch", label, Action.CREATE, null, () -> createBranch(plan.merchantId, b)));
            }
            plan.branches.add(b.code());
        }
    }

    private void planStaff(Plan plan) {
        List<String> emails = new ArrayList<>();
        emails.add(settings.managerEmail());
        List<String> cashiers = settings.cashierEmails();
        for (int i = 0; i < 2; i++) {
            emails.add(i < cashiers.size() ? cashiers.get(i) : "");
        }
        String ownerEmail = settings.ownerEmail();
        for (int i = 0; i < SampleDataPlan.STAFF.size(); i++) {
            SampleDataPlan.StaffPlan s = SampleDataPlan.STAFF.get(i);
            String email = emails.get(i);
            String key = "staff:" + s.key();
            if (email.isEmpty()) {
                plan.steps.add(new Step(key, "staff", s.fullNameHint() + " (" + s.role().toLowerCase(Locale.ROOT) + ")", Action.SKIP,
                        "no address supplied (oupay.sample-import." + (i == 0 ? "manager-email" : "cashier-emails") + ")", null));
                continue;
            }
            String label = s.fullNameHint() + " <" + mask(email) + "> (" + s.role().toLowerCase(Locale.ROOT) + ")";
            // The address is part of the fingerprint, as a hash: the confirmation covers WHO is invited, without printing it.
            String bound = key + "#" + sha256(email).substring(0, 12);
            if (email.equalsIgnoreCase(ownerEmail)) {
                plan.steps.add(new Step(bound, "staff", label, Action.SKIP, "that is the owner's own address", null));
            } else if (alreadyInvolved(plan.merchantId, email)) {
                plan.steps.add(new Step(bound, "staff", label, Action.KEEP, "already a member, or an invitation exists; left untouched", null));
            } else if (!plan.branches.containsAll(s.branchCodes())) {
                plan.steps.add(new Step(bound, "staff", label, Action.SKIP, "a branch it needs is not available", null));
            } else {
                plan.steps.add(new Step(bound, "staff", label + " -- sends a REAL invitation email", Action.CREATE, null,
                        () -> invite(plan.merchantId, email, s)));
            }
        }
    }

    private void planItems(Plan plan) {
        for (SampleDataPlan.ItemPlan i : SampleDataPlan.ITEMS) {
            String key = "item:" + i.code();
            String label = i.name() + " (" + i.code() + ", " + (i.goods() ? "goods" : "service") + ", RWF " + i.priceRwf() + ")";
            if (itemId(plan.merchantId, i.code()).isPresent()) {
                plan.steps.add(new Step(key, "catalog item", label, Action.KEEP, "already there; name, price and status left exactly as they are", null));
            } else {
                plan.steps.add(new Step(key, "catalog item", label, Action.CREATE, null, () -> createItem(plan.merchantId, i)));
            }
            plan.items.add(i.code());
        }
    }

    private void planPackages(Plan plan) {
        for (SampleDataPlan.PackagePlan p : SampleDataPlan.PACKAGES) {
            String key = "package:" + p.itemCode() + ":" + p.label();
            String label = p.itemCode() + " " + p.label() + " (" + p.amount() + " " + p.unit() + ")";
            boolean exists = itemId(plan.merchantId, p.itemCode()).map(item -> jdbc.sql("select count(*) from catalog_item_packages where item_id = :i and lower(label) = lower(:l)")
                    .param("i", item).param("l", p.label()).query(Integer.class).single() > 0).orElse(false);
            if (exists) {
                plan.steps.add(new Step(key, "package", label, Action.KEEP, "already there", null));
            } else {
                plan.steps.add(new Step(key, "package", label, Action.CREATE, null, () -> createPackage(plan.merchantId, p)));
            }
        }
    }

    private void planStock(Plan plan) {
        for (SampleDataPlan.StockPlan s : SampleDataPlan.STOCK) {
            String key = "stock:" + s.branchCode() + ":" + s.itemCode();
            String label = s.branchCode() + " / " + s.itemCode() + " opening " + s.amount() + " " + s.unit();
            Optional<UUID> branch = branchId(plan.merchantId, s.branchCode());
            Optional<UUID> item = itemId(plan.merchantId, s.itemCode());
            boolean touched = branch.isPresent() && item.isPresent() && jdbc.sql("select count(*) from stock_movements where merchant_id = :m and branch_id = :b and item_id = :i")
                    .param("m", plan.merchantId).param("b", branch.get()).param("i", item.get()).query(Integer.class).single() > 0;
            if (touched) {
                // A person's own opening, a receipt, a sale, an adjustment: any history means leave it alone.
                plan.steps.add(new Step(key, "opening stock", label, Action.KEEP, "stock history exists for this branch and item; left alone", null));
            } else if (!plan.branches.contains(s.branchCode()) || !plan.items.contains(s.itemCode())) {
                plan.steps.add(new Step(key, "opening stock", label, Action.SKIP, "its branch or item is not available", null));
            } else {
                plan.steps.add(new Step(key, "opening stock", label, Action.CREATE, null, () -> openStock(plan.merchantId, s)));
            }
        }
    }

    private void planDevices(Plan plan) {
        for (SampleDataPlan.DevicePlan d : SampleDataPlan.DEVICES) {
            String key = "device:" + d.key();
            String label = d.name() + " (" + d.type() + ")";
            UUID requestId = deterministic(plan.merchantId, "device:" + d.key());
            if (jdbc.sql("select count(*) from payment_entry_devices where merchant_id = :m and client_request_id = :c").param("m", plan.merchantId)
                    .param("c", requestId).query(Integer.class).single() > 0) {
                plan.steps.add(new Step(key, "payment point", label, Action.KEEP, "already there (even if since suspended or revoked); left alone", null));
            } else if (jdbc.sql("select count(*) from payment_entry_devices where merchant_id = :m and lower(display_name) = lower(:n) and status <> 'REVOKED'")
                    .param("m", plan.merchantId).param("n", d.name()).query(Integer.class).single() > 0) {
                plan.steps.add(new Step(key, "payment point", label, Action.SKIP, "a payment point with this name already exists", null));
            } else if (!plan.branches.contains(d.branchCode())) {
                plan.steps.add(new Step(key, "payment point", label, Action.SKIP, "its branch is not available", null));
            } else {
                plan.steps.add(new Step(key, "payment point", label, Action.CREATE, null, () -> registerDevice(plan.merchantId, d)));
            }
        }
    }

    /**
     * POS drafts are allowed by the existing rules (a draft is a cart, never a sale: no tax decision, no code, no stock), but only for someone ASSIGNED
     * to the branch, in business mode. The importer never changes the owner's branch assignments: a draft is planned only where the owner is already
     * assigned to a sample branch (the owner does that in the UI), so on a first run the drafts are reported as SKIP with that reason.
     */
    private void planDrafts(Plan plan) {
        Optional<String> branchCode = SampleDataPlan.BRANCHES.stream().map(SampleDataPlan.BranchPlan::code)
                .filter(code -> ownerAssignedTo(plan, code)).findFirst();
        boolean business = "BUSINESS".equals(jdbc.sql("select operating_mode from merchant_settings where merchant_id = :m").param("m", plan.merchantId)
                .query(String.class).optional().orElse(null));
        for (SampleDataPlan.DraftPlan d : SampleDataPlan.DRAFTS) {
            String key = "draft:" + d.key();
            String label = d.note();
            UUID requestId = deterministic(plan.merchantId, "draft:" + d.key());
            if (jdbc.sql("select count(*) from pos_drafts where merchant_id = :m and client_request_id = :c").param("m", plan.merchantId)
                    .param("c", requestId).query(Integer.class).single() > 0) {
                plan.steps.add(new Step(key, "POS draft", label, Action.KEEP, "already there (even if since edited or discarded); left alone", null));
            } else if (!business) {
                plan.steps.add(new Step(key, "POS draft", label, Action.SKIP, "the merchant is not in business mode, where POS drafts exist", null));
            } else if (branchCode.isEmpty()) {
                plan.steps.add(new Step(key, "POS draft", label, Action.SKIP, "the owner is not assigned to a sample branch (the importer never changes "
                        + "branch assignments): assign yourself to one in the application, then run it again", null));
            } else if (!d.lines().stream().allMatch(l -> plan.items.contains(l.itemCode()))) {
                plan.steps.add(new Step(key, "POS draft", label, Action.SKIP, "an item it needs is not available", null));
            } else {
                String code = branchCode.get();
                plan.steps.add(new Step(key, "POS draft", label + " at " + code, Action.CREATE, null, () -> createDraft(plan.merchantId, code, d)));
            }
        }
    }

    private boolean ownerAssignedTo(Plan plan, String branchCode) {
        return jdbc.sql("select count(*) from branch_assignments a join memberships m on m.id = a.membership_id join branches b on b.id = a.branch_id "
                        + "where a.merchant_id = :m and m.user_id = :u and m.status = 'ACTIVE' and a.status = 'ACTIVE' and b.status = 'ACTIVE' and b.code = :c")
                .param("m", plan.merchantId).param("u", plan.owner.userId()).param("c", branchCode).query(Integer.class).single() > 0;
    }

    // ---------------------------------------------------------------------------------------------
    // Apply
    // ---------------------------------------------------------------------------------------------

    /**
     * Writes the plan the operator previewed. {@code confirmation} must equal the fingerprint of the plan as it stands NOW: a changed database, a
     * changed dataset or a different merchant gives a different fingerprint and nothing is written. A plan with nothing to create writes nothing at all
     * (not even a sign-in).
     */
    public Result apply(String confirmation) {
        Preview preview = preview();
        if (confirmation == null || confirmation.isBlank() || !MessageDigest.isEqual(confirmation.trim().toLowerCase(Locale.ROOT).getBytes(StandardCharsets.UTF_8),
                preview.fingerprint().getBytes(StandardCharsets.UTF_8))) {
            throw new SampleImportRefusedException("the confirmation does not match the plan as it stands now (oupay.sample-import.confirm-plan must be "
                    + "the fingerprint of a fresh dry run: the data, the merchant or the dataset changed since the preview, or the value is wrong)");
        }
        int kept = (int) preview.count(Action.KEEP);
        int skipped = (int) preview.count(Action.SKIP);
        if (!preview.writesAnything()) {
            log.info("sample import: nothing to create ({} already there, {} skipped)", kept, skipped);
            return new Result(0, kept, skipped, preview.fingerprint());
        }
        var signedIn = auth.login(new AuthDtos.LoginRequest(settings.ownerEmail(), settings.ownerPassword(), false), IP, AGENT);
        AuthenticatedUser principal = new AuthenticatedUser(userIdOf(settings.ownerEmail()), signedIn.issued().session().getId());
        int created = 0;
        try {
            for (Step step : preview.steps()) {
                if (step.action() != Action.CREATE) {
                    continue;
                }
                try {
                    acting(principal, () -> {
                        step.run().run();
                        return Boolean.TRUE;
                    });
                } catch (RuntimeException e) {
                    // Each step committed on its own: what is done stays done, and a fresh dry run plus a new confirmation finishes the rest.
                    throw new SampleImportRefusedException("step " + step.key() + " failed after " + created + " record(s) were created: " + e.getMessage(), e);
                }
                created++;
            }
            return new Result(created, kept, skipped, preview.fingerprint());
        } finally {
            if (created > 0) {
                final int total = created;
                acting(principal, () -> {
                    audit.record(preview.merchantId(), principal.userId(), "SAMPLE_IMPORT_RUN", "merchant", preview.merchantId(),
                            "Sample data import " + SampleDataPlan.BATCH + " (operator tool): " + total + " record(s) created; existing records were left untouched.");
                    return Boolean.TRUE;
                });
            }
            auth.logout(principal);
        }
    }

    // ---------------------------------------------------------------------------------------------
    // The writes: each one is a call of the ordinary service, as the owner
    // ---------------------------------------------------------------------------------------------

    private void createBranch(UUID merchantId, SampleDataPlan.BranchPlan b) {
        branches.create(merchantId, new BranchDtos.CreateRequest(b.name(), b.code(),
                new BranchDtos.Location("Kigali City", b.district(), b.sector(), b.address()), null, "ACTIVE"));
    }

    private void createItem(UUID merchantId, SampleDataPlan.ItemPlan i) {
        catalog.create(merchantId, new CatalogDtos.CreateItemRequest(i.goods() ? CatalogItemType.GOODS : CatalogItemType.SERVICE, i.name(), i.description(),
                i.code(), i.dimension(), i.unit(), BigDecimal.valueOf(i.priceRwf()), true));
    }

    private void createPackage(UUID merchantId, SampleDataPlan.PackagePlan p) {
        UUID item = itemId(merchantId, p.itemCode()).orElseThrow();
        catalog.createPackage(merchantId, item, new CatalogDtos.CreatePackageRequest(p.label(), p.amount(), p.unit()));
    }

    private void openStock(UUID merchantId, SampleDataPlan.StockPlan s) {
        UUID branch = branchId(merchantId, s.branchCode()).orElseThrow();
        UUID item = itemId(merchantId, s.itemCode()).orElseThrow();
        inventory.recordOpening(merchantId, new InventoryDtos.OpeningRequest(deterministic(merchantId, "opening:" + s.branchCode() + ":" + s.itemCode()), branch,
                item, s.amount(), s.unit(), null, null, SampleDataPlan.BATCH, "Sample opening stock"));
    }

    private void registerDevice(UUID merchantId, SampleDataPlan.DevicePlan d) {
        UUID branch = branchId(merchantId, d.branchCode()).orElseThrow();
        devices.register(merchantId, new EntryDtos.CreateRequest(deterministic(merchantId, "device:" + d.key()), d.type(), d.name(), branch, null));
    }

    private void invite(UUID merchantId, String email, SampleDataPlan.StaffPlan s) {
        List<UUID> branchIds = new ArrayList<>();
        for (String code : s.branchCodes()) {
            branchIds.add(branchId(merchantId, code).orElseThrow());
        }
        invitations.invite(merchantId, new StaffDtos.InviteRequest(email, Role.valueOf(s.role()), branchIds, MARKER_NOTE));
    }

    private static final String MARKER_NOTE = "Sample account (" + SampleDataPlan.BATCH + ")";

    private void createDraft(UUID merchantId, String branchCode, SampleDataPlan.DraftPlan d) {
        UUID branch = branchId(merchantId, branchCode).orElseThrow();
        List<PosDtos.LineRequest> lines = new ArrayList<>();
        for (SampleDataPlan.DraftLine l : d.lines()) {
            UUID item = itemId(merchantId, l.itemCode()).orElseThrow();
            int version = jdbc.sql("select current_price_version from catalog_items where id = :i").param("i", item).query(Integer.class).single();
            lines.add(new PosDtos.LineRequest(item, l.quantity(), l.unit(), null, version));
        }
        UUID requestId = deterministic(merchantId, "draft:" + d.key());
        pos.create(merchantId, "sample-" + requestId, new PosDtos.DraftRequest(requestId, branch, d.note(), lines));
    }

    // ---------------------------------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------------------------------

    private UUID userIdOf(String email) {
        return jdbc.sql("select id from users where lower(email) = lower(:e)").param("e", email).query(UUID.class).single();
    }

    private boolean alreadyInvolved(UUID merchantId, String email) {
        boolean member = jdbc.sql("select count(*) from memberships m join users u on u.id = m.user_id where m.merchant_id = :m and lower(u.email) = lower(:e)")
                .param("m", merchantId).param("e", email).query(Integer.class).single() > 0;
        boolean invited = jdbc.sql("select count(*) from staff_invitations where merchant_id = :m and lower(email) = lower(:e)")
                .param("m", merchantId).param("e", email).query(Integer.class).single() > 0;
        return member || invited;
    }

    private Optional<UUID> branchId(UUID merchantId, String code) {
        return jdbc.sql("select id from branches where merchant_id = :m and code = :c").param("m", merchantId).param("c", code).query(UUID.class).optional();
    }

    private Optional<UUID> itemId(UUID merchantId, String code) {
        return jdbc.sql("select id from catalog_items where merchant_id = :m and code = :c").param("m", merchantId).param("c", code).query(UUID.class).optional();
    }

    /** Deterministic AND per merchant: the same sample key never collides across merchants, and a repeat finds what the first run made. */
    static UUID deterministic(UUID merchantId, String key) {
        return UUID.nameUUIDFromBytes(("oupay-sample-import:" + SampleDataPlan.BATCH + ":" + merchantId + ":" + key).getBytes(StandardCharsets.UTF_8));
    }

    static String mask(String email) {
        int at = email.indexOf('@');
        return at <= 1 ? "***" + email.substring(Math.max(at, 0)) : email.charAt(0) + "***" + email.substring(at);
    }

    static String fingerprint(String database, UUID merchantId, List<Step> steps) {
        StringBuilder basis = new StringBuilder("oupay-sample-import|v").append(SampleDataPlan.PLAN_VERSION).append('|').append(SampleDataPlan.BATCH).append('|')
                .append(database).append('|').append(merchantId);
        for (Step step : steps) {
            basis.append('|').append(step.key()).append('=').append(step.action());
        }
        return sha256(basis.toString()).substring(0, 16);
    }

    private static String sha256(String text) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(text.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 is always available", e);
        }
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
}
