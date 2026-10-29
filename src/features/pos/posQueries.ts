import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSelectedMerchantId } from '@/features/branches/useBranchQueries'
import { posService } from '@/services'
import type { PosDraftInput, PosDraftUpdateInput, PosLineInput } from '@/types/pos'

export const posKeys = {
  all: (merchantId: string) => ['pos', merchantId] as const,
  options: (merchantId: string) => ['pos', merchantId, 'options'] as const,
  items: (merchantId: string, branchId: string, query: string) =>
    ['pos', merchantId, 'items', branchId, query] as const,
  quote: (merchantId: string, branchId: string, lines: PosLineInput[]) =>
    ['pos', merchantId, 'quote', branchId, lines] as const,
  drafts: (merchantId: string) => ['pos', merchantId, 'drafts'] as const,
}

/** Whether this person can prepare sales and where. A business in another mode is told so, not shown an empty page. */
export function usePosOptions() {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: posKeys.options(merchantId),
    queryFn: () => posService.getPosOptions(merchantId),
    retry: false,
    staleTime: 0,
  })
}

/** The active goods and services matching the search, with current prices and the branch's informational stock. */
export function usePosItems(branchId: string, query: string) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: posKeys.items(merchantId, branchId, query),
    queryFn: () => posService.searchPosItems(merchantId, branchId, query),
    enabled: branchId !== '',
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 0,
  })
}

/** Prices the cart on the server. Never cached for long: prices and stock change. */
export function usePosQuote(branchId: string, lines: PosLineInput[], enabled: boolean) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: posKeys.quote(merchantId, branchId, lines),
    queryFn: () => posService.quotePosCart(merchantId, { branchId, lines }),
    enabled: enabled && branchId !== '' && lines.length > 0,
    placeholderData: keepPreviousData,
    retry: false,
    staleTime: 0,
    gcTime: 0,
  })
}

export function usePosDrafts() {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: posKeys.drafts(merchantId),
    queryFn: () => posService.listPosDrafts(merchantId),
    retry: false,
    staleTime: 0,
  })
}

export function useCreatePosDraft() {
  const queryClient = useQueryClient()
  const merchantId = useSelectedMerchantId()
  return useMutation({
    mutationFn: (input: PosDraftInput) => posService.createPosDraft(merchantId, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: posKeys.drafts(merchantId) }),
  })
}

export function useUpdatePosDraft() {
  const queryClient = useQueryClient()
  const merchantId = useSelectedMerchantId()
  return useMutation({
    mutationFn: (input: { draftId: string } & PosDraftUpdateInput) => {
      const { draftId, ...rest } = input
      return posService.updatePosDraft(merchantId, draftId, rest)
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: posKeys.drafts(merchantId) }),
  })
}

export function useDiscardPosDraft() {
  const queryClient = useQueryClient()
  const merchantId = useSelectedMerchantId()
  return useMutation({
    mutationFn: (input: { draftId: string; expectedVersion: number }) =>
      posService.discardPosDraft(merchantId, input.draftId, input.expectedVersion),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: posKeys.drafts(merchantId) }),
  })
}

/** Reads one draft with its current stock (used to reopen it into the cart). */
export function useOpenPosDraft() {
  const merchantId = useSelectedMerchantId()
  return useMutation({
    mutationFn: (draftId: string) => posService.getPosDraft(merchantId, draftId),
  })
}
