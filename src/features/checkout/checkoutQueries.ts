import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSelectedMerchantId } from '@/features/branches/useBranchQueries'
import { invalidateMerchantInvoices } from '@/features/invoices/invoiceQueries'
import { checkoutService, invoiceService, paymentProfileService } from '@/services'
import type { SimpleCheckoutInput, SimpleCheckoutResult } from '@/types/checkout'
import { describeSaleStatus } from './checkoutRules'

export const checkoutKeys = {
  options: (merchantId: string) => ['checkout', merchantId, 'simple-options'] as const,
  sale: (merchantId: string, invoiceId: string) =>
    ['checkout', merchantId, 'sale', invoiceId] as const,
}

/** How often a sale that is still collecting is read again from the server (tests shorten it). */
export const salePolling = { intervalMilliseconds: 4000, finishedIntervalMilliseconds: 30_000 }

/** What the checkout needs before it shows the form (mode, eligible branches, setup gaps). Always read fresh. */
export function useSimpleCheckoutOptions() {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: checkoutKeys.options(merchantId),
    queryFn: () => checkoutService.getSimpleCheckoutOptions(merchantId),
    retry: false,
    staleTime: 0,
  })
}

/** Bills one sale. A new sale changes invoices, so their lists and the dashboard are refreshed. */
export function useBillSimpleCheckout() {
  const queryClient = useQueryClient()
  const merchantId = useSelectedMerchantId()
  return useMutation({
    mutationFn: (input: SimpleCheckoutInput) =>
      checkoutService.billSimpleCheckout(merchantId, input),
    onSuccess: () => invalidateMerchantInvoices(queryClient, merchantId),
  })
}

/**
 * The live state of one sale, read from the server: the invoice (with its bank-reconciled payment status) and its payment
 * request. It keeps reading while the sale is still collecting and stops once it is finished. Nothing here is a timer that
 * decides an outcome: it only decides WHEN TO ASK again.
 */
export function useSaleStatus(sale: SimpleCheckoutResult) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: checkoutKeys.sale(merchantId, sale.invoiceId),
    queryFn: async () => {
      const [invoice, requests] = await Promise.all([
        invoiceService.getInvoice(merchantId, sale.invoiceId),
        paymentProfileService.listInvoicePaymentRequests(merchantId, sale.invoiceId),
      ])
      const request = requests.find((r) => r.id === sale.paymentRequestId) ?? requests[0]
      return { invoice, request }
    },
    refetchInterval: (query) => {
      const data = query.state.data
      if (!data?.request) return salePolling.intervalMilliseconds
      const status = describeSaleStatus(data.request.status, data.invoice)
      // A finished sale is still read, slowly: late money can arrive after expiry and a confirmed payment can be reversed.
      return status.isFinished
        ? salePolling.finishedIntervalMilliseconds
        : salePolling.intervalMilliseconds
    },
  })
}
