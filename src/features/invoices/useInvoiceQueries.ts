import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSelectedMerchantId } from '@/features/branches/useBranchQueries'
import { invoiceService } from '@/services'
import type { InvoiceDraftInput } from '@/types/invoice'
import { invalidateMerchantInvoices, invoiceKeys } from './invoiceQueries'

export function useInvoices() {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: invoiceKeys.list(merchantId),
    queryFn: async () => (await invoiceService.listInvoices(merchantId)).items,
  })
}

export function useInvoice(invoiceId: string) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: invoiceKeys.detail(merchantId, invoiceId),
    queryFn: () => invoiceService.getInvoice(merchantId, invoiceId),
    // A missing, foreign or not-yours invoice will not appear on retry.
    retry: false,
  })
}

export function useInvoiceFormOptions() {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: invoiceKeys.formOptions(merchantId),
    queryFn: () => invoiceService.getInvoiceFormOptions(merchantId),
    retry: false,
    // Eligibility changes with branches and staff, so always check fresh when the form opens.
    staleTime: 0,
  })
}

/** All invoice writes share one rule: invalidate this merchant's invoices and dashboard. */
function useInvoiceMutation<TVariables, TResult>(
  action: (merchantId: string, variables: TVariables) => Promise<TResult>,
) {
  const queryClient = useQueryClient()
  const merchantId = useSelectedMerchantId()
  return useMutation({
    mutationFn: (variables: TVariables) => action(merchantId, variables),
    onSuccess: () => invalidateMerchantInvoices(queryClient, merchantId),
  })
}

export const useCreateDraft = () =>
  useInvoiceMutation((merchantId, input: InvoiceDraftInput) =>
    invoiceService.createDraft(merchantId, input),
  )

export const useUpdateDraft = () =>
  useInvoiceMutation(
    (merchantId, v: { invoiceId: string; input: InvoiceDraftInput; version: number }) =>
      invoiceService.updateDraft(merchantId, v.invoiceId, v.input, v.version),
  )

export const useIssueInvoice = () =>
  useInvoiceMutation((merchantId, v: { invoiceId: string; version: number }) =>
    invoiceService.issueInvoice(merchantId, v.invoiceId, v.version),
  )

export const useCancelDraft = () =>
  useInvoiceMutation((merchantId, v: { invoiceId: string; version: number }) =>
    invoiceService.cancelDraft(merchantId, v.invoiceId, v.version),
  )

export const useVoidInvoice = () =>
  useInvoiceMutation((merchantId, v: { invoiceId: string; version: number; reason: string }) =>
    invoiceService.voidInvoice(merchantId, v.invoiceId, { reason: v.reason }, v.version),
  )
