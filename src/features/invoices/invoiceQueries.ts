import type { QueryClient } from '@tanstack/react-query'

/** Invoice query keys always contain the merchant, so switching business never reuses another's cache. */
export const invoiceKeys = {
  all: (merchantId: string) => ['invoices', merchantId] as const,
  list: (merchantId: string) => ['invoices', merchantId, 'list'] as const,
  detail: (merchantId: string, invoiceId: string) =>
    ['invoices', merchantId, 'detail', invoiceId] as const,
  formOptions: (merchantId: string) => ['invoices', merchantId, 'form-options'] as const,
}

/** After any invoice change: refresh that merchant's invoices and its dashboard figures only. */
export async function invalidateMerchantInvoices(queryClient: QueryClient, merchantId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: invoiceKeys.all(merchantId) }),
    queryClient.invalidateQueries({
      predicate: ({ queryKey }) =>
        queryKey[0] === 'dashboard' &&
        (queryKey[2] as { merchantId?: string } | null)?.merchantId === merchantId,
    }),
  ])
}
