import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { bankSimulator, publicPaymentService } from '@/services'
import type { RequestSimulationKind } from '@/services/bankSimulatorService'
import type { PublicRequestView } from '@/types/paymentProfile'

/** Public keys contain only the public token and reference: there is no signed-in context here. */
export const publicKeys = {
  profile: (token: string) => ['public', token, 'profile'] as const,
  request: (token: string, reference: string) => ['public', token, 'request', reference] as const,
}

/** After these stages nothing more will change on its own, so polling can stop. */
const SETTLED_STAGES: PublicRequestView['stage'][] = [
  'CONFIRMED_AND_RECONCILED',
  'CONFIRMED_UNMATCHED',
  'EXPIRED',
  'CANCELLED',
  'FAILED',
]

export function usePublicProfile(token: string) {
  return useQuery({
    queryKey: publicKeys.profile(token),
    queryFn: () => publicPaymentService.getProfile(token),
    retry: false,
  })
}

export function usePublicRequest(token: string, reference: string) {
  return useQuery({
    queryKey: publicKeys.request(token, reference),
    queryFn: () => publicPaymentService.getRequest(token, reference),
    retry: false,
    // Status tracker: poll until the payment reaches a final state.
    refetchInterval: (query) =>
      query.state.data && SETTLED_STAGES.includes(query.state.data.stage) ? false : 3000,
  })
}

export function useCreateOpenRequest(token: string) {
  return useMutation({
    mutationFn: (amountInRwf: number) => publicPaymentService.createOpenRequest(token, amountInRwf),
  })
}

export function useRecordCustomerAction(token: string, reference: string) {
  const queryClient = useQueryClient()
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: publicKeys.request(token, reference) })
  return {
    markOpened: useMutation({
      mutationFn: () => publicPaymentService.markInstructionsOpened(token, reference),
      onSuccess: refresh,
    }),
    claimPaid: useMutation({
      mutationFn: () => publicPaymentService.claimPaymentInitiated(token, reference),
      onSuccess: refresh,
    }),
  }
}

/** DEMO ONLY: null in builds without demo tools. */
export const demoSimulatorAvailable = () => bankSimulator !== null

export function useSimulateBankPayment(token: string, reference: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (kind: RequestSimulationKind) => {
      if (!bankSimulator) throw new Error('Demo tools are disabled.')
      return bankSimulator.simulateRequestPayment(reference, kind)
    },
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: publicKeys.request(token, reference) }),
        // The merchant side shares this ledger: refresh anything that depends on it.
        queryClient.invalidateQueries({ queryKey: ['payments'] }),
        queryClient.invalidateQueries({ queryKey: ['invoices'] }),
        queryClient.invalidateQueries({ queryKey: ['notifications'] }),
        queryClient.invalidateQueries({ queryKey: ['dashboard'] }),
      ]),
  })
}
