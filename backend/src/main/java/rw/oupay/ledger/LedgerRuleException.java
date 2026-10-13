package rw.oupay.ledger;

import org.springframework.http.HttpStatus;
import rw.oupay.common.ApiException;

/** A financial rule refused an operation. These protect the books; they are not bugs. */
public class LedgerRuleException extends ApiException {

    public LedgerRuleException(String code, String message) {
        super(HttpStatus.CONFLICT, code, message);
    }

    public static LedgerRuleException notConfirmed() {
        return new LedgerRuleException("transaction_not_confirmed", "Only bank-confirmed money can be applied to an invoice.");
    }

    public static LedgerRuleException invoiceNotPayable(String invoiceNumber) {
        return new LedgerRuleException("invoice_not_payable", "Invoice " + invoiceNumber + " cannot receive payments.");
    }

    public static LedgerRuleException exceedsRemaining(String invoiceNumber, long remaining) {
        return new LedgerRuleException("exceeds_remaining", "Invoice " + invoiceNumber + " only has RWF " + remaining + " left to pay.");
    }

    public static LedgerRuleException exceedsUnapplied() {
        return new LedgerRuleException("exceeds_unapplied", "That is more than the unapplied amount of this transaction.");
    }

    public static LedgerRuleException allocationNotActive() {
        return new LedgerRuleException("allocation_not_active", "That allocation has already been reversed.");
    }
}
