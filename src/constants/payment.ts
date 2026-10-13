import type { BankConnectionStatus, ProviderId } from '@/types/banking'
import type { NotificationKind } from '@/types/notification'
import type {
  AllocationStatus,
  AuditEntryKind,
  BankTransactionStatus,
  ReconciliationStatus,
} from '@/types/payment'
import type { CustomerPaymentStage, PaymentProfileStatus } from '@/types/paymentProfile'

/** What the BANK says happened to the money. */
export const BANK_TRANSACTION_STATUS_LABELS: Record<BankTransactionStatus, string> = {
  PENDING: 'Pending',
  CONFIRMED: 'Confirmed',
  FAILED: 'Failed',
  REVERSED: 'Reversed',
}

/** What OuPay has done with confirmed money (a separate question from the bank status). */
export const RECONCILIATION_STATUS_LABELS: Record<ReconciliationStatus, string> = {
  NOT_APPLICABLE: 'Not applicable',
  UNMATCHED: 'Unmatched',
  COLLECTED: 'Collected (not on an invoice)',
  PARTIALLY_ALLOCATED: 'Partly allocated',
  FULLY_ALLOCATED: 'Fully allocated',
  REVERSED: 'Reversed',
}

export const ALLOCATION_STATUS_LABELS: Record<AllocationStatus, string> = {
  ACTIVE: 'Active',
  REVERSED: 'Reversed',
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  EQUITY_MOCK: 'Equity Bank (simulated)',
  MTN_MOMO: 'MTN MoMo',
  AIRTEL_MONEY: 'Airtel Money',
}

export const BANK_CONNECTION_STATUS_LABELS: Record<BankConnectionStatus, string> = {
  NOT_CONFIGURED: 'Not configured',
  PENDING: 'Pending',
  CONNECTED: 'Connected (demo)',
  ERROR: 'Error',
  DISABLED: 'Disabled',
}

export const PAYMENT_PROFILE_STATUS_LABELS: Record<PaymentProfileStatus, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Switched off',
  REVOKED: 'Replaced',
}

export const CUSTOMER_STAGE_LABELS: Record<CustomerPaymentStage, string> = {
  AWAITING_PAYMENT: 'Waiting for payment',
  BANK_CONFIRMATION_PENDING: 'Waiting for the bank to confirm',
  CONFIRMED_AND_RECONCILED: 'Paid and confirmed by the bank',
  CONFIRMED_UNMATCHED: 'Confirmed by the bank',
  PARTIALLY_SETTLED: 'Partly paid',
  FAILED: 'Payment failed',
  EXPIRED: 'Expired',
  REVERSED: 'Payment reversed',
  CANCELLED: 'Cancelled',
}

export const NOTIFICATION_KIND_LABELS: Record<NotificationKind, string> = {
  PAYMENT_MATCHED: 'Payment received',
  PAYMENT_UNMATCHED: 'Unmatched payment',
  INVOICE_PARTIALLY_SETTLED: 'Partly paid',
  INVOICE_SETTLED: 'Invoice settled',
  PAYMENT_REVERSED: 'Payment reversed',
  NEEDS_REVIEW: 'Needs review',
}

export const AUDIT_KIND_LABELS: Record<AuditEntryKind, string> = {
  TRANSACTION_CREATED: 'Received',
  EVENT_RECEIVED: 'Event',
  STATUS_CHANGED: 'Status changed',
  REFERENCE_MATCHED: 'Reference matched',
  AUTO_ALLOCATED: 'Applied automatically',
  MANUAL_ALLOCATED: 'Applied manually',
  ALLOCATION_REVERSED: 'Allocation reversed',
  BANK_REVERSAL: 'Bank reversal',
  FLAGGED_FOR_REVIEW: 'Flagged for review',
  MARKED_REVIEWED: 'Reviewed',
  DUPLICATE_EVENT_IGNORED: 'Duplicate ignored',
  STALE_EVENT_IGNORED: 'Stale event ignored',
  REFUND_RECORDED: 'Refund recorded',
}
