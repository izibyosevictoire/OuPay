package rw.oupay.ledger;

import java.util.Collection;
import java.util.HashMap;
import java.util.Map;
import java.util.UUID;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * Read-only access to derived invoice balances. The single source of truth is the ACTIVE rows of
 * {@code payment_allocations}; nothing about an invoice's payment state is ever stored on it.
 */
@Component
public class InvoiceBalanceReader {

    private final JdbcClient jdbc;

    public InvoiceBalanceReader(JdbcClient jdbc) {
        this.jdbc = jdbc;
    }

    public Map<UUID, Long> allocatedByInvoice(Collection<UUID> invoiceIds) {
        Map<UUID, Long> result = new HashMap<>();
        if (invoiceIds.isEmpty()) {
            return result;
        }
        jdbc.sql("select invoice_id, sum(amount_rwf) as total from payment_allocations "
                        + "where status = 'ACTIVE' and invoice_id in (:ids) group by invoice_id")
                .param("ids", invoiceIds)
                .query((rs, row) -> {
                    result.put(rs.getObject("invoice_id", UUID.class), rs.getLong("total"));
                    return null;
                })
                .list();
        return result;
    }

    public long allocated(UUID invoiceId) {
        return allocatedByInvoice(java.util.List.of(invoiceId)).getOrDefault(invoiceId, 0L);
    }

    public LedgerMath.InvoicePayment payment(UUID invoiceId, long invoiceTotal) {
        return LedgerMath.summarize(invoiceTotal, allocated(invoiceId));
    }
}
