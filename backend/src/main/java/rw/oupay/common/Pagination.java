package rw.oupay.common;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.List;
import java.util.UUID;
import java.util.function.Function;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Pageable;

/**
 * Deterministic keyset ("seek") pagination for the high-volume lists.
 *
 * <p>Every list has a TOTAL order: a sort column plus the row id as tie-breaker, so two rows never
 * compare equal and no row is skipped or repeated between pages, even when many rows share a timestamp.
 * A page is "the next N rows strictly after the cursor", which stays correct and fast (it uses the
 * {@code (sort, id)} index) when rows are inserted while someone is paging, unlike OFFSET. The cursor is
 * opaque to clients; a malformed one is a 400, never a server error.
 */
public final class Pagination {

    public static final int DEFAULT_LIMIT = 50;
    public static final int MAX_LIMIT = 200;

    /** Sorts after every real row, so "after START" is the first page (all lists are newest first). */
    public static final Position START = new Position(Instant.parse("9999-12-31T00:00:00Z"), new UUID(-1L, -1L));

    /** A position in a list: the sort value and the id of the last row already delivered. */
    public record Position(Instant at, UUID id) {}

    public record Page<T>(List<T> items, String nextCursor, Long totalCount) {

        public <R> Page<R> map(Function<T, R> mapper) {
            return new Page<>(items.stream().map(mapper).toList(), nextCursor, totalCount);
        }
    }

    private Pagination() {}

    /** Absent or non-positive means the default; anything above the maximum is capped. */
    public static int limit(Integer requested) {
        if (requested == null || requested <= 0) {
            return DEFAULT_LIMIT;
        }
        return Math.min(requested, MAX_LIMIT);
    }

    /** One extra row is fetched so the server knows whether another page exists without a count. */
    public static Pageable fetch(int limit) {
        return PageRequest.of(0, limit + 1);
    }

    public static Position decode(String cursor) {
        if (cursor == null || cursor.isBlank()) {
            return START;
        }
        try {
            String text = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
            int bar = text.indexOf('|');
            long micros = Long.parseLong(text.substring(0, bar));
            UUID id = UUID.fromString(text.substring(bar + 1));
            return new Position(Instant.ofEpochSecond(Math.floorDiv(micros, 1_000_000L), Math.floorMod(micros, 1_000_000L) * 1_000L), id);
        } catch (RuntimeException e) {
            throw new ApiException(org.springframework.http.HttpStatus.BAD_REQUEST, "bad_request", "The page cursor is not valid.");
        }
    }

    public static String encode(Instant at, UUID id) {
        long micros = at.getEpochSecond() * 1_000_000L + at.getNano() / 1_000L;
        return Base64.getUrlEncoder().withoutPadding().encodeToString((micros + "|" + id).getBytes(StandardCharsets.UTF_8));
    }

    /**
     * Turns the fetched rows (limit + 1 at most) into a page. {@code sortValue} and {@code idOf} describe the
     * last delivered row, which becomes the cursor when more rows exist.
     */
    public static <T> Page<T> page(List<T> fetched, int limit, Function<T, Instant> sortValue, Function<T, UUID> idOf, Long totalCount) {
        boolean more = fetched.size() > limit;
        List<T> items = more ? fetched.subList(0, limit) : fetched;
        String next = more ? encode(sortValue.apply(items.get(limit - 1)), idOf.apply(items.get(limit - 1))) : null;
        return new Page<>(List.copyOf(items), next, totalCount);
    }
}
