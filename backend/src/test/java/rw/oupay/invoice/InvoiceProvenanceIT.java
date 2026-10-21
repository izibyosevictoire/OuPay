package rw.oupay.invoice;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.TestComponent;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.http.HttpMethod;
import org.springframework.http.ResponseEntity;
import org.springframework.stereotype.Controller;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.ResponseBody;
import rw.oupay.idempotency.IdempotencyService;
import rw.oupay.payment.PaymentDtos;
import rw.oupay.payment.PaymentProfileService;
import rw.oupay.payment.PaymentRequestOptions;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;
import rw.oupay.support.World;
import tools.jackson.databind.json.JsonMapper;

/**
 * R3 against a real PostgreSQL: where invoices and payment requests come from, the durable identity of a sale-creation
 * request, and a configurable payment-request lifetime, with every existing behaviour unchanged.
 *
 * <p>The trusted entry points (a chosen sale channel, a durable client request id, a chosen lifetime) have no controller of
 * their own, by design. A small test-only endpoint, registered by this test's own configuration, stands in for the future
 * checkout callers so they can be exercised through real HTTP, authentication and transactions.
 */
class InvoiceProvenanceIT extends IntegrationTest {

    private static final String GUARD_INVOICES = "trg_invoices_provenance_guard";
    private static final String GUARD_REQUESTS = "trg_payment_requests_provenance";

    @TestConfiguration
    static class Endpoints {
        @Bean
        TrustedCheckoutEndpoint trustedCheckoutEndpoint(InvoiceService invoices, PaymentProfileService payments, JsonMapper json,
                                                        IdempotencyService idempotency) {
            return new TrustedCheckoutEndpoint(invoices, payments, json, idempotency);
        }
    }

    // Since Spring 6 a type-level @RequestMapping alone does not make a bean a web handler: @Controller is required.
    @Controller
    @TestComponent
    @RequestMapping("/api/v1/merchants/{merchantId}/provenance-test")
    @ResponseBody
    static class TrustedCheckoutEndpoint {

        private final InvoiceService invoices;
        private final PaymentProfileService payments;
        private final JsonMapper json;
        private final IdempotencyService idempotency;

        TrustedCheckoutEndpoint(InvoiceService invoices, PaymentProfileService payments, JsonMapper json, IdempotencyService idempotency) {
            this.invoices = invoices;
            this.payments = payments;
            this.json = json;
            this.idempotency = idempotency;
        }

        /** A trusted caller using only the durable request identity. */
        @PostMapping("/invoices")
        ResponseEntity<Map<String, Object>> create(@PathVariable UUID merchantId, @RequestBody Map<String, Object> body) {
            InvoiceService.DraftOutcome outcome = invoices.createDraftFor(merchantId, draftOf(body), creationOf(body));
            return ResponseEntity.status(outcome.created() ? 201 : 200).body(describe(outcome.invoice(), outcome.created()));
        }

        /** What R4 will do: the same trusted call inside R2's executeOnce, so both protections are in play. */
        @PostMapping("/invoices-idempotent")
        ResponseEntity<Map<String, Object>> createIdempotent(@PathVariable UUID merchantId,
                                                             @RequestHeader(value = IdempotencyService.HEADER, required = false) String key,
                                                             @RequestBody Map<String, Object> body) {
            InvoiceCreation creation = creationOf(body);
            InvoiceDtos.DraftRequest draft = draftOf(body);
            String fingerprint = idempotency.fingerprintOf("TEST_TRUSTED_INVOICE", Map.of("merchantId", merchantId), body);
            var outcome = idempotency.executeOnce(merchantId, "TEST_TRUSTED_INVOICE", key, fingerprint,
                    () -> {
                        InvoiceService.DraftOutcome created = invoices.createDraftFor(merchantId, draft, creation);
                        return new IdempotencyService.Created<>(describe(created.invoice(), created.created()), "invoice", created.invoice().id());
                    },
                    stored -> describe(invoices.get(merchantId, stored.entityId()), false));
            boolean createdNow = !outcome.replayed() && Boolean.TRUE.equals(outcome.response().get("created"));
            return ResponseEntity.status(createdNow ? 201 : 200).body(outcome.response());
        }

        @PostMapping("/invoices/{invoiceId}/payment-requests")
        ResponseEntity<PaymentDtos.RequestDto> request(@PathVariable UUID merchantId, @PathVariable UUID invoiceId,
                                                       @RequestParam long minutes) {
            return ResponseEntity.ok(payments.createInvoiceRequest(merchantId, invoiceId,
                    PaymentRequestOptions.ofLifetime(Duration.ofMinutes(minutes))));
        }

        private InvoiceCreation creationOf(Map<String, Object> body) {
            Object rawId = body.get("clientRequestId");
            return new InvoiceCreation(SaleChannel.valueOf(String.valueOf(body.get("channel"))),
                    rawId == null ? null : UUID.fromString(rawId.toString()));
        }

        private InvoiceDtos.DraftRequest draftOf(Map<String, Object> body) {
            return json.readValue(json.writeValueAsString(body.get("draft")), InvoiceDtos.DraftRequest.class);
        }

        private static Map<String, Object> describe(InvoiceDtos.InvoiceDto invoice, boolean created) {
            return Map.<String, Object>of("id", invoice.id().toString(), "invoiceNumber", invoice.invoiceNumber(),
                    "saleChannel", invoice.saleChannel().name(), "created", created, "version", invoice.version(),
                    "grandTotal", invoice.grandTotal());
        }
    }

    World w;

    @BeforeEach
    void world() {
        w = World.create(this);
    }

    // ---- helpers -------------------------------------------------------------------------------

    private String inv(String path) {
        return "/api/v1/merchants/" + w.merchantId + "/invoices" + path;
    }

    private String trusted(UUID merchantId, String path) {
        return "/api/v1/merchants/" + merchantId + "/provenance-test" + path;
    }

    private TestApi.Response trustedCreate(TestApi api, UUID merchantId, String channel, UUID clientRequestId, Map<String, Object> draft) {
        Map<String, Object> body = new HashMap<>();
        body.put("channel", channel);
        body.put("draft", draft);
        if (clientRequestId != null) {
            body.put("clientRequestId", clientRequestId.toString());
        }
        return api.post(trusted(merchantId, "/invoices"), body);
    }

    private Map<String, Object> draftForCashier() {
        return w.draft(w.cashierPerson.userId(), 20_000);
    }

    /** One invoice line shaped exactly like the shared test draft's, with the given figures. */
    private Map<String, Object> line(Object quantity, long unitPrice, long discount, String taxCategory, int taxRateBp) {
        return Map.of("description", "Printer paper", "quantity", quantity, "unitPrice", unitPrice, "discount", discount,
                "taxRate", Map.of("category", taxCategory, "rateBp", taxRateBp));
    }

    private Map<String, Object> withLines(Map<String, Object> base, List<Map<String, Object>> lines) {
        Map<String, Object> draft = new HashMap<>(base);
        draft.put("items", lines);
        return draft;
    }

    private Map<String, Object> with(Map<String, Object> base, String field, Object value) {
        Map<String, Object> draft = new HashMap<>(base);
        draft.put(field, value);
        return draft;
    }

    private TestApi.Response idempotentCreate(TestApi api, UUID merchantId, String httpKey, String channel, UUID clientRequestId,
                                              Map<String, Object> draft) {
        Map<String, Object> body = new HashMap<>();
        body.put("channel", channel);
        body.put("draft", draft);
        body.put("clientRequestId", clientRequestId.toString());
        return api.send(HttpMethod.POST, trusted(merchantId, "/invoices-idempotent"), body, Map.of("Idempotency-Key", httpKey));
    }

    private int invoiceCount() {
        return jdbc.queryForObject("select count(*) from invoices", Integer.class);
    }

    private int numbersTaken() {
        return jdbc.queryForObject("select last_value from invoice_number_sequences where merchant_id = ?", Integer.class, w.merchantId);
    }

    /** Creates a payment link bound to one branch; returns its id. */
    private UUID createBranchProfile(UUID branchId) {
        UUID destination = jdbc.queryForObject("select id from payment_destinations where merchant_id = ?", UUID.class, w.merchantId);
        var created = w.owner.post("/api/v1/merchants/" + w.merchantId + "/payment-profiles",
                Map.of("label", "Branch till", "paymentDestinationId", destination.toString(), "branchId", branchId.toString()));
        assertThat(created.status()).as(created.body()).isEqualTo(201);
        return uuid(created);
    }

    private Map<String, Object> cafeDraft() {
        Map<String, Object> draft = new HashMap<>(w.draft(w.cafePerson.userId(), 5_000));
        draft.put("branchId", w.cafeBranchId.toString());
        return draft;
    }

    private UUID uuid(TestApi.Response response) {
        return UUID.fromString(response.json().path("id").asString());
    }

    private String channelInDb(UUID invoiceId) {
        return jdbc.queryForObject("select sale_channel from invoices where id = ?", String.class, invoiceId);
    }

    /** Runs the work with one of the provenance triggers switched off, to simulate rows that predate it or to test the other constraints. */
    private void withoutGuard(String table, String trigger, Runnable work) {
        jdbc.execute("alter table " + table + " disable trigger " + trigger);
        try {
            work.run();
        } finally {
            jdbc.execute("alter table " + table + " enable trigger " + trigger);
        }
    }

    /** Creates an active, business-wide payment link so invoices can be collected for; returns its public token. */
    private String ensureProfile() {
        UUID destination = jdbc.queryForObject("select id from payment_destinations where merchant_id = ?", UUID.class, w.merchantId);
        var created = w.owner.post("/api/v1/merchants/" + w.merchantId + "/payment-profiles",
                Map.of("label", "Counter", "paymentDestinationId", destination.toString()));
        assertThat(created.status()).as(created.body()).isEqualTo(201);
        return created.json().path("paymentProfileId").asString();
    }

    private TestApi.Response requestFor(TestApi api, UUID invoiceId) {
        return api.post(inv("/" + invoiceId + "/payment-requests"), null);
    }

    private TestApi.Response issue(TestApi api, UUID invoiceId, long version) {
        return api.post(inv("/" + invoiceId + "/issue?expectedVersion=" + version), null);
    }

    /** A copy of an existing request's row with the given invoice, reference and provenance, to probe the constraints directly. */
    private void insertRequestLike(UUID requestId, UUID invoiceId, String reference, String source, UUID branchId, UUID creatorId) {
        jdbc.update("insert into payment_requests (id, merchant_id, payment_profile_id, invoice_id, requested_amount_rwf, currency, "
                + "public_reference, expires_at, created_at, updated_at, source, branch_id, created_by_user_id) "
                + "select gen_random_uuid(), merchant_id, payment_profile_id, cast(? as uuid), requested_amount_rwf, currency, "
                + "cast(? as varchar), expires_at, created_at, updated_at, cast(? as varchar), cast(? as uuid), cast(? as uuid) "
                + "from payment_requests where id = ?", invoiceId, reference, source, branchId, creatorId, requestId);
    }

    // ---- migration and legacy compatibility ----------------------------------------------------

    @Test
    void invoicesCreatedBeforeProvenanceReadAsInvoiceAndAreNeverRewritten() {
        UUID id = w.issuedInvoice(7_500);
        int invoicesBefore = jdbc.queryForObject("select count(*) from invoices", Integer.class);
        long totalBefore = jdbc.queryForObject("select sum(grand_total_rwf) from invoices", Long.class);
        // An invoice from before V8 has no stored provenance.
        withoutGuard("invoices", GUARD_INVOICES, () -> jdbc.update("update invoices set sale_channel = null where id = ?", id));
        assertThat(channelInDb(id)).isNull();

        var single = w.owner.get(inv("/" + id));
        assertThat(single.json().path("saleChannel").asString()).isEqualTo("INVOICE");
        var items = w.owner.get(inv("")).json().path("items");
        assertThat(items.size()).isEqualTo(1);
        assertThat(items.get(0).path("saleChannel").asString()).isEqualTo("INVOICE");

        // Every existing flow runs unchanged and leaves the record exactly as it was.
        long version = single.json().path("version").asLong();
        var voided = w.owner.post(inv("/" + id + "/void?expectedVersion=" + version), Map.of("reason", "Entered in error"));
        assertThat(voided.status()).isEqualTo(200);
        assertThat(voided.json().path("saleChannel").asString()).isEqualTo("INVOICE");
        assertThat(channelInDb(id)).isNull();
        assertThat(jdbc.queryForObject("select count(*) from invoices", Integer.class)).isEqualTo(invoicesBefore);
        assertThat(jdbc.queryForObject("select sum(grand_total_rwf) from invoices", Long.class)).isEqualTo(totalBefore);
    }

    @Test
    void existingPaymentRequestsWithoutProvenanceStayReadableAndPayable() {
        ensureProfile();
        UUID id = w.issuedInvoice(12_000);
        var request = requestFor(w.owner, id).json();
        UUID requestId = UUID.fromString(request.path("id").asString());
        // A request from before V8 has no stored provenance.
        withoutGuard("payment_requests", GUARD_REQUESTS, () -> jdbc.update(
                "update payment_requests set source = null, branch_id = null, created_by_user_id = null where id = ?", requestId));

        var listed = w.owner.get(inv("/" + id + "/payment-requests")).json();
        assertThat(listed.size()).isEqualTo(1);
        assertThat(listed.get(0).path("id").asString()).isEqualTo(requestId.toString());
        assertThat(listed.get(0).path("status").asString()).isIn("CREATED", "AWAITING_PAYMENT");

        // It is still found by its reference and the verified bank payment settles the invoice.
        var paid = w.bank.pay("POSTED", 12_000, request.path("publicReference").asString());
        assertThat(paid.outcome()).isEqualTo("APPLIED");
        assertThat(w.owner.get(inv("/" + id)).json().path("paymentStatus").asString()).isEqualTo("PAID");
    }

    @Test
    void theDatabaseRejectsInvalidProvenance() {
        UUID id = w.issuedInvoice(5_000);
        ensureProfile();
        requestFor(w.owner, id);
        withoutGuard("invoices", GUARD_INVOICES, () -> {
            // (A request id and fingerprint are supplied so that only the channel constraint is exercised here.)
            assertThatThrownBy(() -> jdbc.update("update invoices set sale_channel = 'BOGUS', client_request_id = gen_random_uuid(), "
                    + "client_request_sha256 = repeat('a', 64) where id = ?", id))
                    .hasStackTraceContaining("ck_invoices_sale_channel");
            // A checkout channel without its durable request id is refused.
            assertThatThrownBy(() -> jdbc.update("update invoices set sale_channel = 'POS' where id = ?", id))
                    .hasStackTraceContaining("ck_invoices_checkout_request_id");
            // The request id and its fingerprint exist together, and the fingerprint is a real digest.
            assertThatThrownBy(() -> jdbc.update("update invoices set client_request_id = gen_random_uuid() where id = ?", id))
                    .hasStackTraceContaining("ck_invoices_request_identity");
            assertThatThrownBy(() -> jdbc.update("update invoices set client_request_sha256 = repeat('a', 64) where id = ?", id))
                    .hasStackTraceContaining("ck_invoices_request_identity");
            assertThatThrownBy(() -> jdbc.update("update invoices set client_request_id = gen_random_uuid(), "
                    + "client_request_sha256 = 'not-a-digest' where id = ?", id))
                    .hasStackTraceContaining("ck_invoices_request_sha256");
        });
        withoutGuard("payment_requests", GUARD_REQUESTS, () -> {
            assertThatThrownBy(() -> jdbc.update("update payment_requests set source = 'BOGUS' where invoice_id = ?", id))
                    .hasStackTraceContaining("ck_payment_requests_source");
            // OPEN while an invoice is attached (the creator is cleared so that only this rule is exercised).
            assertThatThrownBy(() -> jdbc.update("update payment_requests set source = 'OPEN', created_by_user_id = null where invoice_id = ?", id))
                    .hasStackTraceContaining("ck_payment_requests_source_invoice");
            // A branch or a creator without a source is half a record.
            assertThatThrownBy(() -> jdbc.update("update payment_requests set source = null where invoice_id = ?", id))
                    .hasStackTraceContaining("ck_payment_requests_provenance_whole");
        });
    }

    @Test
    void theDatabaseRejectsADuplicateClientRequestIdWithinABusiness() {
        UUID clientRequestId = UUID.randomUUID();
        assertThat(trustedCreate(w.owner, w.merchantId, "POS", clientRequestId, draftForCashier()).status()).isEqualTo(201);
        UUID other = uuid(w.owner.post(inv(""), draftForCashier()));
        withoutGuard("invoices", GUARD_INVOICES, () -> assertThatThrownBy(() -> jdbc.update(
                "update invoices set sale_channel = 'POS', client_request_id = ?, client_request_sha256 = repeat('b', 64) where id = ?",
                clientRequestId, other))
                .hasStackTraceContaining("ux_invoices_client_request"));
        assertThat(jdbc.queryForObject("select count(*) from invoices where client_request_id = ?", Integer.class, clientRequestId)).isEqualTo(1);
    }

    @Test
    void theSameClientRequestIdMayBeUsedByDifferentBusinesses() {
        UUID clientRequestId = UUID.randomUUID();
        var shop = trustedCreate(w.owner, w.merchantId, "POS", clientRequestId, draftForCashier());
        var cafe = trustedCreate(w.cafeOwner, w.cafeMerchantId, "POS", clientRequestId, cafeDraft());

        assertThat(shop.status()).isEqualTo(201);
        assertThat(cafe.status()).as(cafe.body()).isEqualTo(201);
        assertThat(uuid(shop)).isNotEqualTo(uuid(cafe));
        assertThat(jdbc.queryForObject("select count(*) from invoices where client_request_id = ?", Integer.class, clientRequestId)).isEqualTo(2);
        // Another business's identifier is never a way into its invoices.
        assertThat(trustedCreate(w.cafeOwner, w.merchantId, "POS", clientRequestId, draftForCashier()).status()).isEqualTo(404);
    }

    @Test
    void invoiceRequestsMustStayInsideTheirBusinessAndTheirInvoicesBranch() {
        ensureProfile();
        UUID invoiceId = w.issuedInvoice(8_000);
        UUID requestId = UUID.fromString(requestFor(w.owner, invoiceId).json().path("id").asString());

        // Another business's branch, with or without an invoice attached.
        assertThatThrownBy(() -> insertRequestLike(requestId, invoiceId, "OP-AAAAAAAAAAA2", "INVOICE", w.cafeBranchId, w.ownerPerson.userId()))
                .hasStackTraceContaining("fk_payment_requests_branch");
        // A branch of this business that is not the invoice's branch.
        assertThatThrownBy(() -> insertRequestLike(requestId, invoiceId, "OP-AAAAAAAAAAA3", "INVOICE", w.inactiveBranchId, w.ownerPerson.userId()))
                .hasStackTraceContaining("fk_payment_requests_invoice_branch");
        // A creator who is not a member of the request's business.
        assertThatThrownBy(() -> insertRequestLike(requestId, invoiceId, "OP-AAAAAAAAAAA4", "INVOICE", w.branchId, w.cafePerson.userId()))
                .hasStackTraceContaining("fk_payment_requests_creator");
        // NULL cannot stand in for the branch or the creator of an invoice request.
        assertThatThrownBy(() -> insertRequestLike(requestId, invoiceId, "OP-AAAAAAAAAAA5", "INVOICE", null, w.ownerPerson.userId()))
                .hasStackTraceContaining("ck_payment_requests_invoice_attribution");
        assertThatThrownBy(() -> insertRequestLike(requestId, invoiceId, "OP-AAAAAAAAAAA6", "INVOICE", w.branchId, null))
                .hasStackTraceContaining("ck_payment_requests_invoice_attribution");
        // A source that disagrees with the invoice's sale channel.
        assertThatThrownBy(() -> insertRequestLike(requestId, invoiceId, "OP-AAAAAAAAAAA7", "POS", w.branchId, w.ownerPerson.userId()))
                .hasStackTraceContaining("must match the sale channel");
        // The source INVOICE with no invoice at all.
        assertThatThrownBy(() -> insertRequestLike(requestId, null, "OP-AAAAAAAAAAA8", "INVOICE", w.branchId, w.ownerPerson.userId()))
                .hasStackTraceContaining("ck_payment_requests_source_invoice");
        // The consistent version is accepted.
        insertRequestLike(requestId, invoiceId, "OP-AAAAAAAAAAA9", "INVOICE", w.branchId, w.ownerPerson.userId());
        assertThat(jdbc.queryForObject("select count(*) from payment_requests where invoice_id = ?", Integer.class, invoiceId)).isEqualTo(2);
    }

    @Test
    void aCheckoutInvoiceCannotBeCollectedWithNullOrForgedProvenance() {
        ensureProfile();
        var draft = trustedCreate(w.owner, w.merchantId, "POS", UUID.randomUUID(), draftForCashier());
        UUID posInvoice = uuid(draft);
        issue(w.owner, posInvoice, draft.json().path("version").asLong());
        UUID template = UUID.fromString(requestFor(w.owner, w.issuedInvoice(3_000)).json().path("id").asString());

        // An older application instance, or any code path that records no provenance, cannot open a request for a POS invoice.
        assertThatThrownBy(() -> insertRequestLike(template, posInvoice, "OP-AAAAAAAAAAB2", null, null, null))
                .hasStackTraceContaining("must record its source");
        // A source recorded for another channel is refused as well.
        assertThatThrownBy(() -> insertRequestLike(template, posInvoice, "OP-AAAAAAAAAAB3", "SIMPLIFIED", w.branchId, w.ownerPerson.userId()))
                .hasStackTraceContaining("must match the sale channel");
        assertThatThrownBy(() -> insertRequestLike(template, posInvoice, "OP-AAAAAAAAAAB4", "INVOICE", w.branchId, w.ownerPerson.userId()))
                .hasStackTraceContaining("must match the sale channel");
        // And it cannot omit its branch or its creator.
        assertThatThrownBy(() -> insertRequestLike(template, posInvoice, "OP-AAAAAAAAAAB5", "POS", null, w.ownerPerson.userId()))
                .hasStackTraceContaining("ck_payment_requests_invoice_attribution");
        // The complete, consistent record is accepted.
        insertRequestLike(template, posInvoice, "OP-AAAAAAAAAAB6", "POS", w.branchId, w.ownerPerson.userId());
        assertThat(jdbc.queryForObject("select source from payment_requests where public_reference = 'OP-AAAAAAAAAAB6'", String.class)).isEqualTo("POS");
    }

    @Test
    void anOpenRequestCannotForgeInvoiceMetadata() {
        ensureProfile();
        UUID branchProfile = createBranchProfile(w.branchId);
        UUID invoiceId = w.issuedInvoice(4_000);
        var request = requestFor(w.owner, invoiceId).json();
        UUID template = UUID.fromString(request.path("id").asString());
        // The request was opened through the branch-bound link (the best match for this invoice).
        assertThat(UUID.fromString(request.path("paymentProfileId").asString())).isEqualTo(branchProfile);

        // An open request has no creator: it cannot claim a member's identity.
        assertThatThrownBy(() -> insertRequestLike(template, null, "OP-AAAAAAAAAAC2", "OPEN", w.branchId, w.ownerPerson.userId()))
                .hasStackTraceContaining("ck_payment_requests_open_anonymous");
        // It cannot carry a branch other than its own link's.
        assertThatThrownBy(() -> insertRequestLike(template, null, "OP-AAAAAAAAAAC3", "OPEN", w.inactiveBranchId, null))
                .hasStackTraceContaining("only carry the branch of its own payment link");
        assertThatThrownBy(() -> insertRequestLike(template, null, "OP-AAAAAAAAAAC4", "OPEN", w.cafeBranchId, null))
                .hasStackTraceContaining("only carry the branch of its own payment link");
        // It cannot pose as an invoice request, or attach an invoice while calling itself OPEN.
        assertThatThrownBy(() -> insertRequestLike(template, invoiceId, "OP-AAAAAAAAAAC5", "OPEN", w.branchId, null))
                .hasStackTraceContaining("must match the sale channel");
        assertThatThrownBy(() -> insertRequestLike(template, null, "OP-AAAAAAAAAAC6", "POS", w.branchId, w.ownerPerson.userId()))
                .hasStackTraceContaining("ck_payment_requests_source_invoice");
        // Its own link's branch, or no branch, is fine.
        insertRequestLike(template, null, "OP-AAAAAAAAAAC7", "OPEN", w.branchId, null);
        insertRequestLike(template, null, "OP-AAAAAAAAAAC8", "OPEN", null, null);
        assertThat(jdbc.queryForObject("select count(*) from payment_requests where invoice_id is null", Integer.class)).isEqualTo(2);
    }

    // ---- invoice behaviour ---------------------------------------------------------------------

    @Test
    void manualInvoicesRecordTheInvoiceChannelAndALegacyBodyCannotForgeAnother() {
        var plain = w.owner.post(inv(""), draftForCashier());
        assertThat(plain.status()).isEqualTo(201);
        assertThat(plain.json().path("saleChannel").asString()).isEqualTo("INVOICE");
        assertThat(channelInDb(uuid(plain))).isEqualTo("INVOICE");
        assertThat(jdbc.queryForObject("select client_request_id from invoices where id = ?", UUID.class, uuid(plain))).isNull();

        // Extra fields in the existing endpoint's body are ignored: nobody can impersonate a checkout flow through it.
        Map<String, Object> forged = new HashMap<>(draftForCashier());
        forged.put("saleChannel", "POS");
        forged.put("sale_channel", "SIMPLIFIED");
        forged.put("clientRequestId", UUID.randomUUID().toString());
        var response = w.owner.post(inv(""), forged);
        assertThat(response.status()).isEqualTo(201);
        assertThat(response.json().path("saleChannel").asString()).isEqualTo("INVOICE");
        assertThat(channelInDb(uuid(response))).isEqualTo("INVOICE");
        assertThat(jdbc.queryForObject("select client_request_id from invoices where id = ?", UUID.class, uuid(response))).isNull();
    }

    @Test
    void provenanceSurvivesIssueCancelAndVoid() {
        // A traditional invoice, issued and then voided.
        UUID manual = uuid(w.owner.post(inv(""), draftForCashier()));
        long version = w.owner.get(inv("/" + manual)).json().path("version").asLong();
        assertThat(issue(w.owner, manual, version).status()).isEqualTo(200);
        assertThat(channelInDb(manual)).isEqualTo("INVOICE");
        long issuedVersion = w.owner.get(inv("/" + manual)).json().path("version").asLong();
        assertThat(w.owner.post(inv("/" + manual + "/void?expectedVersion=" + issuedVersion), Map.of("reason", "Entered in error")).status()).isEqualTo(200);
        assertThat(channelInDb(manual)).isEqualTo("INVOICE");

        // A POS sale, issued through the existing endpoint; another cancelled before issue.
        var posDraft = trustedCreate(w.owner, w.merchantId, "POS", UUID.randomUUID(), draftForCashier());
        UUID pos = uuid(posDraft);
        assertThat(issue(w.owner, pos, posDraft.json().path("version").asLong()).json().path("saleChannel").asString()).isEqualTo("POS");
        assertThat(channelInDb(pos)).isEqualTo("POS");
        var toCancel = trustedCreate(w.owner, w.merchantId, "SIMPLIFIED", UUID.randomUUID(), draftForCashier());
        assertThat(w.owner.post(inv("/" + uuid(toCancel) + "/cancel?expectedVersion=" + toCancel.json().path("version").asLong()), null).status()).isEqualTo(200);
        assertThat(channelInDb(uuid(toCancel))).isEqualTo("SIMPLIFIED");
    }

    @Test
    void provenanceCannotChangeAfterCreationNotEvenByEditingTheDraftOrDirectSql() {
        UUID clientRequestId = UUID.randomUUID();
        var created = trustedCreate(w.owner, w.merchantId, "POS", clientRequestId, draftForCashier());
        UUID id = uuid(created);

        assertThatThrownBy(() -> jdbc.update("update invoices set sale_channel = 'INVOICE' where id = ?", id))
                .hasMessageContaining("fixed when the invoice is created");
        assertThatThrownBy(() -> jdbc.update("update invoices set client_request_id = gen_random_uuid() where id = ?", id))
                .hasMessageContaining("fixed when the invoice is created");
        assertThatThrownBy(() -> jdbc.update("update invoices set client_request_id = null where id = ?", id))
                .hasMessageContaining("fixed when the invoice is created");
        // A legacy invoice cannot be given provenance after the fact either.
        UUID legacy = uuid(w.owner.post(inv(""), draftForCashier()));
        assertThatThrownBy(() -> jdbc.update("update invoices set client_request_id = gen_random_uuid() where id = ?", legacy))
                .hasMessageContaining("fixed when the invoice is created");

        // Editing the draft through the existing endpoint leaves provenance exactly as it was.
        var edited = w.owner.put(inv("/" + id + "?expectedVersion=" + created.json().path("version").asLong()), w.draft(w.cashierPerson.userId(), 33_000));
        assertThat(edited.status()).isEqualTo(200);
        assertThat(edited.json().path("saleChannel").asString()).isEqualTo("POS");
        assertThat(channelInDb(id)).isEqualTo("POS");
        assertThat(jdbc.queryForObject("select client_request_id from invoices where id = ?", UUID.class, id)).isEqualTo(clientRequestId);
    }

    @Test
    void trustedCreationNumbersInvoicesNormallyAndARepeatConsumesNoNumber() {
        UUID firstId = UUID.randomUUID();
        var first = trustedCreate(w.owner, w.merchantId, "POS", firstId, draftForCashier());
        var second = trustedCreate(w.owner, w.merchantId, "POS", UUID.randomUUID(), draftForCashier());
        var repeat = trustedCreate(w.owner, w.merchantId, "POS", firstId, draftForCashier());
        var third = trustedCreate(w.owner, w.merchantId, "SIMPLIFIED", UUID.randomUUID(), draftForCashier());

        assertThat(first.json().path("invoiceNumber").asString()).isEqualTo("INV-0001");
        assertThat(second.json().path("invoiceNumber").asString()).isEqualTo("INV-0002");
        assertThat(repeat.status()).isEqualTo(200);
        assertThat(repeat.json().path("created").asBoolean()).isFalse();
        assertThat(repeat.json().path("id").asString()).isEqualTo(first.json().path("id").asString());
        assertThat(repeat.json().path("invoiceNumber").asString()).isEqualTo("INV-0001");
        assertThat(third.json().path("invoiceNumber").asString()).isEqualTo("INV-0003");
        assertThat(jdbc.queryForObject("select last_value from invoice_number_sequences where merchant_id = ?", Integer.class, w.merchantId)).isEqualTo(3);
        // A manual invoice continues the same sequence.
        assertThat(w.owner.post(inv(""), draftForCashier()).json().path("invoiceNumber").asString()).isEqualTo("INV-0004");
        // The durable identity is the guard: R2's HTTP replay records are not involved at all.
        assertThat(jdbc.queryForObject("select count(*) from idempotency_keys", Integer.class)).isZero();
    }

    @Test
    void aRepeatByAnotherPersonOrForAnotherChannelIsAConflictNotADuplicate() {
        UUID clientRequestId = UUID.randomUUID();
        assertThat(trustedCreate(w.owner, w.merchantId, "POS", clientRequestId, draftForCashier()).status()).isEqualTo(201);

        for (TestApi other : List.of(w.manager, w.cashier)) {
            var conflict = trustedCreate(other, w.merchantId, "POS", clientRequestId, draftForCashier());
            assertThat(conflict.status()).isEqualTo(409);
            assertThat(conflict.code()).isEqualTo("client_request_id_reuse");
        }
        var otherChannel = trustedCreate(w.owner, w.merchantId, "SIMPLIFIED", clientRequestId, draftForCashier());
        assertThat(otherChannel.status()).isEqualTo(409);
        assertThat(otherChannel.code()).isEqualTo("client_request_id_reuse");
        assertThat(jdbc.queryForObject("select count(*) from invoices", Integer.class)).isEqualTo(1);
    }

    @Test
    void tenConcurrentCreatorsOfTheSameDurableRequestMakeExactlyOneInvoice() throws Exception {
        UUID clientRequestId = UUID.randomUUID();
        List<TestApi> clients = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            clients.add(fixtures.signIn(mvc, w.ownerPerson));
        }
        List<Callable<TestApi.Response>> creators = new ArrayList<>();
        for (TestApi client : clients) {
            creators.add(() -> trustedCreate(client, w.merchantId, "SIMPLIFIED", clientRequestId, draftForCashier()));
        }

        List<TestApi.Response> responses = concurrently(creators);

        assertThat(responses).extracting(TestApi.Response::status).containsOnly(200, 201);
        assertThat(responses).filteredOn(r -> r.status() == 201).hasSize(1);
        assertThat(responses).extracting(r -> r.json().path("id").asString()).containsOnly(
                responses.stream().filter(r -> r.status() == 201).findFirst().orElseThrow().json().path("id").asString());
        assertThat(jdbc.queryForObject("select count(*) from invoices where client_request_id = ?", Integer.class, clientRequestId)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select count(*) from invoices", Integer.class)).isEqualTo(1);
        // Only one number was ever taken.
        assertThat(jdbc.queryForObject("select last_value from invoice_number_sequences where merchant_id = ?", Integer.class, w.merchantId)).isEqualTo(1);
    }

    @Test
    void anIdenticalRetryReturnsTheExistingInvoiceAndAnyOtherPayloadUnderTheSameIdIsAConflict() {
        UUID clientRequestId = UUID.randomUUID();
        Map<String, Object> original = draftForCashier();
        var first = trustedCreate(w.owner, w.merchantId, "POS", clientRequestId, original);
        assertThat(first.status()).isEqualTo(201);

        // The same sale spelled differently (the quantity as 1.0 instead of 1) is still the same request.
        var respelled = trustedCreate(w.owner, w.merchantId, "POS", clientRequestId,
                withLines(original, List.of(line(1.0, 20_000, 0, "NOT_APPLICABLE", 0))));
        assertThat(respelled.status()).isEqualTo(200);
        assertThat(respelled.json().path("created").asBoolean()).isFalse();
        assertThat(respelled.json().path("id").asString()).isEqualTo(first.json().path("id").asString());

        // A checkout sale is due the day it is made (derived by the server): the due date is not part of its identity,
        // so a retry on another day still finds its sale.
        var otherDay = trustedCreate(w.owner, w.merchantId, "POS", clientRequestId,
                with(original, "dueAt", java.time.LocalDate.now().plusDays(15).toString()));
        assertThat(otherDay.status()).isEqualTo(200);
        assertThat(otherDay.json().path("id").asString()).isEqualTo(first.json().path("id").asString());

        // Anything that changes what the sale means or whose it is, is a conflict, never a silent reuse.
        Map<String, Map<String, Object>> conflicting = new java.util.LinkedHashMap<>();
        conflicting.put("price", w.draft(w.cashierPerson.userId(), 20_001));
        conflicting.put("assignee", w.draft(w.otherCashierPerson.userId(), 20_000));
        conflicting.put("customer", with(original, "customer", Map.of("name", "Another customer")));
        conflicting.put("notes", with(original, "notes", "extra"));
        conflicting.put("tax mode", with(original, "taxMode", "INCLUSIVE"));
        conflicting.put("quantity", withLines(original, List.of(line(2, 20_000, 0, "NOT_APPLICABLE", 0))));
        conflicting.put("discount", withLines(original, List.of(line(1, 20_000, 100, "NOT_APPLICABLE", 0))));
        conflicting.put("tax rate", withLines(original, List.of(line(1, 20_000, 0, "STANDARD", 1800))));
        conflicting.put("extra line", withLines(original, List.of(line(1, 20_000, 0, "NOT_APPLICABLE", 0), line(1, 500, 0, "NOT_APPLICABLE", 0))));
        conflicting.put("branch", with(original, "branchId", w.inactiveBranchId.toString()));
        for (Map.Entry<String, Map<String, Object>> variant : conflicting.entrySet()) {
            var response = trustedCreate(w.owner, w.merchantId, "POS", clientRequestId, variant.getValue());
            assertThat(response.status()).as(variant.getKey()).isEqualTo(409);
            assertThat(response.code()).as(variant.getKey()).isEqualTo("client_request_id_reuse");
        }

        // Nothing was created or changed by any of it.
        assertThat(invoiceCount()).isEqualTo(1);
        assertThat(numbersTaken()).isEqualTo(1);
        assertThat(jdbc.queryForObject("select grand_total_rwf from invoices", Long.class)).isEqualTo(20_000L);
    }

    @Test
    void aManualInvoiceKeepsItsDueDateInTheFingerprintWhileACheckoutSaleDoesNot() {
        UUID clientRequestId = UUID.randomUUID();
        Map<String, Object> original = draftForCashier();
        assertThat(trustedCreate(w.owner, w.merchantId, "INVOICE", clientRequestId, original).status()).isEqualTo(201);
        var otherDate = trustedCreate(w.owner, w.merchantId, "INVOICE", clientRequestId,
                with(original, "dueAt", java.time.LocalDate.now().plusDays(15).toString()));
        assertThat(otherDate.status()).isEqualTo(409);
        assertThat(otherDate.code()).isEqualTo("client_request_id_reuse");
        // The plain manual endpoint never had an identity at all: nothing changed there.
        assertThat(w.owner.post(inv(""), original).status()).isEqualTo(201);
        assertThat(jdbc.queryForObject("select count(*) from invoices where client_request_sha256 is null", Integer.class)).isEqualTo(1);
    }

    @Test
    void aRetryAfterTheHttpIdempotencyRecordsAreGoneStillCannotDuplicateOrChangeTheSale() {
        UUID clientRequestId = UUID.randomUUID();
        Map<String, Object> original = draftForCashier();
        Map<String, Object> changed = w.draft(w.cashierPerson.userId(), 30_000);

        var first = idempotentCreate(w.owner, w.merchantId, "billing-key-0001", "POS", clientRequestId, original);
        assertThat(first.status()).isEqualTo(201);
        // While the temporary record exists, R2 answers first.
        var sameKeyOtherData = idempotentCreate(w.owner, w.merchantId, "billing-key-0001", "POS", clientRequestId, changed);
        assertThat(sameKeyOtherData.status()).isEqualTo(409);
        assertThat(sameKeyOtherData.code()).isEqualTo("idempotency_key_reuse");

        // The temporary records are pruned (or never existed). The durable identity still protects the sale.
        jdbc.update("delete from idempotency_keys");
        var identical = idempotentCreate(w.owner, w.merchantId, "billing-key-0002", "POS", clientRequestId, original);
        assertThat(identical.status()).isEqualTo(200);
        assertThat(identical.json().path("id").asString()).isEqualTo(first.json().path("id").asString());
        assertThat(identical.json().path("created").asBoolean()).isFalse();

        jdbc.update("delete from idempotency_keys");
        var conflicting = idempotentCreate(w.owner, w.merchantId, "billing-key-0003", "POS", clientRequestId, changed);
        assertThat(conflicting.status()).isEqualTo(409);
        assertThat(conflicting.code()).isEqualTo("client_request_id_reuse");

        assertThat(invoiceCount()).isEqualTo(1);
        assertThat(numbersTaken()).isEqualTo(1);
        assertThat(jdbc.queryForObject("select grand_total_rwf from invoices", Long.class)).isEqualTo(20_000L);
    }

    @Test
    void theFingerprintIsComputedByTheServerStoredWithTheRequestIdAndFixed() {
        UUID clientRequestId = UUID.randomUUID();
        // A caller cannot supply a fingerprint: any such field is ignored by the legacy endpoint and by the trusted entry point.
        Map<String, Object> body = new HashMap<>();
        body.put("channel", "POS");
        body.put("clientRequestId", clientRequestId.toString());
        body.put("clientRequestSha256", "b".repeat(64));
        body.put("draft", draftForCashier());
        var created = w.owner.post(trusted(w.merchantId, "/invoices"), body);
        assertThat(created.status()).isEqualTo(201);
        UUID id = uuid(created);

        String stored = jdbc.queryForObject("select client_request_sha256 from invoices where id = ?", String.class, id);
        assertThat(stored).matches("^[0-9a-f]{64}$").isNotEqualTo("b".repeat(64));
        // A different sale under a different id has a different fingerprint; the same data and owner under another channel too.
        UUID second = uuid(trustedCreate(w.owner, w.merchantId, "POS", UUID.randomUUID(), w.draft(w.cashierPerson.userId(), 21_000)));
        UUID third = uuid(trustedCreate(w.owner, w.merchantId, "SIMPLIFIED", UUID.randomUUID(), draftForCashier()));
        assertThat(jdbc.queryForObject("select client_request_sha256 from invoices where id = ?", String.class, second)).isNotEqualTo(stored);
        assertThat(jdbc.queryForObject("select client_request_sha256 from invoices where id = ?", String.class, third)).isNotEqualTo(stored);

        // Manual invoices have neither an id nor a fingerprint, and a forged field changes nothing there either.
        Map<String, Object> forged = new HashMap<>(draftForCashier());
        forged.put("clientRequestSha256", "c".repeat(64));
        UUID manual = uuid(w.owner.post(inv(""), forged));
        assertThat(jdbc.queryForObject("select client_request_sha256 from invoices where id = ?", String.class, manual)).isNull();

        // Fixed for good: the id and its fingerprint can be neither changed nor removed, nor added to a legacy invoice.
        assertThatThrownBy(() -> jdbc.update("update invoices set client_request_sha256 = repeat('d', 64) where id = ?", id))
                .hasMessageContaining("fixed when the invoice is created");
        assertThatThrownBy(() -> jdbc.update("update invoices set client_request_sha256 = null, client_request_id = null where id = ?", id))
                .hasMessageContaining("fixed when the invoice is created");
        assertThatThrownBy(() -> jdbc.update("update invoices set client_request_id = gen_random_uuid(), client_request_sha256 = repeat('e', 64) where id = ?", manual))
                .hasMessageContaining("fixed when the invoice is created");
        assertThat(jdbc.queryForObject("select client_request_sha256 from invoices where id = ?", String.class, id)).isEqualTo(stored);
    }

    @Test
    void identicalAndConflictingConcurrentRequestsForOneIdCreateExactlyOneInvoiceAndNeverMixThem() throws Exception {
        UUID clientRequestId = UUID.randomUUID();
        List<TestApi> clients = new ArrayList<>();
        List<Callable<TestApi.Response>> requests = new ArrayList<>();
        for (int i = 0; i < 10; i++) {
            TestApi client = fixtures.signIn(mvc, w.ownerPerson);
            clients.add(client);
            // Even requests ask for 20,000, odd ones for 30,000: two different sales claiming one identifier.
            long price = i % 2 == 0 ? 20_000 : 30_000;
            requests.add(() -> trustedCreate(client, w.merchantId, "POS", clientRequestId, w.draft(w.cashierPerson.userId(), price)));
        }

        List<TestApi.Response> responses = concurrently(requests);

        long storedPrice = jdbc.queryForObject("select grand_total_rwf from invoices where client_request_id = ?", Long.class, clientRequestId);
        String storedId = jdbc.queryForObject("select id from invoices where client_request_id = ?", String.class, clientRequestId);
        assertThat(storedPrice).isIn(20_000L, 30_000L);
        int accepted = 0;
        for (int i = 0; i < responses.size(); i++) {
            long asked = i % 2 == 0 ? 20_000 : 30_000;
            var response = responses.get(i);
            if (asked == storedPrice) {
                // The winner's payload (created once, repeated by the rest) is always answered with the one invoice.
                assertThat(response.status()).as("request " + i).isIn(200, 201);
                assertThat(response.json().path("id").asString()).isEqualTo(storedId);
                accepted++;
            } else {
                assertThat(response.status()).as("request " + i).isEqualTo(409);
                assertThat(response.code()).isEqualTo("client_request_id_reuse");
            }
        }
        assertThat(accepted).isEqualTo(5);
        assertThat(responses).filteredOn(r -> r.status() == 201).hasSize(1);
        assertThat(invoiceCount()).isEqualTo(1);
        assertThat(numbersTaken()).isEqualTo(1);
    }

    @Test
    void theBranchTheCreatorAndTheAssignedCashierAreFixedOnceAnInvoiceIsIssued() {
        // A cashier creates an invoice for herself: that attribution is recorded and never changes.
        UUID draftId = uuid(w.cashier.post(inv(""), w.draft(w.cashierPerson.userId(), 5_000)));
        assertThat(jdbc.queryForObject("select created_by_user_id from invoices where id = ?", UUID.class, draftId)).isEqualTo(w.cashierPerson.userId());
        assertThat(jdbc.queryForObject("select assigned_to_user_id from invoices where id = ?", UUID.class, draftId)).isEqualTo(w.cashierPerson.userId());
        assertThatThrownBy(() -> jdbc.update("update invoices set created_by_user_id = ? where id = ?", w.ownerPerson.userId(), draftId))
                .hasMessageContaining("creator of an invoice never changes");

        // While it is a draft the branch and the assignee stay editable, through the API and directly.
        long version = w.owner.get(inv("/" + draftId)).json().path("version").asLong();
        var edited = w.owner.put(inv("/" + draftId + "?expectedVersion=" + version), w.draft(w.otherCashierPerson.userId(), 5_500));
        assertThat(edited.status()).as(edited.body()).isEqualTo(200);
        assertThat(jdbc.queryForObject("select assigned_to_user_id from invoices where id = ?", UUID.class, draftId)).isEqualTo(w.otherCashierPerson.userId());
        assertThat(jdbc.update("update invoices set branch_id = ? where id = ?", w.inactiveBranchId, draftId)).isEqualTo(1);
        assertThat(jdbc.update("update invoices set branch_id = ? where id = ?", w.branchId, draftId)).isEqualTo(1);

        // The update that issues it cannot smuggle a different branch or cashier in.
        assertThatThrownBy(() -> jdbc.update("update invoices set status = 'ISSUED', issued_at = now(), branch_id = ? where id = ?", w.inactiveBranchId, draftId))
                .hasMessageContaining("fixed");
        assertThatThrownBy(() -> jdbc.update("update invoices set status = 'ISSUED', issued_at = now(), assigned_to_user_id = ? where id = ?", w.cashierPerson.userId(), draftId))
                .hasMessageContaining("fixed");

        // Once issued, none of the three can change, however they are attempted.
        long current = w.owner.get(inv("/" + draftId)).json().path("version").asLong();
        assertThat(issue(w.owner, draftId, current).status()).isEqualTo(200);
        assertThatThrownBy(() -> jdbc.update("update invoices set branch_id = ? where id = ?", w.inactiveBranchId, draftId))
                .hasMessageContaining("branch and the assigned cashier of an issued invoice are fixed");
        assertThatThrownBy(() -> jdbc.update("update invoices set assigned_to_user_id = ? where id = ?", w.cashierPerson.userId(), draftId))
                .hasMessageContaining("branch and the assigned cashier of an issued invoice are fixed");
        assertThatThrownBy(() -> jdbc.update("update invoices set created_by_user_id = ? where id = ?", w.managerPerson.userId(), draftId))
                .hasMessageContaining("creator of an invoice never changes");

        // The ordinary lifecycle still works and leaves the attribution exactly as it was.
        long issued = w.owner.get(inv("/" + draftId)).json().path("version").asLong();
        assertThat(w.owner.post(inv("/" + draftId + "/void?expectedVersion=" + issued), Map.of("reason", "Entered in error")).status()).isEqualTo(200);
        var row = jdbc.queryForMap("select created_by_user_id, assigned_to_user_id, branch_id from invoices where id = ?", draftId);
        assertThat(row.get("created_by_user_id")).isEqualTo(w.cashierPerson.userId());
        assertThat(row.get("assigned_to_user_id")).isEqualTo(w.otherCashierPerson.userId());
        assertThat(row.get("branch_id")).isEqualTo(w.branchId);
    }

    // ---- payment requests ----------------------------------------------------------------------

    @Test
    void existingCallersKeepTheSevenDayLifetimeAndNowRecordTheirProvenance() {
        ensureProfile();
        UUID invoiceId = w.issuedInvoice(15_000);   // branch RM01, assigned to Aline

        var created = requestFor(w.cashier, invoiceId);
        assertThat(created.status()).isEqualTo(200);

        var row = jdbc.queryForMap("select source, branch_id, created_by_user_id, "
                + "cast(extract(epoch from (expires_at - created_at)) as bigint) as lifetime_seconds "
                + "from payment_requests where invoice_id = ?", invoiceId);
        assertThat(row.get("lifetime_seconds")).isEqualTo(Duration.ofDays(7).toSeconds());
        assertThat(row.get("source")).isEqualTo("INVOICE");
        assertThat(row.get("branch_id")).isEqualTo(w.branchId);
        assertThat(row.get("created_by_user_id")).isEqualTo(w.cashierPerson.userId());
        // The reference is generated exactly as before.
        assertThat(created.json().path("publicReference").asString()).matches("^OP-[2-9A-HJKMNP-Z]{12}$");
    }

    @Test
    void aTrustedCallerCanOpenAShorterRequestForAPosInvoice() {
        ensureProfile();
        var draft = trustedCreate(w.owner, w.merchantId, "POS", UUID.randomUUID(), draftForCashier());
        UUID invoiceId = uuid(draft);
        assertThat(issue(w.owner, invoiceId, draft.json().path("version").asLong()).status()).isEqualTo(200);

        var request = w.owner.post(trusted(w.merchantId, "/invoices/" + invoiceId + "/payment-requests?minutes=15"), null);

        assertThat(request.status()).as(request.body()).isEqualTo(200);
        var row = jdbc.queryForMap("select source, branch_id, created_by_user_id, "
                + "cast(extract(epoch from (expires_at - created_at)) as bigint) as lifetime_seconds "
                + "from payment_requests where invoice_id = ?", invoiceId);
        assertThat(row.get("lifetime_seconds")).isEqualTo(Duration.ofMinutes(15).toSeconds());
        assertThat(row.get("source")).isEqualTo("POS");
        assertThat(row.get("branch_id")).isEqualTo(w.branchId);
        assertThat(row.get("created_by_user_id")).isEqualTo(w.ownerPerson.userId());
        assertThat(request.json().path("publicReference").asString()).matches("^OP-[2-9A-HJKMNP-Z]{12}$");
    }

    @Test
    void theCreatorIsTheMemberWhoCreatedTheRequestAndAccessRulesAreUnchanged() {
        ensureProfile();
        UUID invoiceId = w.issuedInvoice(9_000);   // created by the owner, assigned to Aline

        assertThat(requestFor(w.manager, invoiceId).status()).isEqualTo(200);
        assertThat(jdbc.queryForObject("select created_by_user_id from payment_requests where invoice_id = ?", UUID.class, invoiceId))
                .isEqualTo(w.managerPerson.userId());
        // Existing authorisation: another cashier or another business sees nothing.
        assertThat(requestFor(w.otherCashier, invoiceId).status()).isEqualTo(404);
        assertThat(requestFor(w.cafeOwner, invoiceId).status()).isEqualTo(404);
    }

    @Test
    void anExpiredRequestStillReconcilesAConfirmedBankPayment() {
        ensureProfile();
        var draft = trustedCreate(w.owner, w.merchantId, "POS", UUID.randomUUID(), draftForCashier());
        UUID invoiceId = uuid(draft);
        issue(w.owner, invoiceId, draft.json().path("version").asLong());
        var request = w.owner.post(trusted(w.merchantId, "/invoices/" + invoiceId + "/payment-requests?minutes=1"), null).json();

        // The request's own clock runs out before the customer's money arrives.
        jdbc.update("update payment_requests set expires_at = now() - interval '1 hour' where invoice_id = ?", invoiceId);
        assertThat(w.owner.get(inv("/" + invoiceId + "/payment-requests")).json().get(0).path("status").asString()).isEqualTo("EXPIRED");

        // Expiry is "no longer collecting", never proof that nothing was paid: the verified bank payment is still applied.
        var paid = w.bank.pay("POSTED", 20_000, request.path("publicReference").asString());
        assertThat(paid.outcome()).isEqualTo("APPLIED");
        assertThat(w.owner.get(inv("/" + invoiceId)).json().path("paymentStatus").asString()).isEqualTo("PAID");
        assertThat(jdbc.queryForObject("select count(*) from payment_allocations where invoice_id = ? and status = 'ACTIVE'", Integer.class, invoiceId)).isEqualTo(1);
    }

    @Test
    void publicOpenRequestsKeepTheirThirtyMinutesAndCannotChooseALifetime() {
        String token = ensureProfile();
        var open = TestApi.anonymous(mvc, HttpMethod.POST, "/api/v1/public/payment-profiles/" + token + "/requests",
                Map.of("amount", 500, "lifetimeMinutes", 99_999, "expiresAt", "2099-01-01T00:00:00Z"), Map.of());

        assertThat(open.status()).isEqualTo(201);
        var row = jdbc.queryForMap("select source, branch_id, created_by_user_id, "
                + "cast(extract(epoch from (expires_at - created_at)) as bigint) as lifetime_seconds "
                + "from payment_requests where invoice_id is null");
        assertThat(row.get("lifetime_seconds")).isEqualTo(Duration.ofMinutes(30).toSeconds());
        // Anonymous collections carry no creator; they read as OPEN.
        assertThat(row.get("created_by_user_id")).isNull();
    }

    @Test
    void paymentRequestProvenanceCannotChangeButTheRequestStillWorksNormally() {
        ensureProfile();
        UUID invoiceId = w.issuedInvoice(6_000);
        var request = requestFor(w.owner, invoiceId).json();
        UUID requestId = UUID.fromString(request.path("id").asString());

        assertThatThrownBy(() -> jdbc.update("update payment_requests set source = 'POS' where id = ?", requestId))
                .hasMessageContaining("fixed when the request is created");
        assertThatThrownBy(() -> jdbc.update("update payment_requests set branch_id = null where id = ?", requestId))
                .hasMessageContaining("fixed when the request is created");
        assertThatThrownBy(() -> jdbc.update("update payment_requests set created_by_user_id = ? where id = ?", w.managerPerson.userId(), requestId))
                .hasMessageContaining("fixed when the request is created");

        // A request that predates provenance cannot be given any afterwards either.
        withoutGuard("payment_requests", GUARD_REQUESTS, () -> jdbc.update(
                "update payment_requests set source = null, branch_id = null, created_by_user_id = null where id = ?", requestId));
        assertThatThrownBy(() -> jdbc.update("update payment_requests set source = 'INVOICE' where id = ?", requestId))
                .hasMessageContaining("fixed when the request is created");
        assertThatThrownBy(() -> jdbc.update("update payment_requests set source = 'INVOICE', branch_id = ?, created_by_user_id = ? where id = ?",
                w.branchId, w.ownerPerson.userId(), requestId)).hasMessageContaining("fixed when the request is created");

        // Ordinary updates (cancelling) are untouched by the guard.
        var cancelled = w.owner.post("/api/v1/merchants/" + w.merchantId + "/payment-requests/" + requestId + "/cancel", null);
        assertThat(cancelled.status()).isEqualTo(200);
        assertThat(cancelled.json().path("status").asString()).isEqualTo("CANCELLED");
        assertThat(jdbc.queryForObject("select source from payment_requests where id = ?", String.class, requestId)).isNull();
    }

    @Test
    void aTrustedLifetimeNeverOverwritesAnExistingRequestAndAConflictIsReportedClearly() {
        ensureProfile();
        UUID invoiceId = w.issuedInvoice(14_000);
        var traditional = requestFor(w.owner, invoiceId).json();
        UUID traditionalId = UUID.fromString(traditional.path("id").asString());
        Object expiryBefore = jdbc.queryForObject("select expires_at from payment_requests where id = ?", java.sql.Timestamp.class, traditionalId);

        // A checkout asking for 15 minutes while a seven-day request is open: a clear conflict, and nothing is changed.
        var conflict = w.owner.post(trusted(w.merchantId, "/invoices/" + invoiceId + "/payment-requests?minutes=15"), null);
        assertThat(conflict.status()).isEqualTo(409);
        assertThat(conflict.code()).isEqualTo("payment_request_lifetime_conflict");
        assertThat(jdbc.queryForObject("select count(*) from payment_requests where invoice_id = ?", Integer.class, invoiceId)).isEqualTo(1);
        assertThat(jdbc.queryForObject("select cancelled_at is null from payment_requests where id = ?", Boolean.class, traditionalId)).isTrue();
        assertThat(jdbc.queryForObject("select expires_at from payment_requests where id = ?", java.sql.Timestamp.class, traditionalId)).isEqualTo(expiryBefore);

        // Asking for exactly what exists is a harmless retry, and the merchant API keeps returning the live request.
        var sameLifetime = w.owner.post(trusted(w.merchantId, "/invoices/" + invoiceId + "/payment-requests?minutes=10080"), null);
        assertThat(sameLifetime.status()).isEqualTo(200);
        assertThat(sameLifetime.json().path("id").asString()).isEqualTo(traditionalId.toString());
        assertThat(requestFor(w.owner, invoiceId).json().path("id").asString()).isEqualTo(traditionalId.toString());

        // Replacement is a deliberate, separate act: cancel the existing request, then ask again.
        var cancelled = w.owner.post("/api/v1/merchants/" + w.merchantId + "/payment-requests/" + traditionalId + "/cancel", null);
        assertThat(cancelled.json().path("status").asString()).isEqualTo("CANCELLED");
        var shortRequest = w.owner.post(trusted(w.merchantId, "/invoices/" + invoiceId + "/payment-requests?minutes=15"), null);
        assertThat(shortRequest.status()).isEqualTo(200);
        UUID shortId = UUID.fromString(shortRequest.json().path("id").asString());
        assertThat(shortId).isNotEqualTo(traditionalId);
        assertThat(jdbc.queryForObject("select cast(extract(epoch from (expires_at - created_at)) as bigint) from payment_requests where id = ?",
                Long.class, shortId)).isEqualTo(Duration.ofMinutes(15).toSeconds());
        assertThat(jdbc.queryForObject("select cancelled_at is not null from payment_requests where id = ?", Boolean.class, traditionalId)).isTrue();

        // Now the short request is the live one: a retry returns it, the merchant API returns it unchanged, another lifetime conflicts.
        assertThat(w.owner.post(trusted(w.merchantId, "/invoices/" + invoiceId + "/payment-requests?minutes=15"), null).json().path("id").asString())
                .isEqualTo(shortId.toString());
        assertThat(requestFor(w.owner, invoiceId).json().path("id").asString()).isEqualTo(shortId.toString());
        assertThat(w.owner.post(trusted(w.merchantId, "/invoices/" + invoiceId + "/payment-requests?minutes=30"), null).code())
                .isEqualTo("payment_request_lifetime_conflict");
    }

    @Test
    void anOlderApplicationInstanceCanStillWriteAndReadAgainstTheNewSchema() {
        ensureProfile();
        UUID template = w.issuedInvoice(11_000);
        UUID templateRequest = UUID.fromString(requestFor(w.owner, template).json().path("id").asString());

        // 1) Legacy invoice creation: exactly the columns the previous version wrote, with no provenance at all.
        UUID legacy = UUID.randomUUID();
        jdbc.update("insert into invoices (id, merchant_id, invoice_number, status, branch_id, created_by_user_id, assigned_to_user_id, "
                + "created_by_name, assigned_to_name, customer_name, merchant_snapshot, branch_snapshot, currency, tax_mode, subtotal_rwf, "
                + "discount_total_rwf, tax_total_rwf, grand_total_rwf, due_on, created_at, updated_at, version) "
                + "select cast(? as uuid), merchant_id, 'INV-9001', 'DRAFT', branch_id, created_by_user_id, assigned_to_user_id, created_by_name, "
                + "assigned_to_name, customer_name, merchant_snapshot, branch_snapshot, currency, tax_mode, subtotal_rwf, discount_total_rwf, "
                + "tax_total_rwf, grand_total_rwf, due_on, created_at, updated_at, 1 from invoices where id = ?", legacy, template);
        jdbc.update("insert into invoice_items (id, invoice_id, line_no, description, quantity_milli, unit_price_rwf, discount_rwf, tax_category, "
                + "tax_rate_bp, net_amount_rwf, tax_amount_rwf, line_total_rwf) select gen_random_uuid(), cast(? as uuid), line_no, description, "
                + "quantity_milli, unit_price_rwf, discount_rwf, tax_category, tax_rate_bp, net_amount_rwf, tax_amount_rwf, line_total_rwf "
                + "from invoice_items where invoice_id = ?", legacy, template);
        assertThat(channelInDb(legacy)).isNull();
        assertThat(jdbc.queryForObject("select client_request_sha256 from invoices where id = ?", String.class, legacy)).isNull();

        // 2) Reading it, and the new version working on top of it (editing, issuing), all with the historical fallback.
        var read = w.owner.get(inv("/" + legacy));
        assertThat(read.status()).isEqualTo(200);
        assertThat(read.json().path("saleChannel").asString()).isEqualTo("INVOICE");
        assertThat(issue(w.owner, legacy, read.json().path("version").asLong()).status()).isEqualTo(200);
        assertThat(channelInDb(legacy)).isNull();

        // 3) Legacy payment-request insertion with NULL provenance, for an invoice that predates provenance.
        jdbc.update("insert into payment_requests (id, merchant_id, payment_profile_id, invoice_id, requested_amount_rwf, currency, "
                + "public_reference, expires_at, created_at, updated_at) select gen_random_uuid(), merchant_id, payment_profile_id, cast(? as uuid), "
                + "11000, currency, 'OP-AAAAAAAAAAD2', expires_at, created_at, updated_at from payment_requests where id = ?", legacy, templateRequest);
        assertThat(w.owner.get(inv("/" + legacy + "/payment-requests")).json().size()).isEqualTo(1);
        // ...which a verified bank payment settles exactly as before.
        assertThat(w.bank.pay("POSTED", 11_000, "OP-AAAAAAAAAAD2").outcome()).isEqualTo("APPLIED");
        assertThat(w.owner.get(inv("/" + legacy)).json().path("paymentStatus").asString()).isEqualTo("PAID");

        // 4) New manual invoices are created normally beside the legacy ones.
        var manual = w.owner.post(inv(""), draftForCashier());
        assertThat(manual.status()).isEqualTo(201);
        assertThat(manual.json().path("saleChannel").asString()).isEqualTo("INVOICE");

        // 5) Isolation holds for rows written either way: another business sees neither.
        assertThat(w.cafeOwner.get(inv("/" + legacy)).status()).isEqualTo(404);
        assertThat(w.cafeOwner.get(inv("/" + legacy + "/payment-requests")).status()).isEqualTo(404);
        assertThat(w.cafeOwner.get("/api/v1/merchants/" + w.cafeMerchantId + "/invoices").json().path("items").size()).isZero();

        // By design, an older instance cannot open a request for a POS invoice (it records no source): the checkout flows
        // only exist in versions that record provenance, so this can only matter after those flows have shipped.
        var posDraft = trustedCreate(w.owner, w.merchantId, "POS", UUID.randomUUID(), draftForCashier());
        issue(w.owner, uuid(posDraft), posDraft.json().path("version").asLong());
        assertThatThrownBy(() -> insertRequestLike(templateRequest, uuid(posDraft), "OP-AAAAAAAAAAD3", null, null, null))
                .hasStackTraceContaining("must record its source");
    }

    /** Runs all tasks at (nearly) the same instant and returns their results. */
    private <T> List<T> concurrently(List<Callable<T>> tasks) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(tasks.size());
        try {
            CountDownLatch ready = new CountDownLatch(tasks.size());
            CountDownLatch go = new CountDownLatch(1);
            List<Future<T>> futures = new ArrayList<>();
            for (Callable<T> task : tasks) {
                futures.add(pool.submit(() -> {
                    ready.countDown();
                    go.await();
                    return task.call();
                }));
            }
            ready.await();
            go.countDown();
            List<T> results = new ArrayList<>();
            for (Future<T> future : futures) {
                results.add(future.get(60, TimeUnit.SECONDS));
            }
            return results;
        } finally {
            pool.shutdownNow();
        }
    }
}
