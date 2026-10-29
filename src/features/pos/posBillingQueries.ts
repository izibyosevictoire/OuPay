import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSelectedMerchantId } from '@/features/branches/useBranchQueries'
import { invalidateMerchantInvoices } from '@/features/invoices/invoiceQueries'
import { posService } from '@/services'
import type { PosBillInput } from '@/types/pos'
import { posKeys } from './posQueries'

export const posBillingKeys = {
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
  })
}
