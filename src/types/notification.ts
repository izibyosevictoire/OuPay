export type NotificationKind =
  | 'PAYMENT_MATCHED'
  | 'PAYMENT_UNMATCHED'
  | 'INVOICE_PARTIALLY_SETTLED'
  | 'INVOICE_SETTLED'
  | 'PAYMENT_REVERSED'
  | 'NEEDS_REVIEW'

export interface AppNotification {
  id: string
  merchantId: string
  recipientUserId: string
  kind: NotificationKind
  title: string
  body: string
  relatedBankTransactionId: string | null
  relatedInvoiceId: string | null
  /** Unique per recipient: the same event can never notify the same person twice. */
  dedupeKey: string
  isSimulated: boolean
  readAt: string | null
  createdAt: string
}
