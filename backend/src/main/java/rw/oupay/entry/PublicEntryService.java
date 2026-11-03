package rw.oupay.entry;

import java.sql.Timestamp;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.checkout.CodeCheckoutDtos;
import rw.oupay.checkout.PublicCodeSaleService;
import rw.oupay.common.ApiException;
import rw.oupay.merchant.MerchantRepository;

/**
 * The CUSTOMER side of a payment-entry device: anonymous, cookie-less and deliberately thin.
 *
 * <h2>Three separate acts</h2>
 * <ul>
 *   <li>{@link #resolve} is READ-ONLY (a GET). Scanning a QR code or tapping an NFC tag can be pre-fetched by a phone, a messaging app or a link
 *       scanner, so opening the URL never takes the device: it only says whether a bill is ready, whether the device is busy, or nothing.</li>
 *   <li>{@link #claim} is an explicit POST. It gives ONE customer a short-lived session on the CURRENT bill of the device and an opaque claim token
 *       (shown once, stored hashed). At most one open claim per device: a database constraint, not a mutex, so any number of instances agree.</li>
 *   <li>{@link #release} lets that customer give the device back.</li>
 * </ul>
 *
 * <h2>What is promised</h2>
 * A claim is tied to the bill that was current when it was made. The holder keeps seeing THAT bill (read-only, with its real status, including
 * a late bank confirmation) whatever happens to the device afterwards. Everybody else sees "payment in progress" without any detail, never the
 * holder's amount, reference or code. The device never switches to another bill under a holder, and a claim that times out is NOT a failed
 * payment: it only frees the doorway, the bill itself is untouched and reconciliation (R6d-B) stays the only authority on whether money arrived.
 *
 * <h2>Privacy</h2>
 * An unknown, malformed, suspended or revoked token all answer UNAVAILABLE with the same body, so tokens cannot be probed. The bill is the existing
 * public code-sale view (no agent, no account, no internal id, a bank code only for a LIVE sale), and this service never says a payment happened.
 */
@Service
public class PublicEntryService {

    private static final Set<String> TERMINAL = Set.of("PAID", "EXPIRED", "CANCELLED");
    private static final String UNAVAILABLE_MESSAGE = "This payment point is not available.";

    private final JdbcClient jdbc;
    private final PublicCodeSaleService sales;
    private final MerchantRepository merchants;
    private final Clock clock;
    private final Duration claimTtl;

    public PublicEntryService(JdbcClient jdbc, PublicCodeSaleService sales, MerchantRepository merchants, Clock clock,
                              @Value("${oupay.entry.claim-ttl:PT5M}") Duration claimTtl) {
        this.jdbc = jdbc;
        this.sales = sales;
        this.merchants = merchants;
        this.clock = clock;
        this.claimTtl = claimTtl;
    }

    private record Device(UUID id, UUID merchantId, String status) {}

    private record Binding(UUID id, UUID saleId, String reference) {}

    private record Claim(UUID id, UUID bindingId, UUID saleId, String reference, Timestamp expiresAt, Timestamp endedAt, String endReason) {}

    // ---------------------------------------------------------------------------------------------

    @Transactional(readOnly = true)
    public EntryDtos.PublicEntry resolve(String token, String claimToken) {
        Optional<Device> device = findDevice(token, false);
        if (device.isEmpty()) {
            return unavailable();
        }
        Instant now = clock.instant();
        Optional<Claim> mine = holder(device.get(), claimToken);
        if (!"ACTIVE".equals(device.get().status())) {
            return unusable(device.get(), mine, now);
        }
        if (mine.isPresent()) {
            return forHolder(mine.get(), now, null, null);
        }
        return forStranger(device.get(), now);
    }

    /**
     * Takes the device for ONE customer. The browser may PROPOSE its own claim token (256 random bits, stored in its tab BEFORE the request
     * is sent): then a retry after a lost answer is the very same request, and finds the same claim instead of being turned away as "busy".
     * A proposal is used only when no claim anywhere already has that token; otherwise (or with no proposal) the server mints one. A proposed
     * token can only ever open its own claim on its own device: it never grants anything about anyone else's bill.
     */
    @Transactional
    public EntryDtos.PublicEntry claim(String token, String claimToken) {
        Optional<Device> found = findDevice(token, true);
        if (found.isEmpty()) {
            return unavailable();
        }
        Device device = found.get();
        Instant now = clock.instant();
        Timestamp ts = Timestamp.from(now);
        if (!"ACTIVE".equals(device.status())) {
            return unusable(device, holder(device, claimToken), now);
        }
        // Claims that have run out free the doorway (nothing about the bill or any payment is inferred from that).
        jdbc.sql("update payment_entry_claims set ended_at = :now, end_reason = 'EXPIRED' where device_id = :d and ended_at is null and expires_at <= :now")
                .param("now", ts).param("d", device.id()).update();
        Optional<Claim> mine = holder(device, claimToken);
        if (mine.isPresent() && mine.get().endedAt() == null) {
            // The same customer asks again (a retry, a refresh): keep their session, and only theirs, alive. Nothing new is minted.
            Timestamp renewed = Timestamp.from(now.plus(claimTtl));
            jdbc.sql("update payment_entry_claims set expires_at = :e where id = :c and ended_at is null").param("e", renewed).param("c", mine.get().id()).update();
            return forHolder(holder(device, claimToken).orElseThrow(), now, null, null);
        }
        Optional<Binding> binding = openBinding(device.id());
        if (binding.isEmpty() || TERMINAL.contains(status(binding.get().reference()))) {
            return idle(device);
        }
        boolean taken = jdbc.sql("select count(*) from payment_entry_claims where device_id = :d and ended_at is null").param("d", device.id())
                .query(Integer.class).single() > 0;
        if (taken) {
            return busy();
        }
        boolean proposed = claimToken != null && EntryTokens.CLAIM_TOKEN.matcher(claimToken).matches()
                && jdbc.sql("select count(*) from payment_entry_claims where claim_token_hash = :h").param("h", EntryTokens.hash(claimToken)).query(Integer.class).single() == 0;
        String secret = proposed ? claimToken : EntryTokens.newClaimToken();
        Timestamp expires = Timestamp.from(now.plus(claimTtl));
        jdbc.sql("insert into payment_entry_claims (id, device_id, merchant_id, binding_id, sale_id, claim_token_hash, created_at, expires_at) values (:id, :d, :m, :b, :s, :h, :now, :e)")
                .param("id", UUID.randomUUID()).param("d", device.id()).param("m", device.merchantId()).param("b", binding.get().id()).param("s", binding.get().saleId())
                .param("h", EntryTokens.hash(secret)).param("now", ts).param("e", expires).update();
        Claim created = new Claim(null, binding.get().id(), binding.get().saleId(), binding.get().reference(), expires, null, null);
        // A token the browser chose is not sent back (it already has it); a token the server minted is shown exactly once.
        return forHolder(created, now, proposed ? null : secret, null);
    }

    @Transactional
    public EntryDtos.PublicEntry release(String token, String claimToken) {
        Optional<Device> found = findDevice(token, true);
        if (found.isEmpty()) {
            return unavailable();
        }
        Device device = found.get();
        Instant now = clock.instant();
        if (!"ACTIVE".equals(device.status())) {
            return unusable(device, holder(device, claimToken), now);
        }
        holder(device, claimToken).filter(c -> c.endedAt() == null)
                .ifPresent(c -> jdbc.sql("update payment_entry_claims set ended_at = :now, end_reason = 'RELEASED' where id = :c and ended_at is null")
                        .param("now", Timestamp.from(clock.instant())).param("c", c.id()).update());
        Optional<Claim> mine = holder(device, claimToken);
        return mine.isPresent() ? forHolder(mine.get(), now, null, null) : forStranger(device, now);
    }

    /**
     * A suspended or revoked device serves nobody new: strangers get the one identical UNAVAILABLE answer. A customer who ALREADY holds a claim
     * for this device keeps seeing their own bill, read-only, so that revoking a lost tag never hides a payment someone is in the middle of.
     */
    private EntryDtos.PublicEntry unusable(Device device, Optional<Claim> mine, Instant now) {
        return mine.map(c -> forHolder(c, now, null, device.status())).orElseGet(PublicEntryService::unavailable);
    }

    // ---------------------------------------------------------------------------------------------

    private EntryDtos.PublicEntry forHolder(Claim claim, Instant now, String issuedToken, String deviceStatus) {
        CodeCheckoutDtos.PublicCodeSale sale;
        try {
            sale = sales.sale(claim.reference());
        } catch (ApiException e) {
            return unavailable();
        }
        boolean active = deviceStatus == null && claim.endedAt() == null && claim.expiresAt().toInstant().isAfter(now);
        if (active) {
            return new EntryDtos.PublicEntry(EntryDtos.EntryState.CLAIMED,
                    "This is your bill. Pay it with the code shown; the bank confirms the payment, not this page.",
                    sale.merchantDisplayName(), sale, new EntryDtos.Claim(true, claim.expiresAt().toInstant(), null, issuedToken));
        }
        String why = claim.endedAt() != null && claim.endReason() != null ? claim.endReason() : deviceStatus != null ? "DEVICE_" + deviceStatus : "EXPIRED";
        return new EntryDtos.PublicEntry(EntryDtos.EntryState.SESSION_ENDED,
                "Your session at this payment point has ended. This is the bill you were looking at, with its current status. If you already paid, nothing is lost.",
                sale.merchantDisplayName(), sale, new EntryDtos.Claim(false, claim.expiresAt().toInstant(), why, null));
    }

    private EntryDtos.PublicEntry forStranger(Device device, Instant now) {
        Optional<Binding> binding = openBinding(device.id());
        if (binding.isEmpty() || TERMINAL.contains(status(binding.get().reference()))) {
            return idle(device);
        }
        boolean busy = jdbc.sql("select count(*) from payment_entry_claims where device_id = :d and ended_at is null and expires_at > :now")
                .param("d", device.id()).param("now", Timestamp.from(now)).query(Integer.class).single() > 0;
        if (busy) {
            return busy();
        }
        return new EntryDtos.PublicEntry(EntryDtos.EntryState.READY,
                "A bill is ready here. Choose \"Show my bill\" to see it. Opening this page does not take it.", merchantName(device.merchantId()), null, null);
    }

    private EntryDtos.PublicEntry idle(Device device) {
        return new EntryDtos.PublicEntry(EntryDtos.EntryState.IDLE, "No bill is ready at this payment point yet. Ask the cashier to prepare it.",
                merchantName(device.merchantId()), null, null);
    }

    private static EntryDtos.PublicEntry busy() {
        return new EntryDtos.PublicEntry(EntryDtos.EntryState.BUSY, "Payment in progress for another customer. Please wait a moment and scan again.", null, null, null);
    }

    private static EntryDtos.PublicEntry unavailable() {
        return new EntryDtos.PublicEntry(EntryDtos.EntryState.UNAVAILABLE, UNAVAILABLE_MESSAGE, null, null, null);
    }

    /** A claim of THIS device that the presented token belongs to (open or already ended); anything else is "no claim". */
    private Optional<Claim> holder(Device device, String claimToken) {
        if (claimToken == null || !EntryTokens.CLAIM_TOKEN.matcher(claimToken).matches()) {
            return Optional.empty();
        }
        return jdbc.sql("select c.id, c.binding_id, c.sale_id, s.sale_reference, c.expires_at, c.ended_at, c.end_reason from payment_entry_claims c "
                        + "join code_sales s on s.payment_request_id = c.sale_id and s.merchant_id = c.merchant_id where c.claim_token_hash = :h and c.device_id = :d")
                .param("h", EntryTokens.hash(claimToken)).param("d", device.id())
                .query((rs, i) -> new Claim(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getObject(3, UUID.class), rs.getString(4), rs.getTimestamp(5),
                        rs.getTimestamp(6), rs.getString(7))).optional();
    }

    private Optional<Binding> openBinding(UUID deviceId) {
        return jdbc.sql("select b.id, b.sale_id, s.sale_reference from payment_entry_bindings b join code_sales s on s.payment_request_id = b.sale_id and s.merchant_id = b.merchant_id "
                        + "where b.device_id = :d and b.ended_at is null").param("d", deviceId)
                .query((rs, i) -> new Binding(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3))).optional();
    }

    /** The device behind a public token, whatever its status (the caller decides what a non-ACTIVE one may show). */
    private Optional<Device> findDevice(String token, boolean lock) {
        if (token == null || !EntryTokens.DEVICE_TOKEN.matcher(token).matches()) {
            return Optional.empty();
        }
        return jdbc.sql("select id, merchant_id, status from payment_entry_devices where public_token = :t" + (lock ? " for update" : "")).param("t", token)
                .query((rs, i) -> new Device(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getString(3))).optional();
    }

    private String status(String reference) {
        try {
            return sales.sale(reference).status().name();
        } catch (ApiException e) {
            return "CANCELLED";
        }
    }

    private String merchantName(UUID merchantId) {
        return merchants.findById(merchantId).map(m -> m.displayName()).orElse("Business");
    }
}
