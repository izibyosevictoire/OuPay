package rw.oupay.ledger;

import java.util.Optional;
import java.util.UUID;
import java.util.regex.Pattern;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import rw.oupay.invoice.Invoice;
import rw.oupay.invoice.InvoiceRepository;

/**
 * THE AUTOMATIC MATCH of a confirmed bank transaction to a LIVE code sale (R6d-B). It decides ELIGIBILITY only: it never allocates, never
 * locks, never changes a status. The caller, the bank-event processor, then runs its ordinary exact-reference allocation (lock order:
 * transaction, then invoice; capped at the remaining balance; excess flagged), inside the same database transaction. Nothing here opens a
 * second financial transaction or keeps a second ledger.
 *
 * <p>A transaction is eligible only when ALL of this agrees (the {@link CodeSaleAllocationPolicy} is the single definition, and the database
 * trigger enforces the same last):
 * <ul>
 *   <li>it is confirmed incoming money (the caller only asks for those), on the authenticated account of the sale's business;</li>
 *   <li>its reference is exactly the sale's own unique {@code OP-} reference (a high-entropy reference, never an invoice number);</li>
 *   <li>the bank reported a code and it resolved to the sale's own code, and the money reached the sale's settlement account, so attribution is
 *       RESOLVED and the agent is confirmed from the sale snapshot (no conflict, nothing unresolved);</li>
 *   <li>the sale is LIVE, never a demonstration.</li>
 * </ul>
 * Never sufficient on their own: amount, time, payer, agent, branch, the current holder of a code, or a code with no reference. The request's
 * expiry is NOT a condition: a payment that arrives late is still real money for a real sale.
 * Anything short of that leaves the money CONFIRMED and UNMATCHED, and the reason is what a person reads in the review queue.
 */
@Component
public class CodeSaleMatcher {

    private static final Pattern SALE_REFERENCE = Pattern.compile("^OP-[2-9A-HJKMNP-Z]{12}$");

    /** @param reason null when eligible; otherwise why not, in plain words */
    public record Verdict(boolean eligible, String reason) {

        static Verdict yes() {
            return new Verdict(true, null);
        }

        static Verdict no(String reason) {
            return new Verdict(false, reason);
        }
    }

    private final JdbcClient jdbc;
    private final InvoiceRepository invoices;
    private final CodeSaleAllocationPolicy policy;

    public CodeSaleMatcher(JdbcClient jdbc, InvoiceRepository invoices, CodeSaleAllocationPolicy policy) {
        this.jdbc = jdbc;
        this.invoices = invoices;
        this.policy = policy;
    }

    /** Evaluates a CONFIRMED transaction whose reference names a code sale (or an invoice number of one). Reads only. */
    @Transactional(propagation = Propagation.MANDATORY)
    public Verdict evaluate(BankTransaction tx) {
        String reference = tx.getPaymentReference();
        String prefix = "The reference " + reference + " names a code sale, but ";
        if (reference == null || !SALE_REFERENCE.matcher(reference).matches()) {
            return Verdict.no(prefix + "it is not the sale's own reference (an invoice number never matches a code sale). It stays confirmed and unmatched for review.");
        }
        Optional<UUID> invoiceId = jdbc.sql("select invoice_id from code_sales where merchant_id = :m and sale_reference = :r")
                .param("m", tx.getMerchantId()).param("r", reference).query(UUID.class).optional();
        if (invoiceId.isEmpty()) {
            return Verdict.no(prefix + "that sale does not belong to this business. It stays confirmed and unmatched for review.");
        }
        Invoice invoice = invoices.findByIdAndMerchantId(invoiceId.get(), tx.getMerchantId()).orElse(null);
        if (invoice == null) {
            return Verdict.no(prefix + "its invoice could not be found. It stays confirmed and unmatched for review.");
        }
        String problem = policy.problem(tx, invoice, PaymentAllocation.Origin.AUTO_REFERENCE, false);
        return problem == null ? Verdict.yes()
                : Verdict.no(prefix + "the bank evidence is not complete and consistent: " + problem + ". It stays confirmed and unmatched for review.");
    }
}
