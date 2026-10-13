import type { ProviderId } from './banking'
import type { MerchantOwned } from './merchant'

/** Figures from the bank-side ledger and staff. Invoice figures come from InvoiceService. */
export interface DashboardSummary {
  /** Sum of CONFIRMED incoming bank transactions, each counted once. */
  verifiedIncomingTotal: number
  /** Sum of ACTIVE allocations: confirmed money applied to invoices. */
  allocatedTotal: number
  /** Confirmed money not (or no longer) applied to any invoice. */
  unappliedConfirmedTotal: number
  /** Confirmed transactions flagged, or unmatched and not yet reviewed. */
  requiresReviewCount: number
  confirmedTransactionCount: number
  activeCashierCount: number
}

export interface DailyPaymentActivity extends MerchantOwned {
  date: string
  confirmedAmountInRwf: number
  pendingAmountInRwf: number
}

export interface ProviderShare {
  providerId: ProviderId
  amountInRwf: number
}
