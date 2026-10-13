import type { DailyPaymentActivity, DashboardSummary, ProviderShare } from '@/types/business'
import type { BankTransactionView } from '@/types/payment'

/**
 * Which business's data to read, and optionally only the records assigned to one user.
 * The UI derives `assignedUserId` from the role's permission scope; a real backend must
 * apply the same restriction itself rather than trusting this parameter.
 */
export interface DashboardScope {
  merchantId: string
  assignedUserId?: string
}

/**
 * Contract for the bank-side and staff figures on the dashboard. Every figure is derived from
 * the same ledger that transactions, allocations and invoices use, so nothing is counted twice
 * and the dashboard can never disagree with the screens it summarises. Invoice figures (billed
 * and outstanding) come from InvoiceService, so the two sources are never mixed.
 */
export interface DashboardService {
  getSummary(scope: DashboardScope): Promise<DashboardSummary>
  getRecentTransactions(scope: DashboardScope, limit: number): Promise<BankTransactionView[]>
  getDailyPaymentActivity(scope: DashboardScope): Promise<DailyPaymentActivity[]>
  getProviderBreakdown(scope: DashboardScope): Promise<ProviderShare[]>
}
