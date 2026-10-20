package rw.oupay;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.stream.Collectors;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * Source-level guards for the trust boundaries. They are deliberately crude (text scans) so they are
 * hard to fool by refactoring: a violation fails the build with the offending file named.
 */
class ArchitectureTest {

    private static final Path MAIN = Path.of("src/main/java/rw/oupay");

    private static List<Path> sources() throws IOException {
        try (Stream<Path> files = Files.walk(MAIN)) {
            return files.filter(p -> p.toString().endsWith(".java")).collect(Collectors.toList());
        }
    }

    private static String module(Path file) {
        return MAIN.relativize(file).getName(0).toString();
    }

    @Test
    void onlyTheProviderBoundaryAndTheLedgerCanCauseABankEvent() throws IOException {
        // The processor is the ONLY code that creates bank transactions. Nothing merchant- or customer-facing may reach it.
        List<String> offenders = sources().stream()
                .filter(p -> !p.getFileName().toString().equals("BankEventProcessor.java"))
                .filter(p -> code(p).contains("BankEventProcessor"))
                .map(p -> MAIN.relativize(p).toString().replace('\\', '/'))
                .collect(Collectors.toList());
        assertThat(offenders).containsExactly("banking/ProviderWebhookController.java");
    }

    @Test
    void bankTransactionsAreInsertedByNobodyButTheProcessor() throws IOException {
        List<String> offenders = sources().stream()
                .filter(p -> !p.getFileName().toString().equals("BankEventProcessor.java"))
                .filter(p -> read(p).toLowerCase().contains("insert into bank_transactions"))
                .map(Path::toString).collect(Collectors.toList());
        assertThat(offenders).isEmpty();
        // Nor does any code construct one: the entity has no public constructor.
        assertThat(read(MAIN.resolve("ledger/BankTransaction.java"))).doesNotContain("public BankTransaction(");
    }

    @Test
    void publicPaymentCodeNeverTouchesTheMerchantWideLedger() throws IOException {
        String publicService = read(MAIN.resolve("payment/PublicPaymentService.java"));
        for (String forbidden : new String[] {"ReconciliationService", "BankTransactionRepository", "PaymentAllocationRepository",
                "MerchantAccess", "InvoiceRepository", "findAllForMerchant"}) {
            assertThat(publicService).as("PublicPaymentService must not use " + forbidden).doesNotContain(forbidden);
        }
        String controller = read(MAIN.resolve("payment/PublicPaymentController.java"));
        assertThat(controller).doesNotContain("Repository").doesNotContain("ReconciliationService");
    }

    @Test
    void everyMerchantScopedServiceAuthorisesAtTheServiceBoundary() throws IOException {
        // Each service that reads or writes business data must call MerchantAccess itself (not rely on controllers).
        for (String file : new String[] {"invoice/InvoiceService.java", "branch/BranchService.java", "staff/StaffService.java",
                "merchant/MerchantService.java", "merchant/MerchantSettingsService.java", "idempotency/IdempotencyService.java", "banking/BankingService.java", "ledger/ReconciliationService.java",
                "payment/PaymentProfileService.java", "notification/NotificationService.java", "dashboard/DashboardService.java", "audit/AuditService.java"}) {
            String source = read(MAIN.resolve(file));
            assertThat(source).as(file).contains("MerchantAccess").containsPattern("access\\.require(Member)?\\(");
        }
    }

    @Test
    void onlyTheIdempotencyServiceAndHousekeepingTouchTheIdempotencyTable() throws IOException {
        // The HTTP replay cache has one writer and one pruner. Nothing else may read it, rely on it, or decide anything from it.
        List<String> offenders = sources().stream()
                .filter(p -> read(p).toLowerCase().contains("idempotency_keys"))
                .map(p -> MAIN.relativize(p).toString().replace('\\', '/'))
                .collect(Collectors.toList());
        assertThat(offenders).containsExactlyInAnyOrder("idempotency/IdempotencyService.java", "common/Housekeeping.java");
    }

    @Test
    void controllersContainNoBusinessLogicOrRepositoryAccess() throws IOException {
        List<String> offenders = sources().stream()
                .filter(p -> p.getFileName().toString().endsWith("Controller.java"))
                .filter(p -> !p.getFileName().toString().equals("ProviderWebhookController.java"))
                .filter(p -> read(p).contains("Repository"))
                .map(p -> MAIN.relativize(p).toString()).collect(Collectors.toList());
        assertThat(offenders).isEmpty();
    }

    @Test
    void noSecretsAreHardCodedOrLogged() throws IOException {
        for (Path file : sources()) {
            String text = read(file);
            assertThat(text).as(file.toString()).doesNotContainPattern("(?i)log\\.(info|warn|error|debug)\\([^;]*(password|rawBody|rawPayload|token)");
        }
        // The only default for the simulator secret is the empty string; the dev profile sets a dev-only one.
        assertThat(read(Path.of("src/main/resources/application.yml"))).contains("shared-secret: \"\"");
        assertThat(read(Path.of("src/main/resources/application-prod.yml"))).contains("enabled: false");
    }

    @Test
    void moneyIsNeverAFloatingPointType() throws IOException {
        for (Path file : sources()) {
            String text = read(file);
            assertThat(text).as(file.toString()).doesNotContainPattern("\\b(double|float|Double|Float)\\s+\\w*(amount|total|balance|price|remaining|rwf)");
        }
    }

    /** Source with comments removed, so documentation can mention a class without counting as a dependency. */
    private static String code(Path path) {
        return read(path).replaceAll("(?s)/\\*.*?\\*/", "").replaceAll("(?m)//.*$", "");
    }

    private static String read(Path path) {
        try {
            return Files.readString(path);
        } catch (IOException e) {
            throw new IllegalStateException(e);
        }
    }
}
