package rw.oupay.ledger;

import java.sql.Timestamp;
import java.time.Clock;
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.audit.AuditService;

/**
 * ATTRIBUTION of a bank transaction (R6d-A): which collection code the BANK reported, which of the merchant's own codes that is, and, from an
 * exact code sale reference, whose sale it names. TRUSTED: called only by the bank-event processor, inside its transaction, never from a
 * request.
 *
 * <p>It records evidence and a verdict. It never allocates, links a payment request, changes a status or touches an invoice: the bank ledger
 * stays the single source of financial truth, and a code sale is still not matched automatically (V13).
 *
 * <p>The rules, all of them exact:
 * <ul>
 *   <li><b>Merchant and account</b> come from the authenticated account the money reached (never from a code).</li>
 *   <li><b>A reported code resolves</b> only if it equals, ignoring case, the external code of exactly one code (the registry guarantees at
 *       most one per provider), that code belongs to THIS merchant, and it settles to THIS account. Unknown, another business's, or on another
 *       account are all just UNRESOLVED, so a merchant can never learn that a code exists elsewhere.</li>
 *   <li><b>A sale reference</b> is EVIDENCE that the payment names a sale, not proof of who collected. The agent is CONFIRMED (from that
 *       sale's immutable snapshot) only when the bank also reported the sale's own code and the money reached the sale's account. With a
 *       reference but no reported code the sale is NAMED and the agent stays UNCONFIRMED. With no reference, or any conflict, the agent is
 *       UNRESOLVED: never inferred from who holds the code now, who held it when the event arrived, a time, an amount or a payer.</li>
 *   <li><b>Conflicts</b>: a resolved code that differs from the referenced sale's code, or a later event reporting a different code than the
 *       one recorded, is a CONFLICT (final) and is flagged. Recorded evidence is never overwritten (database trigger).</li>
 * </ul>
 * Provider occurrence time is NOT used here at all.
 */
@Component
public class AttributionRecorder {

    private static final Pattern SALE_REFERENCE = Pattern.compile("^OP-[2-9A-HJKMNP-Z]{12}$");

    public enum Status { RESOLVED, UNRESOLVED, CONFLICT, NOT_REPORTED }

    /** What was recorded by this call, so the caller can raise review. {@code changed} is false when nothing new was learned. */
    public record Result(Status status, boolean changed, boolean needsReview, String note) {}

    private record Current(Status status, String reportedCode, UUID destinationId, UUID saleId, String agent) {}

    private record CodeRow(UUID id, UUID merchantId, UUID destinationId) {}

    private record SaleRow(UUID id, UUID codeId, UUID destinationId) {}

    private final JdbcClient jdbc;
    private final AuditService audit;
    private final Clock clock;

    public AttributionRecorder(JdbcClient jdbc, AuditService audit, Clock clock) {
        this.jdbc = jdbc;
        this.audit = audit;
        this.clock = clock;
    }

    /**
     * Evaluates the transaction from what it carries now plus the code reported by the event that is being applied (null when it carries none).
     * Safe to call again for every applied event of the same transaction: evidence already recorded is kept, and only new evidence, or a
     * contradiction, changes anything.
     */
    @Transactional(propagation = Propagation.MANDATORY)
    public Result record(BankTransaction tx, String eventReportedCode) {
        Current now = current(tx.getId());
        String recorded = now.reportedCode();
        String reported = recorded != null ? recorded : eventReportedCode;

        boolean contradicted = recorded != null && eventReportedCode != null && !recorded.equalsIgnoreCase(eventReportedCode);
        UUID destination = now.destinationId() != null ? now.destinationId() : destinationOf(tx);
        Optional<SaleRow> sale = now.saleId() != null ? saleById(tx, now.saleId()) : saleReferencedBy(tx);
        UUID saleId = now.saleId() != null ? now.saleId() : sale.map(SaleRow::id).orElse(null);

        Status status;
        UUID codeId = null;
        String note;
        if (reported == null) {
            status = Status.NOT_REPORTED;
            note = "The bank did not report a collection code; the account is all that is known.";
        } else {
            Optional<CodeRow> code = codeFor(tx, reported);
            if (code.isEmpty() || !code.get().merchantId().equals(tx.getMerchantId()) || destination == null
                    || !destination.equals(code.get().destinationId())) {
                status = Status.UNRESOLVED;
                note = "The reported code is not one of this business's codes on this account.";
            } else {
                status = Status.RESOLVED;
                codeId = code.get().id();
                note = "The reported code matches exactly one code of this business on this account.";
            }
        }
        // The code the sale was made through must be the code the bank reports, when it reports one, and the money must have reached the
        // account the sale settles to. Either contradiction is a conflict: the evidence disagrees with itself.
        if (status == Status.RESOLVED && sale.isPresent() && !sale.get().codeId().equals(codeId)) {
            status = Status.CONFLICT;
            note = "The reported code differs from the code of the sale this payment names.";
        } else if (sale.isPresent() && destination != null && !destination.equals(sale.get().destinationId())) {
            status = Status.CONFLICT;
            note = "The sale this payment names settles to a different account than the one the money reached.";
        }
        if (contradicted && status != Status.CONFLICT) {
            status = Status.CONFLICT;
            note = "A later event reported a different code than the one first recorded.";
        }
        // A conflict stays a conflict, and a verdict only ever moves from "nothing reported" to a real one.
        if (now.status() == Status.CONFLICT) {
            return new Result(Status.CONFLICT, false, false, null);
        }
        if (now.status() != null && now.status() != Status.NOT_REPORTED && status != Status.CONFLICT) {
            status = now.status();
            note = null;
        }
        // The CONCLUSION about who collected is derived from the evidence every time and is never the evidence itself:
        //  - confirmed only when the exact sale, the bank's reported code (the sale's own) and the account all agree;
        //  - "named but unconfirmed" when the exact sale is named and the bank reported no code (the evidence is incomplete);
        //  - unresolved otherwise, including every conflict: a contradicted conclusion is withdrawn, never kept.
        boolean saleAgrees = sale.isPresent() && codeId != null && sale.get().codeId().equals(codeId)
                && destination != null && destination.equals(sale.get().destinationId());
        String agent;
        if (status == Status.RESOLVED && saleAgrees) {
            agent = "CONFIRMED_FROM_SALE_SNAPSHOT";
        } else if (status == Status.NOT_REPORTED && saleId != null) {
            agent = "SALE_NAMED_UNCONFIRMED";
        } else {
            agent = "UNRESOLVED";
        }

        String basis = destination == null ? "UNATTRIBUTED" : reported == null ? "ACCOUNT_ONLY" : "CODE_REPORTED";
        boolean changed = now.status() != status || !java.util.Objects.equals(now.reportedCode(), reported)
                || !java.util.Objects.equals(now.saleId(), saleId) || !agent.equals(now.agent())
                || !java.util.Objects.equals(now.destinationId(), destination);
        if (!changed) {
            return new Result(status, false, false, null);
        }
        jdbc.sql("update bank_transactions set settlement_destination_id = :dest, reported_code = :code, collection_code_id = coalesce(collection_code_id, :codeId), "
                        + "attribution_basis = :basis, attribution_status = :status, attribution_note = coalesce(:note, attribution_note), "
                        + "referenced_code_sale_id = coalesce(referenced_code_sale_id, :sale), agent_attribution = :agent, "
                        + "attributed_at = coalesce(attributed_at, :now) where id = :id")
                .param("dest", destination).param("code", reported).param("codeId", codeId).param("basis", basis).param("status", status.name())
                .param("note", note).param("sale", saleId).param("agent", agent).param("now", Timestamp.from(clock.instant())).param("id", tx.getId()).update();
        audit.recordLedger(tx.getMerchantId(), null, "ATTRIBUTION_RECORDED", tx.getId(), null,
                "Attribution " + status.name().toLowerCase(java.util.Locale.ROOT).replace('_', ' ') + " (" + basis.toLowerCase(java.util.Locale.ROOT).replace('_', ' ')
                        + (saleId != null ? ", names a code sale" : "") + ").");
        boolean needsReview = status == Status.CONFLICT || (status == Status.UNRESOLVED && reported != null);
        return new Result(status, true, needsReview, note);
    }

    private Current current(UUID transactionId) {
        return jdbc.sql("select attribution_status, reported_code, settlement_destination_id, referenced_code_sale_id, agent_attribution "
                        + "from bank_transactions where id = :id")
                .param("id", transactionId)
                .query((rs, i) -> new Current(rs.getString(1) == null ? null : Status.valueOf(rs.getString(1)), rs.getString(2),
                        rs.getObject(3, UUID.class), rs.getObject(4, UUID.class), rs.getString(5)))
                .single();
    }

    /** The merchant's linked account the money reached: the one destination of the authenticated connection, or none when that is not unique. */
    private UUID destinationOf(BankTransaction tx) {
        List<UUID> destinations = jdbc.sql("select id from payment_destinations where bank_connection_id = :c and merchant_id = :m")
                .param("c", tx.getBankConnectionId()).param("m", tx.getMerchantId()).query(UUID.class).list();
        return destinations.size() == 1 ? destinations.get(0) : null;
    }

    private Optional<CodeRow> codeFor(BankTransaction tx, String reported) {
        return jdbc.sql("select id, merchant_id, settlement_destination_id from collection_codes "
                        + "where provider_id = :p and external_code is not null and upper(external_code) = upper(:c)")
                .param("p", tx.getProviderId().name()).param("c", reported)
                .query((rs, i) -> new CodeRow(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getObject(3, UUID.class))).optional();
    }

    private Optional<SaleRow> saleById(BankTransaction tx, UUID saleId) {
        return jdbc.sql("select payment_request_id, collection_code_id, settlement_destination_id from code_sales where merchant_id = :m and payment_request_id = :id")
                .param("m", tx.getMerchantId()).param("id", saleId)
                .query((rs, i) -> new SaleRow(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getObject(3, UUID.class))).optional();
    }

    private Optional<SaleRow> saleReferencedBy(BankTransaction tx) {
        String reference = tx.getPaymentReference();
        if (reference == null || !SALE_REFERENCE.matcher(reference).matches()) {
            return Optional.empty();
        }
        return jdbc.sql("select payment_request_id, collection_code_id, settlement_destination_id from code_sales where merchant_id = :m and sale_reference = :r")
                .param("m", tx.getMerchantId()).param("r", reference)
                .query((rs, i) -> new SaleRow(rs.getObject(1, UUID.class), rs.getObject(2, UUID.class), rs.getObject(3, UUID.class))).optional();
    }
}
