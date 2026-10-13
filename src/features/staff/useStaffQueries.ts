import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useAuth } from '@/app/providers/AuthProvider'
import { useSelectedMerchantId } from '@/features/branches/useBranchQueries'
import {
  invalidateMerchantOrganization,
  organizationKeys,
} from '@/features/organization/organizationQueries'
import { staffService } from '@/services'
import type { BusinessRole } from '@/types/auth'
import type { InviteStaffInput } from '@/types/staff'

export function useStaff() {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: organizationKeys.staff(merchantId),
    queryFn: () => staffService.listStaff(merchantId),
  })
}

/**
 * Staff changes can alter the signed-in user's own access (e.g. an owner revoking themselves),
 * so besides the merchant's cached data the session is refreshed too.
 */
function useAfterStaffChange(merchantId: string) {
  const queryClient = useQueryClient()
  const { refreshSession } = useAuth()
  return async () => {
    await Promise.all([invalidateMerchantOrganization(queryClient, merchantId), refreshSession()])
  }
}

export function useInviteStaff() {
  const merchantId = useSelectedMerchantId()
  const afterChange = useAfterStaffChange(merchantId)
  return useMutation({
    mutationFn: (input: InviteStaffInput) => staffService.inviteStaff(merchantId, input),
    onSuccess: afterChange,
  })
}

export function useUpdateMembershipRole() {
  const merchantId = useSelectedMerchantId()
  const afterChange = useAfterStaffChange(merchantId)
  return useMutation({
    mutationFn: ({ membershipId, role }: { membershipId: string; role: BusinessRole }) =>
      staffService.updateMembershipRole(merchantId, membershipId, role),
    onSuccess: afterChange,
  })
}

export type MembershipLifecycleAction = 'suspend' | 'reactivate' | 'revoke'

export function useMembershipLifecycle() {
  const merchantId = useSelectedMerchantId()
  const afterChange = useAfterStaffChange(merchantId)
  return useMutation({
    mutationFn: ({
      membershipId,
      action,
    }: {
      membershipId: string
      action: MembershipLifecycleAction
    }) => {
      if (action === 'suspend') return staffService.suspendMembership(merchantId, membershipId)
      if (action === 'reactivate')
        return staffService.reactivateMembership(merchantId, membershipId)
      return staffService.revokeMembership(merchantId, membershipId)
    },
    onSuccess: afterChange,
  })
}
