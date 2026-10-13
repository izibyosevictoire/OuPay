import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/app/providers/AuthProvider'
import { useBusinessContext } from '@/app/providers/BusinessContextProvider'
import { merchantService } from '@/services'
import type { CreateMerchantInput, UpdateMerchantInput } from '@/types/merchant'

const merchantsQueryKey = (userId: string | undefined) => ['merchants', userId] as const

/** Businesses the signed-in user has an active membership in (the service enforces this). */
export function useMerchantsForCurrentUser() {
  const { user } = useAuth()
  return useQuery({
    queryKey: merchantsQueryKey(user?.id),
    queryFn: () => merchantService.listMerchantsForCurrentUser(),
    enabled: Boolean(user),
  })
}

/** The business the user is working in; null when they have none. */
export function useCurrentMerchant() {
  const { selectedMerchantId } = useBusinessContext()
  const merchantsQuery = useMerchantsForCurrentUser()
  const merchants = merchantsQuery.data
  const merchant = merchants?.find((candidate) => candidate.id === selectedMerchantId) ?? null
  return { ...merchantsQuery, data: merchants ? merchant : undefined }
}

export function useCreateMerchant() {
  const queryClient = useQueryClient()
  const { user, refreshSession } = useAuth()
  const { selectMerchant } = useBusinessContext()
  return useMutation({
    mutationFn: (input: CreateMerchantInput) => merchantService.createMerchant(input),
    onSuccess: async (merchant) => {
      // The service created an OWNER membership; reload it so the new business becomes selectable.
      await Promise.all([
        refreshSession(),
        queryClient.invalidateQueries({ queryKey: merchantsQueryKey(user?.id) }),
      ])
      selectMerchant(merchant.id)
    },
  })
}

export function useUpdateMerchant(merchantId: string) {
  const queryClient = useQueryClient()
  const { user } = useAuth()
  return useMutation({
    mutationFn: (changes: UpdateMerchantInput) =>
      merchantService.updateMerchant(merchantId, changes),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: merchantsQueryKey(user?.id) }),
  })
}
