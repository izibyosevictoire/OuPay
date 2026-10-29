import type {
  CodeSaleCustomerStatus,
  CodeSaleRequestStatus,
  CodeSaleStage,
} from '@/types/codeCheckout'

/**
 * What a sale is, in the customer's words, from what the server reported. PAID only when the bank-verified money has been APPLIED to
 * the sale (status SETTLED). Money the bank confirmed that is not applied to the sale needs reconciliation: it is never "paid".
 */
export function customerStatusOf(
  status: CodeSaleRequestStatus,
  stage: CodeSaleStage,
): CodeSaleCustomerStatus {
  if (stage === 'CONFIRMED_UNMATCHED' || stage === 'REVERSED') return 'REQUIRES_RECONCILIATION'
  switch (status) {
    case 'SETTLED':
      return 'PAID'
    case 'PARTIALLY_SETTLED':
      return 'PARTIALLY_PAID'
    case 'EXPIRED':
      return 'EXPIRED'
    case 'CANCELLED':
      return 'CANCELLED'
    default:
      return 'AWAITING_PAYMENT'
  }
}

export const CUSTOMER_STATUS_LABEL: Record<CodeSaleCustomerStatus, string> = {
  AWAITING_PAYMENT: 'Awaiting payment',
  PARTIALLY_PAID: 'Partially paid',
  PAID: 'Paid',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
  REQUIRES_RECONCILIATION: 'Requires reconciliation',
}

/** Finished one way or another: a new sale needs no confirmation. Late money can still arrive after expiry. */
export const isFinishedStatus = (status: CodeSaleCustomerStatus) =>
  status === 'PAID' || status === 'EXPIRED' || status === 'CANCELLED'
