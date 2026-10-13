import type { QueryClient } from '@tanstack/react-query'

/**
 * Query keys for business-scoped data. The merchant ID is always part of the key, so
 * switching businesses can never serve another business's cached rows.
 */
export const organizationKeys = {
  branches: (merchantId: string) => ['branches', merchantId] as const,
  branchList: (merchantId: string) => ['branches', merchantId, 'list'] as const,
  branchDetail: (merchantId: string, branchId: string) =>
    ['branches', merchantId, 'detail', branchId] as const,
  staff: (merchantId: string) => ['staff', merchantId] as const,
}

/**
 * Refreshes everything that a branch or staff change can affect, for that merchant only:
 * branch lists and details (staff counts), staff lists (assignments) and the dashboard
 * (active-cashier figure). Other businesses' cached data is left alone.
 */
export async function invalidateMerchantOrganization(queryClient: QueryClient, merchantId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: organizationKeys.branches(merchantId) }),
    queryClient.invalidateQueries({ queryKey: organizationKeys.staff(merchantId) }),
    // Invoice form options (active branches and eligible cashiers) depend on both.
    queryClient.invalidateQueries({ queryKey: ['invoices', merchantId] }),
    queryClient.invalidateQueries({
      predicate: ({ queryKey }) =>
        queryKey[0] === 'dashboard' &&
        (queryKey[2] as { merchantId?: string } | null)?.merchantId === merchantId,
    }),
  ])
}
