package rw.oupay.notification;

public enum NotificationKind {
    PAYMENT_MATCHED,
    PAYMENT_UNMATCHED,
    INVOICE_PARTIALLY_SETTLED,
    INVOICE_SETTLED,
    PAYMENT_REVERSED,
    NEEDS_REVIEW
}
