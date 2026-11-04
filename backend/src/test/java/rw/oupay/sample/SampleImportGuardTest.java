package rw.oupay.sample;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatCode;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.UUID;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;
import org.springframework.mock.env.MockEnvironment;

/** R9b: the importer can be switched on only under its own profile, can never run in the deployed service, and has no web surface or hidden writes. */
class SampleImportGuardTest {

    private static final Path SAMPLE = Path.of("src/main/java/rw/oupay/sample");

    private static MockEnvironment profiles(String... active) {
        MockEnvironment environment = new MockEnvironment();
        environment.setActiveProfiles(active);
        return environment;
    }

    @Test
    void productionDemoSeedDevAndNoProfileRefuseToStartWithTheImporterSwitchedOn() {
        for (String[] active : new String[][] {{"prod"}, {"staging"}, {"dev"}, {}, {"test"}, {"prod", "sample-import"}, {"sample-import", "prod"},
                {"sample-import", "demo-seed"}, {"demo-seed"}}) {
            assertThatThrownBy(() -> new SampleImportStartupGuard(profiles(active), true, false)).as(String.join(",", active))
                    .isInstanceOf(IllegalStateException.class).hasMessageContaining("Unsafe configuration, refusing to start");
            assertThatThrownBy(() -> new SampleImportStartupGuard(profiles(active), false, true)).as("startup run, " + String.join(",", active))
                    .isInstanceOf(IllegalStateException.class);
        }
    }

    @Test
    void theStartupRunSwitchNeverWorksWithoutTheExplicitEnableSwitch() {
        assertThatThrownBy(() -> new SampleImportStartupGuard(profiles("sample-import"), false, true)).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("needs oupay.sample-import.enabled=true");
    }

    @Test
    void onlyTheDedicatedProfileWithTheExplicitSwitchIsAllowedAndOffIsAlwaysFine() {
        assertThatCode(() -> new SampleImportStartupGuard(profiles("sample-import"), true, true)).doesNotThrowAnyException();
        assertThatCode(() -> new SampleImportStartupGuard(profiles("sample-import"), true, false)).doesNotThrowAnyException();
        for (String[] active : new String[][] {{"prod"}, {}, {"dev"}, {"demo-seed"}, {"sample-import"}}) {
            assertThatCode(() -> new SampleImportStartupGuard(profiles(active), false, false)).doesNotThrowAnyException();
        }
    }

    @Test
    void theProfileFileNeverSwitchesItOnOrSuppliesTheTargetACredentialOrAConfirmationAndNeverMigratesOrSchedulesAnything() throws IOException {
        String profile = Files.readString(Path.of("src/main/resources/application-sample-import.yml"));
        assertThat(profile).doesNotContain("enabled: true").doesNotContain("merchant-id:").doesNotContain("owner-email").doesNotContain("confirm-plan")
                .doesNotContainPattern("(?im)^\\s*[a-z-]*password\\s*:");
        // Never migrates the shared database from an operator's machine, and nothing but the import touches it: no worker, no dispatcher, no simulator.
        assertThat(profile).contains("flyway:\n    enabled: false").containsPattern("(?s)dispatcher:\\s+enabled: false").containsPattern("(?s)housekeeping:\\s+enabled: false")
                .containsPattern("(?s)fulfilment:\\s+enabled: false").containsPattern("(?s)simulated:\\s+enabled: false").contains("address: 127.0.0.1");
        for (String file : new String[] {"application.yml", "application-prod.yml", "application-dev.yml", "application-demo-seed.yml"}) {
            assertThat(Files.readString(Path.of("src/main/resources/" + file))).as(file).doesNotContain("sample-import");
        }
    }

    @Test
    void theImporterHasNoWebSurfaceNoDirectWritesAndNoHardCodedSecretOrExit() throws IOException {
        try (Stream<Path> sources = Files.walk(SAMPLE)) {
            for (Path file : sources.filter(p -> p.toString().endsWith(".java")).toList()) {
                String text = Files.readString(file);
                String lower = text.toLowerCase(java.util.Locale.ROOT);
                String name = file.getFileName().toString();
                // No endpoint of any kind, authenticated or not.
                assertThat(text).as(name).doesNotContain("@RestController").doesNotContain("@Controller").doesNotContain("@RequestMapping")
                        .doesNotContain("@PostMapping").doesNotContain("@GetMapping").doesNotContain("HttpServletRequest");
                // Plain SQL only READS: every write is a service call, so no business validation can be bypassed.
                for (String write : new String[] {"insert into", "update ", "delete from", "truncate", "drop table", "alter table"}) {
                    assertThat(lower).as(name + " must not contain direct SQL: " + write).doesNotContain(write.equals("update ") ? "\"update " : write);
                }
                assertThat(text).as(name).doesNotContain("System.exit(").doesNotContain(".halt(").doesNotContain("Passw0rd");
                // Never a bank, ledger, allocation, approval or tax write.
                for (String forbidden : new String[] {"BankTransaction", "PaymentAllocation", "CollectionCode", "ReconciliationService", "LedgerService",
                        "AttributionRecorder", "BankEventProcessor"}) {
                    assertThat(text).as(name + " must not use " + forbidden).doesNotContain(forbidden);
                }
            }
        }
    }

    @Test
    void theMerchantAndOwnerAreRequiredAndNeverDefaulted() {
        SampleImportSettings empty = new SampleImportSettings("", "", "", "", "", "");
        assertThatThrownBy(empty::merchantId).isInstanceOf(SampleImportRefusedException.class).hasMessageContaining("merchant-id is required");
        assertThatThrownBy(empty::ownerEmail).isInstanceOf(SampleImportRefusedException.class);
        assertThatThrownBy(empty::ownerPassword).isInstanceOf(SampleImportRefusedException.class).hasMessageContaining("supplied at run time");
        assertThat(empty.confirmPlan()).isEmpty();
        assertThatThrownBy(() -> new SampleImportSettings("all", "o@x.rw", "pw", "", "", "").merchantId()).isInstanceOf(SampleImportRefusedException.class)
                .hasMessageContaining("not a valid identifier");
        UUID id = UUID.randomUUID();
        SampleImportSettings set = new SampleImportSettings(" " + id + " ", " Owner@Shop.RW ", "pw", " ABCDEF ", " Mgr@Shop.rw ", "a@x.rw, B@x.rw ,");
        assertThat(set.merchantId()).isEqualTo(id);
        assertThat(set.ownerEmail()).isEqualTo("owner@shop.rw");
        assertThat(set.confirmPlan()).isEqualTo("abcdef");
        assertThat(set.managerEmail()).isEqualTo("mgr@shop.rw");
        assertThat(set.cashierEmails()).isEqualTo(List.of("a@x.rw", "b@x.rw"));
    }

    @Test
    void emailsAreMaskedAndTheFingerprintBindsTheMerchantTheDatabaseAndEveryDecision() {
        assertThat(SampleImporter.mask("jane.doe@example.com")).isEqualTo("j***@example.com").doesNotContain("jane");
        assertThat(SampleImporter.mask("a@example.com")).doesNotContain("a@");
        UUID m1 = UUID.randomUUID();
        UUID m2 = UUID.randomUUID();
        var create = new SampleImporter.Step("branch:X", "branch", "X", SampleImporter.Action.CREATE, null, () -> { });
        var keep = new SampleImporter.Step("branch:X", "branch", "X", SampleImporter.Action.KEEP, null, null);
        String base = SampleImporter.fingerprint("db", m1, List.of(create));
        assertThat(base).hasSize(16).matches("[0-9a-f]{16}");
        assertThat(SampleImporter.fingerprint("db", m1, List.of(create))).isEqualTo(base);
        assertThat(SampleImporter.fingerprint("db", m2, List.of(create))).isNotEqualTo(base);
        assertThat(SampleImporter.fingerprint("other", m1, List.of(create))).isNotEqualTo(base);
        assertThat(SampleImporter.fingerprint("db", m1, List.of(keep))).isNotEqualTo(base);
        // Deterministic identifiers are per merchant: the same sample key never collides across merchants.
        assertThat(SampleImporter.deterministic(m1, "device:a")).isEqualTo(SampleImporter.deterministic(m1, "device:a"))
                .isNotEqualTo(SampleImporter.deterministic(m2, "device:a"));
    }
}
