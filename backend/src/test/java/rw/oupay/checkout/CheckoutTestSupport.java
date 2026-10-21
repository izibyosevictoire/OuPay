package rw.oupay.checkout;

import static org.assertj.core.api.Assertions.assertThat;

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
import org.springframework.http.HttpMethod;
import rw.oupay.support.IntegrationTest;
import rw.oupay.support.TestApi;
import rw.oupay.support.World;

/** Shared set-up for the R4 integration tests: the sample world with the shop switched to SIMPLIFIED mode. */
abstract class CheckoutTestSupport extends IntegrationTest {

    World w;

    /** Runs before the world is built (a test that controls the clock sets it here, so every record is created in its time). */
    void beforeWorld() {}

    @BeforeEach
    void simplifiedWorld() {
        beforeWorld();
        w = World.create(this);
        setMode(w.merchantId, "SIMPLIFIED");
    }

    void setMode(UUID merchantId, String mode) {
        jdbc.update("insert into merchant_settings (merchant_id, operating_mode, updated_at, version) values (?, ?, now(), 0) "
                + "on conflict (merchant_id) do update set operating_mode = excluded.operating_mode", merchantId, mode);
    }

    String base() {
        return "/api/v1/merchants/" + w.merchantId + "/checkout/simple";
    }

    Map<String, Object> sale(Object amount, String description, UUID clientRequestId) {
        Map<String, Object> body = new HashMap<>();
        body.put("amountRwf", amount);
        if (description != null) {
            body.put("description", description);
        }
        body.put("clientRequestId", clientRequestId.toString());
        return body;
    }

    TestApi.Response bill(TestApi api, String key, Map<String, Object> body) {
        return api.send(HttpMethod.POST, base(), body, Map.of("Idempotency-Key", key));
    }

    TestApi.Response bill(TestApi api, Object amount) {
        return bill(api, "key-" + UUID.randomUUID(), sale(amount, null, UUID.randomUUID()));
    }

    /** Creates an active business-wide payment link on the linked bank account; returns its id. */
    UUID ensureProfile() {
        UUID destination = jdbc.queryForObject("select id from payment_destinations where merchant_id = ?", UUID.class, w.merchantId);
        var created = w.owner.post("/api/v1/merchants/" + w.merchantId + "/payment-profiles",
                Map.of("label", "Counter", "paymentDestinationId", destination.toString()));
        assertThat(created.status()).as(created.body()).isEqualTo(201);
        return UUID.fromString(created.json().path("id").asString());
    }

    int count(String table) {
        return jdbc.queryForObject("select count(*) from " + table, Integer.class);
    }

    TestApi.Response invoice(UUID invoiceId) {
        return w.owner.get("/api/v1/merchants/" + w.merchantId + "/invoices/" + invoiceId);
    }

    <T> List<T> concurrently(List<Callable<T>> tasks) throws Exception {
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
