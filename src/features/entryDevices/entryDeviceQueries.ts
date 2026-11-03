import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSelectedMerchantId } from '@/features/branches/useBranchQueries'
import { entryDeviceService, publicEntryService } from '@/services'
import type {
  AssignEntryDeviceInput,
  BindEntryDeviceInput,
  EntryDeviceStatus,
  EntryDeviceStatusInput,
  PublicEntry,
  RegisterEntryDeviceInput,
  UnbindEntryDeviceInput,
} from '@/types/entryDevices'

export const entryDeviceKeys = {
  all: (merchantId: string) => ['entryDevices', merchantId] as const,
  options: (merchantId: string) => ['entryDevices', merchantId, 'options'] as const,
  list: (merchantId: string, status?: EntryDeviceStatus) =>
    ['entryDevices', merchantId, 'list', status ?? 'all'] as const,
  detail: (merchantId: string, deviceId: string) =>
    ['entryDevices', merchantId, 'detail', deviceId] as const,
  assignments: (merchantId: string, deviceId: string) =>
    ['entryDevices', merchantId, 'assignments', deviceId] as const,
  bindings: (merchantId: string, deviceId: string) =>
    ['entryDevices', merchantId, 'bindings', deviceId] as const,
  eligible: (merchantId: string, deviceId: string) =>
    ['entryDevices', merchantId, 'eligible', deviceId] as const,
}

/** How often a device card re-reads while a customer may be looking at its bill (a timer only ASKS: status is never set by the screen). */
const DEVICE_POLL_MS = 10_000

export function useEntryDeviceOptions(enabled = true) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: entryDeviceKeys.options(merchantId),
    queryFn: () => entryDeviceService.getOptions(merchantId),
    enabled,
    retry: false,
  })
}

export function useEntryDevices(status?: EntryDeviceStatus) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: entryDeviceKeys.list(merchantId, status),
    queryFn: () => entryDeviceService.listDevices(merchantId, { status }),
    retry: false,
    // Who is looking at a bill right now changes by the minute: never show a minute-old answer.
    staleTime: 0,
    refetchInterval: (query) =>
      query.state.data?.some((device) => device.binding !== null) ? DEVICE_POLL_MS : false,
  })
}

export function useEntryDevice(deviceId: string) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: entryDeviceKeys.detail(merchantId, deviceId),
    queryFn: () => entryDeviceService.getDevice(merchantId, deviceId),
    retry: false,
  })
}

export function useDeviceAssignments(deviceId: string, enabled = true) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: entryDeviceKeys.assignments(merchantId, deviceId),
    queryFn: () => entryDeviceService.listAssignments(merchantId, deviceId),
    enabled,
    retry: false,
  })
}

export function useDeviceBindings(deviceId: string, enabled = true) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: entryDeviceKeys.bindings(merchantId, deviceId),
    queryFn: () => entryDeviceService.listBindings(merchantId, deviceId),
    enabled,
    retry: false,
  })
}

export function useEligibleSales(deviceId: string, enabled = true) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: entryDeviceKeys.eligible(merchantId, deviceId),
    queryFn: () => entryDeviceService.listEligibleSales(merchantId, deviceId),
    enabled,
    retry: false,
  })
}

function useInvalidate() {
  const merchantId = useSelectedMerchantId()
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: entryDeviceKeys.all(merchantId) })
}

export function useRegisterDevice() {
  const merchantId = useSelectedMerchantId()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (input: RegisterEntryDeviceInput) =>
      entryDeviceService.registerDevice(merchantId, input),
    onSuccess: invalidate,
  })
}

export function useAssignDevice(deviceId: string) {
  const merchantId = useSelectedMerchantId()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (input: AssignEntryDeviceInput) =>
      entryDeviceService.assignDevice(merchantId, deviceId, input),
    onSuccess: invalidate,
  })
}

export type DeviceStatusAction = 'suspend' | 'reactivate' | 'revoke'

export function useChangeDeviceStatus(deviceId: string) {
  const merchantId = useSelectedMerchantId()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: ({
      action,
      input,
    }: {
      action: DeviceStatusAction
      input: EntryDeviceStatusInput
    }) =>
      action === 'suspend'
        ? entryDeviceService.suspendDevice(merchantId, deviceId, input)
        : action === 'reactivate'
          ? entryDeviceService.reactivateDevice(merchantId, deviceId, input)
          : entryDeviceService.revokeDevice(merchantId, deviceId, input),
    onSuccess: invalidate,
  })
}

export function useBindSale(deviceId: string) {
  const merchantId = useSelectedMerchantId()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (input: BindEntryDeviceInput) =>
      entryDeviceService.bindSale(merchantId, deviceId, input),
    onSuccess: invalidate,
  })
}

export function useUnbindSale(deviceId: string) {
  const merchantId = useSelectedMerchantId()
  const invalidate = useInvalidate()
  return useMutation({
    mutationFn: (input: UnbindEntryDeviceInput) =>
      entryDeviceService.unbindSale(merchantId, deviceId, input),
    onSuccess: invalidate,
  })
}

// ---- the customer's side ------------------------------------------------------------------------------------------

export const publicEntryKey = (token: string, claim: string | null) =>
  ['publicEntry', token, claim ?? 'none'] as const

const CUSTOMER_POLL_MS = 10_000

/**
 * The customer's page state. READ-ONLY: it never takes the device. While a bill is in front of the customer, or the device is busy, it
 * asks again every few seconds (a timer only ASKS; the status is the bank-verified one the server reports).
 */
export function usePublicEntry(token: string, claim: string | null) {
  return useQuery({
    queryKey: publicEntryKey(token, claim),
    queryFn: () => publicEntryService.resolve(token, claim),
    retry: false,
    // Whether the payment point is ready, busy or idle must never come from a cache: every visit asks again.
    staleTime: 0,
    gcTime: 0,
    refetchInterval: (query) => {
      const entry: PublicEntry | undefined = query.state.data
      if (!entry) return false
      if (entry.state === 'BUSY' || entry.state === 'READY' || entry.state === 'IDLE') {
        return CUSTOMER_POLL_MS
      }
      if (entry.state === 'CLAIMED' || entry.state === 'SESSION_ENDED') {
        const open =
          entry.sale?.status === 'AWAITING_PAYMENT' || entry.sale?.status === 'PARTIALLY_PAID'
        return open ? CUSTOMER_POLL_MS : false
      }
      return false
    },
  })
}

export function useClaimEntry(token: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (claim: string | null) => publicEntryService.claim(token, claim),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['publicEntry', token] }),
  })
}

export function useReleaseEntry(token: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (claim: string | null) => publicEntryService.release(token, claim),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['publicEntry', token] }),
  })
}
