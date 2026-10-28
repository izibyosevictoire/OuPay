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
                "payment/PaymentProfileService.java", "checkout/SimplifiedCheckoutService.java", "checkout/CodeCheckoutService.java", "kyc/KycService.java", "notification/NotificationService.java", "dashboard/DashboardService.java", "audit/AuditService.java"}) {
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
    void provenanceAndPaymentLifetimeAreChosenByTrustedCodeNeverByAController() throws IOException {
        // Controllers only call the ordinary service methods. The trusted entry points (a chosen sale channel, a durable client
        // request id, a chosen payment-request lifetime) exist for server code, so no request can impersonate a checkout flow.
        List<String> offenders = sources().stream()
                .filter(p -> p.getFileName().toString().endsWith("Controller.java"))
                .filter(p -> {
                    String source = code(p);
                    return source.contains("SaleChannel") || source.contains("InvoiceCreation") || source.contains("createDraftFor")
                            || source.contains("PaymentRequestOptions") || source.contains("PaymentRequestSource");
                })
                .map(p -> MAIN.relativize(p).toString().replace('\\', '/'))
                .collect(Collectors.toList());
        assertThat(offenders).isEmpty();
    }

    @Test
    void onlyTheCheckoutServiceUsesTheTrustedInvoiceAndPaymentRequestEntryPoints() throws IOException {
        // The trusted entry points belong to the module that defines them and to the checkout orchestrators.
        List<String> offenders = sources().stream()
                .filter(p -> {
                    String relative = MAIN.relativize(p).toString().replace('\\', '/');
                    return !relative.startsWith("invoice/") && !relative.startsWith("payment/") && !relative.startsWith("checkout/");
                })
                .filter(p -> {
                    String source = code(p);
                    return source.contains("createDraftFor") || source.contains("PaymentRequestOptions");
                })
                .map(p -> MAIN.relativize(p).toString().replace('\\', '/'))
                .collect(Collectors.toList());
        assertThat(offenders).isEmpty();
    }

    @Test
    void theCheckoutIsOneTransactionOwnedByTheIdempotencyService() throws IOException {
        // No code commits independently of its caller...
        List<String> independent = sources().stream()
                .filter(p -> code(p).contains("REQUIRES_NEW") || code(p).contains("Propagation.NOT_SUPPORTED") || code(p).contains("Propagation.NEVER"))
                .map(p -> MAIN.relativize(p).toString().replace('\\', '/'))
                .collect(Collectors.toList());
        assertThat(independent).isEmpty();
        // ...programmatic transactions exist only where they are the point (the idempotency wrapper, the e-mail dispatcher)...
        List<String> templates = sources().stream()
                .filter(p -> code(p).contains("TransactionTemplate"))
                .map(p -> MAIN.relativize(p).toString().replace('\\', '/'))
                .collect(Collectors.toList());
        assertThat(templates).containsExactlyInAnyOrder("idempotency/IdempotencyService.java", "email/EmailOutboxDispatcher.java");
        // ...and the orchestrator itself is not transactional (executeOnce refuses to run inside a transaction), has no external
        // side effect, and creates its rows only through the invoice and payment services.
        String checkout = code(MAIN.resolve("checkout/SimplifiedCheckoutService.java"));
        assertThat(checkout.split("@Transactional", -1).length - 1).isEqualTo(1); // options() only, read-only
        assertThat(checkout).containsPattern("@Transactional\\(readOnly = true\\)\\s+public CheckoutDtos.SimpleCheckoutOptions options");
        for (String forbidden : new String[] {"Email", "HttpClient", "RestClient", "WebClient", "JdbcClient", "ProviderRegistry", "BankingService"}) {
            assertThat(checkout).as("the checkout must not use " + forbidden).doesNotContain(forbidden);
        }
        assertThat(checkout).contains("idempotency.executeOnce(");
    }

    @Test
    void theCodeCheckoutIsOneTransactionOwnedByTheIdempotencyService() throws IOException {
        // Like the simplified checkout: not transactional itself (only two read-only queries are), no external side effect, and it
        // creates the invoice and the payment request only through their services. It may write its own snapshot row (same transaction).
        String checkout = code(MAIN.resolve("checkout/CodeCheckoutService.java"));
        assertThat(checkout.split("@Transactional", -1).length - 1).isEqualTo(2);
        for (String forbidden : new String[] {"Email", "HttpClient", "RestClient", "WebClient", "ProviderRegistry", "BankingService", "InvoiceRepository",
                "insert into invoices", "insert into payment_requests", "idempotency_keys"}) {
            assertThat(checkout).as("the code checkout must not use " + forbidden).doesNotContain(forbidden);
        }
        assertThat(checkout).contains("idempotency.executeOnce(").contains("createDraftFor").contains("createCodeSaleRequest");
        // The customer page is anonymous and read-only: it never writes and never reaches the merchant-wide ledger.
        String page = code(MAIN.resolve("checkout/PublicCodeSaleService.java"));
        for (String forbidden : new String[] {"MerchantAccess", "InvoiceRepository", "BankTransactionRepository", "PaymentAllocationRepository", "insert into", "update ", "delete from"}) {
            assertThat(page).as("the public code sale page must not use " + forbidden).doesNotContain(forbidden);
        }
    }

    @Test
    void noWebEndpointCanRecordWhatTheBankDidWithAKycApplication() throws IOException {
        // Hand-off, requests for information and decisions exist only with evidence, in a service that has no HTTP surface.
        for (Path file : sources()) {
            if (file.getFileName().toString().endsWith("Controller.java")) {
                assertThat(code(file)).as(file.getFileName().toString()).doesNotContain("KycEvidenceService");
            }
        }
        // And no KYC request body can carry a status, evidence or a decision.
        java.util.regex.Matcher matcher = java.util.regex.Pattern.compile("record\\s+(\\w+Request)\\s*\\((.*?)\\)\\s*\\{\\}", java.util.regex.Pattern.DOTALL)
                .matcher(code(MAIN.resolve("kyc/KycDtos.java")));
        int seen = 0;
        while (matcher.find()) {
            seen++;
            String components = matcher.group(2).toLowerCase(java.util.Locale.ROOT);
            for (String forbidden : new String[] {"status", "evidence", "handoff", "handedoff", "decision", "approved", "rejected"}) {
                assertThat(components).as(matcher.group(1)).doesNotContain(forbidden);
            }
        }
        assertThat(seen).isGreaterThanOrEqualTo(5);
    }

    @Test
    void noRequestBodyCanCarryProvenance() throws IOException {
        // Wire records that ARE request bodies (named ...Request, ...Body or ...Input) never declare provenance fields.
        java.util.regex.Pattern record = java.util.regex.Pattern.compile("record\\s+(\\w+(?:Request|Body|Input))\\s*\\((.*?)\\)\\s*\\{\\}", java.util.regex.Pattern.DOTALL);
        List<String> offenders = new java.util.ArrayList<>();
        for (Path file : sources()) {
            if (!file.getFileName().toString().endsWith("Dtos.java")) {
                continue;
            }
            var matcher = record.matcher(code(file));
            while (matcher.find()) {
                String components = matcher.group(2);
                // The simplified checkout's body carries the client's stable sale identifier (that is its contract), and nothing
                // else of the provenance: never a channel, a source or a creator.
                boolean mayCarryClientRequestId = file.getFileName().toString().equals("CheckoutDtos.java")
                        || file.getFileName().toString().equals("CodeCheckoutDtos.java");
                if (components.contains("SaleChannel") || (components.contains("clientRequestId") && !mayCarryClientRequestId)
                        || components.contains("PaymentRequestSource")
                        || components.contains("createdByUserId") || components.contains("saleChannel")) {
                    offenders.add(file.getFileName() + ":" + matcher.group(1));
                }
            }
        }
        assertThat(offenders).isEmpty();
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
