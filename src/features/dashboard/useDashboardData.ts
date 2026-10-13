import { useQuery } from '@tanstack/react-query'
import { useAuth } from '@/app/providers/AuthProvider'
import { useBusinessContext } from '@/app/providers/BusinessContextProvider'
import { usePermission } from '@/features/auth/permissions/usePermission'
import { summarizeInvoices } from '@/features/invoices/invoiceSummary'
import { dashboardService, invoiceService } from '@/services'
import type { DashboardScope } from '@/services/dashboardService'

const RECENT_TRANSACTION_LIMIT = 8
const RECENT_INVOICE_LIMIT = 4

/**
 * What the current user may see: the selected business, narrowed to their own records
 * when their role only has `limited` dashboard access. Null until a business is selected.
 */
function useDashboardScope(): DashboardScope | null {
  const { selectedMerchantId } = useBusinessContext()
  const { user } = useAuth()
  const { scope } = usePermission('dashboard:view')
  if (!selectedMerchantId || !scope) return null
  return {
    merchantId: selectedMerchantId,
    assignedUserId: scope === 'limited' ? user?.id : undefined,
  }
}

export const useDashboardSummary = () => {
  const scope = useDashboardScope()
  return useQuery({
    queryKey: ['dashboard', 'summary', scope],
    queryFn: () => dashboardService.getSummary(scope!),
    enabled: scope !== null,
  })
}

export const useRecentTransactions = () => {
  const scope = useDashboardScope()
  return useQuery({
    queryKey: ['dashboard', 'recent-transactions', scope, RECENT_TRANSACTION_LIMIT],
    queryFn: () => dashboardService.getRecentTransactions(scope!, RECENT_TRANSACTION_LIMIT),
    enabled: scope !== null,
  })
}

/**
 * Invoice figures come from InvoiceService (never from bank-side data). For cashiers the
 * service itself returns only their assigned invoices.
 */
export const useInvoiceSummary = () => {
  const scope = useDashboardScope()
  return useQuery({
    queryKey: ['dashboard', 'invoice-summary', scope],
    queryFn: async () =>
      summarizeInvoices((await invoiceService.listInvoices(scope!.merchantId)).items),
    enabled: scope !== null,
  })
}

export const useRecentInvoices = () => {
  const scope = useDashboardScope()
  return useQuery({
    queryKey: ['dashboard', 'recent-invoices', scope, RECENT_INVOICE_LIMIT],
    queryFn: async () =>
      (await invoiceService.listInvoices(scope!.merchantId, { limit: RECENT_INVOICE_LIMIT })).items,
    enabled: scope !== null,
  })
}

export const useDailyPaymentActivity = () => {
  const scope = useDashboardScope()
  return useQuery({
    queryKey: ['dashboard', 'daily-payment-activity', scope],
    queryFn: () => dashboardService.getDailyPaymentActivity(scope!),
    enabled: scope !== null,
  })
}

export const useProviderBreakdown = () => {
  const scope = useDashboardScope()
  return useQuery({
    queryKey: ['dashboard', 'provider-breakdown', scope],
    queryFn: () => dashboardService.getProviderBreakdown(scope!),
    enabled: scope !== null,
  })
}
