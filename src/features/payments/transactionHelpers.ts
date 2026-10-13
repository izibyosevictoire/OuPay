import type { BankTransactionView } from '@/types/payment'

/** Same rule as the ledger's `requiresReview`, expressed on the read model the screens hold. */
export const viewNeedsReview = (t: BankTransactionView): boolean =>
  t.status === 'CONFIRMED' &&
  (t.reviewState === 'NEEDS_REVIEW' ||
    (t.reviewState !== 'REVIEWED' && t.reconciliationStatus === 'UNMATCHED'))

/** Confirmed money with something left that is not on any invoice. */
export const hasUnappliedMoney = (t: BankTransactionView): boolean => t.unappliedAmount > 0

export const referenceOf = (t: BankTransactionView): string => t.paymentReference ?? 'No reference'

/** A cashier shown only through allocation to their invoice, otherwise the payer name from the bank. */
export const whoOf = (t: BankTransactionView): string =>
  t.verifiedCashierNames.length > 0 ? t.verifiedCashierNames.join(', ') : t.payerDisplayName

export const invoiceNumbersOf = (t: BankTransactionView): string =>
  [
    ...new Set(
      t.invoices.filter((i) => i.allocationStatus === 'ACTIVE').map((i) => i.invoiceNumber),
    ),
  ].join(', ') || 'None'
