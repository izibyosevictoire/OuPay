import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSelectedMerchantId } from '@/features/branches/useBranchQueries'
import { invalidateMerchantInvoices } from '@/features/invoices/invoiceQueries'
import { customerStatusOf, isFinishedStatus } from '@/lib/codeSaleStatus'
import { codeCheckoutService, publicCodeSaleService } from '@/services'
import type { CodeSaleInput } from '@/types/codeCheckout'

export const codeCheckoutKeys = {
  options: (merchantId: string) => ['code-checkout', merchantId, 'options'] as const,
  sale: (merchantId: string, saleId: string) =>
    ['code-checkout', merchantId, 'sale', saleId] as const,
  publicSale: (reference: string) => ['code-checkout', 'public', reference] as const,
}

/** How often a sale that is still collecting is read again (tests shorten it). Finished sales are still read, slowly. */
export const codeSalePolling = { intervalMilliseconds: 4000, finishedIntervalMilliseconds: 30_000 }

export function useCodeCheckoutOptions() {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: codeCheckoutKeys.options(merchantId),
    queryFn: () => codeCheckoutService.getCodeCheckoutOptions(merchantId),
    retry: false,
    staleTime: 0,
  })
}

export function useBillCodeSale() {
  const queryClient = useQueryClient()
  const merchantId = useSelectedMerchantId()
  return useMutation({
    mutationFn: (input: CodeSaleInput) => codeCheckoutService.billCodeSale(merchantId, input),
    onSuccess: () => invalidateMerchantInvoices(queryClient, merchantId),
  })
}

/** The live state of one sale, read from the server. Nothing here decides an outcome: it only decides WHEN TO ASK again. */
export function useCodeSale(saleId: string) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: codeCheckoutKeys.sale(merchantId, saleId),
    queryFn: () => codeCheckoutService.getCodeSale(merchantId, saleId),
    retry: false,
    refetchInterval: (query) => {
      const sale = query.state.data
      if (!sale) return codeSalePolling.intervalMilliseconds
      return isFinishedStatus(customerStatusOf(sale.status, sale.stage))
        ? codeSalePolling.finishedIntervalMilliseconds
        : codeSalePolling.intervalMilliseconds
    },
  })
}

/** The customer's page. Anonymous; refreshed while the sale is open. */
export function usePublicCodeSale(reference: string) {
  return useQuery({
    queryKey: codeCheckoutKeys.publicSale(reference),
    queryFn: () => publicCodeSaleService.getPublicCodeSale(reference),
    retry: false,
    refetchInterval: (query) => {
      const sale = query.state.data
      return sale && isFinishedStatus(sale.status)
        ? codeSalePolling.finishedIntervalMilliseconds
        : codeSalePolling.intervalMilliseconds
    },
  })
}
