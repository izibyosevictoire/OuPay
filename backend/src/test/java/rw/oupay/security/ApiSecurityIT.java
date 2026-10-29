package rw.oupay.security;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import java.util.UUID;
import java.util.stream.Collectors;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;
import rw.oupay.support.World;

/**
 * Whole-API security checks driven by the live route table, so a NEW endpoint is covered the moment
 * it exists: it cannot be anonymous by accident, and it cannot leak across businesses.
 */
class ApiSecurityIT extends IntegrationTest {

    @Autowired
    @org.springframework.beans.factory.annotation.Qualifier("requestMappingHandlerMapping")
    RequestMappingHandlerMapping mappings;

    World w;

    @BeforeEach
    void world() {
        w = World.create(this);
    }

    record Route(HttpMethod method, String pattern) {}

    private List<Route> routes() {
        List<Route> routes = new ArrayList<>();
        for (RequestMappingInfo info : mappings.getHandlerMethods().keySet()) {
            Set<String> patterns = info.getPathPatternsCondition() == null ? Set.of()
                    : info.getPathPatternsCondition().getPatternValues();
            for (String pattern : patterns) {
                if (!pattern.startsWith("/api/v1/")) continue;
                for (var method : info.getMethodsCondition().getMethods()) {
                    routes.add(new Route(HttpMethod.valueOf(method.name()), pattern));
                }
            }
        }
        return routes;
    }

    private static final Set<String> ANONYMOUS_BY_DESIGN_PREFIXES = Set.of("/api/v1/public/", "/api/v1/integrations/");
    private static final Set<String> ANONYMOUS_BY_DESIGN_EXACT = Set.of("/api/v1/auth/login", "/api/v1/auth/register", "/api/v1/auth/session",
            "/api/v1/auth/password-reset/request", "/api/v1/auth/password-reset/verify", "/api/v1/auth/password-reset/confirm",
            "/api/v1/auth/email-verification/confirm", "/api/v1/dev/mail");

    private static boolean anonymousByDesign(Route route) {
        return ANONYMOUS_BY_DESIGN_EXACT.contains(route.pattern())
                || ANONYMOUS_BY_DESIGN_PREFIXES.stream().anyMatch(route.pattern()::startsWith);
    }

    private static String fill(String pattern, UUID merchantId) {
        String filled = pattern.replace("{merchantId}", merchantId.toString());
        return filled.replaceAll("\\{[^}/]+}", UUID.randomUUID().toString());
    }

    @Test
    void theRouteTableIsWhatWeThinkItIs() {
        List<Route> all = routes();
        assertThat(all.size()).isGreaterThan(50);
        Set<String> anonymous = all.stream().filter(ApiSecurityIT::anonymousByDesign).map(r -> r.method() + " " + r.pattern())
                .collect(Collectors.toCollection(TreeSet::new));
        // The ENTIRE anonymous surface, spelled out. Adding anything here must be a conscious decision.
        assertThat(anonymous).containsExactlyInAnyOrder(
                "GET /api/v1/auth/session", "POST /api/v1/auth/login", "POST /api/v1/auth/register",
                "POST /api/v1/auth/password-reset/request", "POST /api/v1/auth/password-reset/verify", "POST /api/v1/auth/password-reset/confirm",
                "POST /api/v1/auth/email-verification/confirm", "GET /api/v1/dev/mail",
                "GET /api/v1/public/payment-profiles/{token}", "POST /api/v1/public/payment-profiles/{token}/requests",
                "GET /api/v1/public/payment-profiles/{token}/requests/{reference}",
                "POST /api/v1/public/payment-profiles/{token}/requests/{reference}/instructions-opened",
                "POST /api/v1/public/payment-profiles/{token}/requests/{reference}/claim",
                "GET /api/v1/public/invitations/{token}", "GET /api/v1/public/code-sales/{reference}", "POST /api/v1/integrations/{provider}/events");
    }

    @Test
    void everyOtherEndpointRejectsAnonymousCallers() {
        for (Route route : routes()) {
            if (anonymousByDesign(route)) continue;
            var response = TestApi.anonymous(mvc, route.method(), fill(route.pattern(), w.merchantId),
                    route.method() == HttpMethod.GET ? null : Map.of(), Map.of());
            assertThat(response.status()).as(route.method() + " " + route.pattern()).isIn(401, 403);
            assertThat(response.status()).as("never succeeds or fails open").isNotIn(200, 201, 204, 500);
        }
    }

    @Test
    void noMerchantEndpointEverAnswersAnotherBusinessesMember() {
        for (Route route : routes()) {
            if (!route.pattern().contains("{merchantId}")) continue;
            String url = fill(route.pattern(), w.merchantId);
            TestApi.Response response = switch (route.method().name()) {
                case "GET" -> w.cafeOwner.get(url);
                case "DELETE" -> w.cafeOwner.delete(url);
                case "PUT" -> w.cafeOwner.put(url, Map.of());
                default -> w.cafeOwner.post(url, Map.of());
            };
            String label = route.method() + " " + route.pattern() + " -> " + response.status();
            assertThat(response.status()).as(label).isNotIn(200, 201, 204, 500);
            if (route.method() == HttpMethod.GET) {
                // A non-member gets exactly the answer a non-existent business would get.
                assertThat(response.status()).as(label).isEqualTo(404);
            }
        }
    }

    @Test
    void cashiersAreRefusedEveryManagementReadWithForbidden() {
        String base = "/api/v1/merchants/" + w.merchantId;
        for (String path : List.of("/staff", "/branches", "/bank-connections", "/payment-destinations", "/payable-invoices",
                "/payment-profiles/form-options", "/branch-assignments")) {
            assertThat(w.cashier.get(base + path).status()).as(path).isEqualTo(403);
        }
    }

    @Test
    void malformedInputIsABadRequestNeverAServerErrorOrALeak() {
        assertThat(w.owner.get("/api/v1/merchants/not-a-uuid").status()).isEqualTo(400);
        assertThat(w.owner.get("/api/v1/merchants/" + w.merchantId + "/invoices/not-a-uuid").status()).isEqualTo(400);
        assertThat(w.owner.post("/api/v1/merchants", "{broken").status()).isEqualTo(400);
        assertThat(w.owner.post("/api/v1/merchants", Map.of()).status()).isEqualTo(422);
        var unknown = w.owner.get("/api/v1/does/not/exist");
        assertThat(unknown.status()).isIn(404, 401);
        for (var response : List.of(w.owner.get("/api/v1/merchants/not-a-uuid"), unknown, w.owner.post("/api/v1/merchants", Map.of()))) {
            assertThat(response.body()).doesNotContain("Exception").doesNotContain("at rw.oupay").doesNotContain("org.postgresql")
                    .doesNotContain("SELECT").doesNotContain("hibernate");
        }
    }

    @Test
    void sessionsAreIndependentPerLoginAndLogoutOnlyEndsTheOneUsed() {
        var first = w.owner;
        var second = new TestApi(mvc);
        second.post("/api/v1/auth/login", Map.of("email", w.ownerPerson.email(), "password", rw.oupay.support.Fixtures.PASSWORD));
        assertThat(second.cookie("oupay_session")).isNotEqualTo(first.cookie("oupay_session"));
        assertThat(second.post("/api/v1/auth/logout", null).status()).isEqualTo(204);
        assertThat(second.get("/api/v1/merchants").status()).isEqualTo(401);
        assertThat(first.get("/api/v1/merchants").status()).isEqualTo(200);
    }

    @Test
    void operationalEndpointsDoNotExposeInternals() {
        var health = TestApi.anonymous(mvc, HttpMethod.GET, "/actuator/health", null, Map.of());
        assertThat(health.status()).isEqualTo(200);
        assertThat(health.body()).doesNotContain("jdbc").doesNotContain("password");
        for (String path : List.of("/actuator/env", "/actuator/beans", "/actuator/heapdump", "/actuator/configprops", "/actuator/mappings")) {
            assertThat(TestApi.anonymous(mvc, HttpMethod.GET, path, null, Map.of()).status()).as(path).isIn(401, 403, 404);
        }
    }

    @Test
    void theOpenApiDocumentDescribesTheApi() {
        var docs = TestApi.anonymous(mvc, HttpMethod.GET, "/v3/api-docs", null, Map.of());
        assertThat(docs.status()).isEqualTo(200);
        assertThat(docs.body()).contains("/api/v1/merchants").contains("/api/v1/integrations/{provider}/events");
    }
}
