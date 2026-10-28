import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query'
import { useAuth } from '@/app/providers/AuthProvider'
import { useSelectedMerchantId } from '@/features/branches/useBranchQueries'
import {
  bankingService,
  notificationService,
  paymentProfileService,
  reconciliationService,
} from '@/services'
import type { CreatePaymentProfileInput } from '@/services/paymentProfileService'
import type { AccountLinkRequest } from '@/types/banking'
import type { ManualAllocationInput } from '@/types/payment'

/** Every payment-side key starts with the merchant, so switching business never reuses another cache. */
export const paymentKeys = {
  all: (merchantId: string) => ['payments', merchantId] as const,
  transactions: (merchantId: string) => ['payments', merchantId, 'transactions'] as const,
  transaction: (merchantId: string, id: string) =>
    ['payments', merchantId, 'transaction', id] as const,
  allocations: (merchantId: string) => ['payments', merchantId, 'allocations'] as const,
  attributions: (merchantId: string) => ['payments', merchantId, 'attributions'] as const,
  attribution: (merchantId: string, id: string) =>
    ['payments', merchantId, 'attribution', id] as const,
  payableInvoices: (merchantId: string) => ['payments', merchantId, 'payable-invoices'] as const,
  providers: () => ['providers'] as const,
  connections: (merchantId: string) => ['payments', merchantId, 'connections'] as const,
  destinations: (merchantId: string) => ['payments', merchantId, 'destinations'] as const,
  profiles: (merchantId: string) => ['payments', merchantId, 'profiles'] as const,
  profile: (merchantId: string, id: string) => ['payments', merchantId, 'profile', id] as const,
  profileOptions: (merchantId: string) => ['payments', merchantId, 'profile-options'] as const,
  invoiceRequests: (merchantId: string, invoiceId: string) =>
    ['payments', merchantId, 'invoice-requests', invoiceId] as const,
  /** Notifications belong to a person within a business, so both are in the key. */
  notifications: (merchantId: string, userId: string) =>
    ['notifications', merchantId, userId] as const,
}

/**
 * After any payment change: refresh that merchant's payment data, invoices (balances),
 * notifications and dashboard figures. Other businesses' caches are left alone.
 */
export async function invalidateMerchantPayments(queryClient: QueryClient, merchantId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: paymentKeys.all(merchantId) }),
    queryClient.invalidateQueries({ queryKey: ['invoices', merchantId] }),
    queryClient.invalidateQueries({
      predicate: ({ queryKey }) => queryKey[0] === 'notifications' && queryKey[1] === merchantId,
    }),
    queryClient.invalidateQueries({
      predicate: ({ queryKey }) =>
        queryKey[0] === 'dashboard' &&
        (queryKey[2] as { merchantId?: string } | null)?.merchantId === merchantId,
    }),
  ])
}

export function useBankTransactions() {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: paymentKeys.transactions(merchantId),
    queryFn: () => reconciliationService.listBankTransactions(merchantId),
  })
}

export function useBankTransaction(transactionId: string) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: paymentKeys.transaction(merchantId, transactionId),
    queryFn: () => reconciliationService.getBankTransaction(merchantId, transactionId),
    retry: false,
  })
}

/** How incoming transactions relate to collection codes and code sales. Scoped by the server; a failure never hides the transactions. */
export function useBankAttributions() {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: paymentKeys.attributions(merchantId),
    queryFn: () => reconciliationService.listBankAttributions(merchantId),
    retry: false,
  })
}

/** One transaction's attribution. `not_found` means it is not a code payment, or is outside what this person may see. */
export function useBankAttribution(transactionId: string) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: paymentKeys.attribution(merchantId, transactionId),
    queryFn: () => reconciliationService.getBankAttribution(merchantId, transactionId),
    retry: false,
  })
}

export function useAllocations() {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: paymentKeys.allocations(merchantId),
    queryFn: () => reconciliationService.listAllocations(merchantId),
  })
}

export function usePayableInvoices(enabled = true) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: paymentKeys.payableInvoices(merchantId),
    queryFn: () => reconciliationService.listPayableInvoices(merchantId),
    enabled,
    staleTime: 0,
  })
}

function usePaymentMutation<TVariables, TResult>(
  action: (merchantId: string, variables: TVariables) => Promise<TResult>,
) {
  const queryClient = useQueryClient()
  const merchantId = useSelectedMerchantId()
  return useMutation({
    mutationFn: (variables: TVariables) => action(merchantId, variables),
    onSuccess: () => invalidateMerchantPayments(queryClient, merchantId),
  })
}

export const useAllocateManually = () =>
  usePaymentMutation((merchantId, input: ManualAllocationInput) =>
    reconciliationService.allocateManually(merchantId, input),
  )

export const useReverseAllocation = () =>
  usePaymentMutation((merchantId, v: { allocationId: string; reason: string }) =>
    reconciliationService.reverseAllocation(merchantId, v.allocationId, { reason: v.reason }),
  )

export const useMarkReviewed = () =>
  usePaymentMutation(
    (
      merchantId,
      v: { bankTransactionId: string; note: string; expectedTransactionVersion: number },
    ) =>
      reconciliationService.markReviewed(merchantId, v.bankTransactionId, {
        note: v.note,
        expectedTransactionVersion: v.expectedTransactionVersion,
      }),
  )

// ---- notifications ----------------------------------------------------------------------------

/** Polls gently so a payment confirmed elsewhere shows up without a reload. */
export function useNotifications() {
  const merchantId = useSelectedMerchantId()
  const { user } = useAuth()
  return useQuery({
    queryKey: paymentKeys.notifications(merchantId, user?.id ?? 'anonymous'),
    queryFn: () => notificationService.listNotifications(merchantId),
    enabled: Boolean(user),
    refetchInterval: 15_000,
  })
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient()
  const merchantId = useSelectedMerchantId()
  const { user } = useAuth()
  return useMutation({
    mutationFn: (notificationId: string) =>
      notificationService.markAsRead(merchantId, notificationId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: paymentKeys.notifications(merchantId, user?.id ?? 'anonymous'),
      }),
  })
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient()
  const merchantId = useSelectedMerchantId()
  const { user } = useAuth()
  return useMutation({
    mutationFn: () => notificationService.markAllAsRead(merchantId),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: paymentKeys.notifications(merchantId, user?.id ?? 'anonymous'),
      }),
  })
}

// ---- banking configuration --------------------------------------------------------------------

export const useProviders = () =>
  useQuery({ queryKey: paymentKeys.providers(), queryFn: () => bankingService.listProviders() })

export function useBankConnections() {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: paymentKeys.connections(merchantId),
    queryFn: () => bankingService.listConnections(merchantId),
    retry: false,
  })
}

export function usePaymentDestinations() {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: paymentKeys.destinations(merchantId),
    queryFn: () => bankingService.listPaymentDestinations(merchantId),
    retry: false,
  })
}

export const useStartAccountLink = () =>
  usePaymentMutation((merchantId, input: AccountLinkRequest) =>
    bankingService.startAccountLink(merchantId, input),
  )
export const useCompleteAccountLink = () =>
  usePaymentMutation((merchantId, connectionId: string) =>
    bankingService.completeAccountLink(merchantId, connectionId),
  )
export const useDisableConnection = () =>
  usePaymentMutation((merchantId, connectionId: string) =>
    bankingService.disableConnection(merchantId, connectionId),
  )

// ---- payment links ----------------------------------------------------------------------------

export function usePaymentProfiles() {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: paymentKeys.profiles(merchantId),
    queryFn: () => paymentProfileService.listProfiles(merchantId),
  })
}

export function usePaymentProfile(profileId: string) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: paymentKeys.profile(merchantId, profileId),
    queryFn: () => paymentProfileService.getProfile(merchantId, profileId),
    retry: false,
  })
}

export function usePaymentProfileOptions(enabled = true) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: paymentKeys.profileOptions(merchantId),
    queryFn: () => paymentProfileService.getFormOptions(merchantId),
    enabled,
    staleTime: 0,
  })
}

export function useInvoicePaymentRequests(invoiceId: string) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: paymentKeys.invoiceRequests(merchantId, invoiceId),
    queryFn: () => paymentProfileService.listInvoicePaymentRequests(merchantId, invoiceId),
  })
}

export const useCreatePaymentProfile = () =>
  usePaymentMutation((merchantId, input: CreatePaymentProfileInput) =>
    paymentProfileService.createProfile(merchantId, input),
  )
export const useSetProfileActive = () =>
  usePaymentMutation((merchantId, v: { profileId: string; isActive: boolean }) =>
    paymentProfileService.setProfileActive(merchantId, v.profileId, v.isActive),
  )
export const useReissueProfile = () =>
  usePaymentMutation((merchantId, profileId: string) =>
    paymentProfileService.reissueProfile(merchantId, profileId),
  )
export const useCreateInvoicePaymentRequest = () =>
  usePaymentMutation((merchantId, invoiceId: string) =>
    paymentProfileService.createInvoicePaymentRequest(merchantId, invoiceId),
  )
export const useCancelPaymentRequest = () =>
  usePaymentMutation((merchantId, requestId: string) =>
    paymentProfileService.cancelPaymentRequest(merchantId, requestId),
  )
