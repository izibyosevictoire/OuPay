import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSelectedMerchantId } from '@/features/branches/useBranchQueries'
import { invalidateMerchantInvoices } from '@/features/invoices/invoiceQueries'
import { posService } from '@/services'
import type { PosBillInput } from '@/types/pos'
import { posKeys } from './posQueries'

/** How often a sale that is paid but not yet posted is read again (tests shorten it). It only decides WHEN TO ASK: the server decides what is true. */
export const posSalePolling = { intervalMilliseconds: 10_000 }

export const posBillingKeys = {
  exceptions: (merchantId: string) => ['pos', merchantId, 'fulfilment-exceptions'] as const,
  review: (merchantId: string, draftId: string, codeId: string | null) =>
    ['pos', merchantId, 'review', draftId, codeId] as const,
  sale: (merchantId: string, saleId: string) => ['pos', merchantId, 'sale', saleId] as const,
}

/** The server's FINAL review of a draft: current price, tax and availability. Never cached: every look is a fresh read. */
export function usePosBillingReview(
  draftId: string,
  collectionCodeId: string | null,
  enabled = true,
) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: posBillingKeys.review(merchantId, draftId, collectionCodeId),
    queryFn: () => posService.getBillingReview(merchantId, draftId, collectionCodeId),
    enabled,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  })
}

/** Bills one draft. A new sale changes invoices, stock availability and the drafts list, so those are refreshed. */
export function useBillPosDraft(draftId: string) {
  const queryClient = useQueryClient()
  const merchantId = useSelectedMerchantId()
  return useMutation({
    mutationFn: (input: PosBillInput) => posService.billPosDraft(merchantId, draftId, input),
    onSuccess: async () => {
      await invalidateMerchantInvoices(queryClient, merchantId)
      await queryClient.invalidateQueries({ queryKey: posKeys.all(merchantId) })
    },
  })
}

/** One POS sale: its lines, tax and reservation. Read from the server; nothing here decides an outcome. */
export function usePosSale(saleId: string) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: posBillingKeys.sale(merchantId, saleId),
    queryFn: () => posService.getPosSale(merchantId, saleId),
    retry: false,
    // Posting happens later, in the background: keep asking while a real sale has not been posted (nothing is decided by the timer).
    refetchInterval: (query) => {
      const f = query.state.data?.fulfilment
      return f && f.inventoryState === 'NOT_POSTED' ? posSalePolling.intervalMilliseconds : false
    },
  })
}

/** The open fulfilment exceptions of the business (owners only). */
export function usePosFulfilmentExceptions() {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: posBillingKeys.exceptions(merchantId),
    queryFn: () => posService.listFulfilmentExceptions(merchantId),
    retry: false,
    staleTime: 0,
  })
}
