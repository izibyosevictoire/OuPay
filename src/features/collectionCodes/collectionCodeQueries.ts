import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { COLLECTION_CODE_PAGE_SIZE } from '@/constants/collectionCodes'
import { useSelectedMerchantId } from '@/features/branches/useBranchQueries'
import { collectionCodeService } from '@/services'
import type {
  AssigneeInput,
  DeclareSubmissionInput,
  EndAssignmentInput,
  ListCollectionCodesQuery,
  ReassignInput,
  RequestCollectionCodeInput,
  StatusChangeInput,
} from '@/types/collectionCodes'

export const collectionCodeKeys = {
  all: (merchantId: string) => ['collectionCodes', merchantId] as const,
  options: (merchantId: string) => ['collectionCodes', merchantId, 'options'] as const,
  list: (merchantId: string, filters: Omit<ListCollectionCodesQuery, 'cursor'>) =>
    ['collectionCodes', merchantId, 'list', filters] as const,
  detail: (merchantId: string, codeId: string) =>
    ['collectionCodes', merchantId, 'detail', codeId] as const,
  assignments: (merchantId: string, codeId: string) =>
    ['collectionCodes', merchantId, 'assignments', codeId] as const,
  mine: (merchantId: string) => ['collectionCodes', merchantId, 'mine'] as const,
}

/** Settlement accounts, branches and assignable members, scoped to what the caller may use. */
export function useCollectionCodeOptions(enabled = true) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: collectionCodeKeys.options(merchantId),
    queryFn: () => collectionCodeService.getOptions(merchantId),
    enabled,
    retry: false,
  })
}

export function useCollectionCodes(filters: Omit<ListCollectionCodesQuery, 'cursor'>) {
  const merchantId = useSelectedMerchantId()
  return useInfiniteQuery({
    queryKey: collectionCodeKeys.list(merchantId, filters),
    queryFn: ({ pageParam }) =>
      collectionCodeService.listCodes(merchantId, {
        ...filters,
        limit: COLLECTION_CODE_PAGE_SIZE,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  })
}

export function useCollectionCode(codeId: string) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: collectionCodeKeys.detail(merchantId, codeId),
    queryFn: () => collectionCodeService.getCode(merchantId, codeId),
    retry: false,
  })
}

export function useAssignmentHistory(codeId: string) {
  const merchantId = useSelectedMerchantId()
  return useInfiniteQuery({
    queryKey: collectionCodeKeys.assignments(merchantId, codeId),
    queryFn: ({ pageParam }) =>
      collectionCodeService.listAssignments(merchantId, codeId, {
        limit: COLLECTION_CODE_PAGE_SIZE,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  })
}

/** The caller's own current assignment and code. */
export function useMyCollectionCode(enabled = true) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: collectionCodeKeys.mine(merchantId),
    queryFn: () => collectionCodeService.getMyCode(merchantId),
    enabled,
    retry: false,
  })
}

/** Every change can alter the list, the details and the history, so all of the business's code queries are refreshed. */
function useRefreshAfterChange() {
  const merchantId = useSelectedMerchantId()
  const queryClient = useQueryClient()
  return () => queryClient.invalidateQueries({ queryKey: collectionCodeKeys.all(merchantId) })
}

export function useRequestCode() {
  const merchantId = useSelectedMerchantId()
  const refresh = useRefreshAfterChange()
  return useMutation({
    mutationFn: (input: RequestCollectionCodeInput) =>
      collectionCodeService.requestCode(merchantId, input),
    onSuccess: refresh,
  })
}

export function useAssignCode(codeId: string) {
  const merchantId = useSelectedMerchantId()
  const refresh = useRefreshAfterChange()
  return useMutation({
    mutationFn: (input: AssigneeInput) => collectionCodeService.assign(merchantId, codeId, input),
    onSuccess: refresh,
  })
}

export function useEndAssignment(codeId: string) {
  const merchantId = useSelectedMerchantId()
  const refresh = useRefreshAfterChange()
  return useMutation({
    mutationFn: (input: EndAssignmentInput) =>
      collectionCodeService.endAssignment(merchantId, codeId, input),
    onSuccess: refresh,
  })
}

export function useReassignCode(codeId: string) {
  const merchantId = useSelectedMerchantId()
  const refresh = useRefreshAfterChange()
  return useMutation({
    mutationFn: (input: ReassignInput) => collectionCodeService.reassign(merchantId, codeId, input),
    onSuccess: refresh,
  })
}

export function useDeclareSubmission(codeId: string) {
  const merchantId = useSelectedMerchantId()
  const refresh = useRefreshAfterChange()
  return useMutation({
    mutationFn: (input: DeclareSubmissionInput) =>
      collectionCodeService.declareSubmission(merchantId, codeId, input),
    onSuccess: refresh,
  })
}

export function useSuspendCode(codeId: string) {
  const merchantId = useSelectedMerchantId()
  const refresh = useRefreshAfterChange()
  return useMutation({
    mutationFn: (input: StatusChangeInput) =>
      collectionCodeService.suspend(merchantId, codeId, input),
    onSuccess: refresh,
  })
}

export function useDeactivateCode(codeId: string) {
  const merchantId = useSelectedMerchantId()
  const refresh = useRefreshAfterChange()
  return useMutation({
    mutationFn: (input: StatusChangeInput) =>
      collectionCodeService.deactivate(merchantId, codeId, input),
    onSuccess: refresh,
  })
}
