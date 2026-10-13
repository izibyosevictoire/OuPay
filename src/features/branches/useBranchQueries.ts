import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useBusinessContext } from '@/app/providers/BusinessContextProvider'
import {
  invalidateMerchantOrganization,
  organizationKeys,
} from '@/features/organization/organizationQueries'
import { branchService } from '@/services'
import type { BranchStatus, CreateBranchInput, UpdateBranchInput } from '@/types/branch'

/** The selected business. Branch and staff screens only render inside a business route. */
export function useSelectedMerchantId(): string {
  const { selectedMerchantId } = useBusinessContext()
  if (!selectedMerchantId) throw new Error('No business is selected')
  return selectedMerchantId
}

export function useBranches() {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: organizationKeys.branchList(merchantId),
    queryFn: () => branchService.listBranches(merchantId),
  })
}

export function useBranch(branchId: string) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: organizationKeys.branchDetail(merchantId, branchId),
    queryFn: () => branchService.getBranch(merchantId, branchId),
    // A missing or foreign branch will not appear on retry, so show that answer straight away.
    retry: false,
  })
}

export function useCreateBranch() {
  const queryClient = useQueryClient()
  const merchantId = useSelectedMerchantId()
  return useMutation({
    mutationFn: (input: CreateBranchInput) => branchService.createBranch(merchantId, input),
    onSuccess: () => invalidateMerchantOrganization(queryClient, merchantId),
  })
}

export function useUpdateBranch(branchId: string) {
  const queryClient = useQueryClient()
  const merchantId = useSelectedMerchantId()
  return useMutation({
    mutationFn: (input: UpdateBranchInput) =>
      branchService.updateBranch(merchantId, branchId, input),
    onSuccess: () => invalidateMerchantOrganization(queryClient, merchantId),
  })
}

export function useChangeBranchStatus() {
  const queryClient = useQueryClient()
  const merchantId = useSelectedMerchantId()
  return useMutation({
    mutationFn: ({ branchId, status }: { branchId: string; status: BranchStatus }) =>
      branchService.changeBranchStatus(merchantId, branchId, status),
    onSuccess: () => invalidateMerchantOrganization(queryClient, merchantId),
  })
}

export function useUpdateBranchAssignments() {
  const queryClient = useQueryClient()
  const merchantId = useSelectedMerchantId()
  return useMutation({
    mutationFn: ({ membershipId, branchIds }: { membershipId: string; branchIds: string[] }) =>
      branchService.updateBranchAssignments(merchantId, membershipId, branchIds),
    onSuccess: () => invalidateMerchantOrganization(queryClient, merchantId),
  })
}
