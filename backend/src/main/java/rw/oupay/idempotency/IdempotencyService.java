package rw.oupay.idempotency;

import java.sql.Timestamp;
import java.time.Clock;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Function;
import java.util.function.Supplier;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionSynchronizationManager;
import org.springframework.transaction.support.TransactionTemplate;
import rw.oupay.common.ApiException;
import rw.oupay.membership.Actor;
import rw.oupay.membership.MerchantAccess;
import tools.jackson.databind.json.JsonMapper;

/**
 * HTTP idempotency: a client that repeats a request with the same {@code Idempotency-Key} (because a response was lost,
 * or the first attempt was still running) gets the original outcome back, and the operation is never performed twice.
 *
 * <p><b>This is a replay cache, not the safety net.</b> Records are pruned after 30 days (see {@code Housekeeping}), and
 * a request with a pruned key simply runs as a new request. Whatever must NEVER happen twice (a payment applied, stock
 * deducted) is guarded permanently by a uniqueness constraint on the business rows themselves; see docs/idempotency.md.
 *
 * <h2>Transaction boundary (explicit, not annotation-driven)</h2>
 * {@link #executeOnce} opens its own transaction with a {@link TransactionTemplate}, and everything below happens inside
 * it, in this order:
 * <ol>
 *   <li>the caller must be an active member of the business (nothing is written for anyone else);</li>
 *   <li>the key is claimed by inserting its record ({@code ON CONFLICT DO NOTHING});</li>
 *   <li>if the claim succeeded, the business action runs and the record is completed with the result's identity;</li>
 *   <li>otherwise the existing record is checked (same actor, same request) and the result is rebuilt from it.</li>
 * </ol>
 * The record and the business change are therefore ONE commit: a failure anywhere rolls both back, nothing is ever
 * marked complete before the business transaction commits, and a committed record always belongs to a committed
 * operation (a deferred database trigger enforces that a record cannot commit without its result).
 *
 * <p>Concurrent identical requests: the second insert waits on the primary-key index until the first transaction ends.
 * If the first commits, the second finds the record and replays; if it rolls back, the second claims the key and runs.
 * Exactly one execution can ever commit. (If the wait exceeds {@code lock_timeout} the caller receives a retryable 503;
 * the retry then replays safely.)
 *
 * <h2>No nested use</h2>
 * {@link #executeOnce} REFUSES to run inside an existing transaction (it throws {@link IllegalStateException}). If it joined
 * an outer transaction it would hand back its outcome before anything is committed, and the outer transaction could still
 * roll back both the claim and the business change, so the caller could mistake an uncommitted result for a durable one.
 * Call it from the outermost layer (a controller or an application service that is not itself transactional). The same
 * rule lets a {@link rw.oupay.common.TransactionRetry} wrap it safely: every attempt is then a complete, fresh transaction.
 *
 * <h2>Replay is authorised, never raw</h2>
 * The stored record holds only the identity of the result. The caller supplies a {@code replay} function that must
 * re-check the caller's permission and rebuild the response from the live entity. Possessing a key never reveals data:
 * a caller who lost access, or whose entity is gone, gets the ordinary 404/403 of that resource.
 */
@Service
public class IdempotencyService {

    /** The request header carrying the key. */
    public static final String HEADER = "Idempotency-Key";

    private static final Pattern KEY = Pattern.compile("^[A-Za-z0-9._~-]{8,80}$");
    private static final Pattern SCOPE = Pattern.compile("^[A-Z][A-Z0-9_]{1,39}$");
    private static final Pattern ENTITY_TYPE = Pattern.compile("^[a-z][a-z0-9_]{1,39}$");
    private static final Pattern FINGERPRINT = Pattern.compile("^[0-9a-f]{64}$");

    /** What the business action returns: the response, and the identity that lets a replay rebuild it. */
    public record Created<T>(T response, String entityType, UUID entityId) {}

    /** What a replay is given to rebuild the response from. */
    public record StoredResult(String entityType, UUID entityId) {}

    /** The response, and whether it came from an earlier execution. */
    public record Outcome<T>(T response, boolean replayed) {}

    private record StoredRecord(UUID actorUserId, String requestSha256, String resultEntityType, UUID resultEntityId) {}

    private final JdbcClient jdbc;
    private final TransactionTemplate transaction;
    private final MerchantAccess access;
    private final JsonMapper json;
    private final Clock clock;

    public IdempotencyService(JdbcClient jdbc, PlatformTransactionManager transactionManager, MerchantAccess access,
                              JsonMapper json, Clock clock) {
        this.jdbc = jdbc;
        this.transaction = new TransactionTemplate(transactionManager);
        this.access = access;
        this.json = json;
        this.clock = clock;
    }

    /**
     * Fingerprint of a request: the operation name, its route parameters (merchant and resource ids) and its body,
     * in a canonical form that ignores field order and number formatting. {@code body} may be any serialisable object.
     */
    public String fingerprintOf(String operation, Map<String, ?> routeParameters, Object body) {
        Object plain = body == null ? null : json.readValue(json.writeValueAsString(body), Object.class);
        return RequestFingerprint.of(operation, routeParameters, plain);
    }

    /**
     * Performs {@code action} at most once for this (business, scope, key).
     *
     * @param scope       the kind of operation, upper-case with underscores, for example {@code POS_BILL}
     * @param key         the client's {@code Idempotency-Key}
     * @param fingerprint {@link #fingerprintOf} of this request
     * @param action      the business operation. It runs inside the transaction and must do its own permission check.
     * @param replay      rebuilds the response from a stored result. It runs inside the transaction and must re-check
     *                    the caller's permission and fail with the resource's normal error if it is gone.
     */
    public <T> Outcome<T> executeOnce(UUID merchantId, String scope, String key, String fingerprint,
                                      Supplier<Created<T>> action, Function<StoredResult, T> replay) {
        if (TransactionSynchronizationManager.isActualTransactionActive()) {
            throw new IllegalStateException("executeOnce must be called outside a transaction: it owns the transaction, "
                    + "so a returned outcome always means the operation has been committed.");
        }
        validate(scope, key, fingerprint);
        Outcome<T> outcome = transaction.execute(status -> inTransaction(merchantId, scope, key, fingerprint, action, replay));
        return Objects.requireNonNull(outcome);
    }

    private <T> Outcome<T> inTransaction(UUID merchantId, String scope, String key, String fingerprint,
                                         Supplier<Created<T>> action, Function<StoredResult, T> replay) {
        // Before anything is written: a stranger can neither fill the table nor probe whether a business exists.
        Actor actor = access.requireMember(merchantId);
        // Twice at most: the second pass only happens if the existing record was pruned between our failed claim and our read.
        for (int pass = 0; pass < 2; pass++) {
            if (claim(merchantId, scope, key, actor.userId(), fingerprint)) {
                return new Outcome<>(runAndComplete(merchantId, scope, key, action), false);
            }
            Optional<StoredRecord> existing = find(merchantId, scope, key);
            if (existing.isPresent()) {
                return new Outcome<>(replayFrom(existing.get(), actor, fingerprint, replay), true);
            }
        }
        throw ApiException.conflict("request_in_progress", "This request is still being processed. Please try again in a moment.");
    }

    private <T> T runAndComplete(UUID merchantId, String scope, String key, Supplier<Created<T>> action) {
        Created<T> created = Objects.requireNonNull(action.get(), "the action must return its result");
        if (created.entityId() == null || created.entityType() == null || !ENTITY_TYPE.matcher(created.entityType()).matches()) {
            throw new IllegalStateException("An idempotent action must identify the entity it produced.");
        }
        int completed = jdbc.sql("update idempotency_keys set result_entity_type = :type, result_entity_id = :id "
                        + "where merchant_id = :m and scope = :s and idem_key = :k")
                .param("type", created.entityType()).param("id", created.entityId())
                .param("m", merchantId).param("s", scope).param("k", key).update();
        if (completed != 1) {
            throw new IllegalStateException("The idempotency record could not be completed.");
        }
        return created.response();
    }

    private <T> T replayFrom(StoredRecord record, Actor actor, String fingerprint, Function<StoredResult, T> replay) {
        if (!record.actorUserId().equals(actor.userId()) || !record.requestSha256().equals(fingerprint)) {
            throw ApiException.conflict("idempotency_key_reuse",
                    "This Idempotency-Key was already used for a different request. Use a new key for a new request.");
        }
        if (record.resultEntityId() == null) {
            // Cannot happen for a committed record (the database refuses it); never guess a result.
            throw ApiException.conflict("request_in_progress", "This request is still being processed. Please try again in a moment.");
        }
        return replay.apply(new StoredResult(record.resultEntityType(), record.resultEntityId()));
    }

    private boolean claim(UUID merchantId, String scope, String key, UUID actorUserId, String fingerprint) {
        return jdbc.sql("insert into idempotency_keys (merchant_id, scope, idem_key, actor_user_id, request_sha256, created_at) "
                        + "values (:m, :s, :k, :a, :h, :now) on conflict (merchant_id, scope, idem_key) do nothing")
                .param("m", merchantId).param("s", scope).param("k", key).param("a", actorUserId).param("h", fingerprint)
                .param("now", Timestamp.from(clock.instant())).update() == 1;
    }

    private Optional<StoredRecord> find(UUID merchantId, String scope, String key) {
        return jdbc.sql("select actor_user_id, request_sha256, result_entity_type, result_entity_id from idempotency_keys "
                        + "where merchant_id = :m and scope = :s and idem_key = :k")
                .param("m", merchantId).param("s", scope).param("k", key)
                .query((rs, row) -> new StoredRecord(rs.getObject("actor_user_id", UUID.class), rs.getString("request_sha256"),
                        rs.getString("result_entity_type"), rs.getObject("result_entity_id", UUID.class)))
                .optional();
    }

    private static void validate(String scope, String key, String fingerprint) {
        if (scope == null || !SCOPE.matcher(scope).matches()) {
            throw new IllegalArgumentException("The idempotency scope must be upper-case words joined by underscores.");
        }
        if (key == null || key.isBlank()) {
            throw ApiException.validation("An " + HEADER + " header is required for this request.");
        }
        if (!KEY.matcher(key).matches()) {
            throw ApiException.validation("The " + HEADER + " must be 8 to 80 characters: letters, digits, '.', '_', '~' or '-'.");
        }
        if (fingerprint == null || !FINGERPRINT.matcher(fingerprint).matches()) {
            throw new IllegalArgumentException("The request fingerprint must be a lower-case SHA-256 hex digest.");
        }
    }
}
