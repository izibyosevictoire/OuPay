import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSelectedMerchantId } from '@/features/branches/useBranchQueries'
import { kycService } from '@/services'
import type { KycApplication } from '@/types/kyc'

export const kycKeys = {
  options: (merchantId: string) => ['kyc', merchantId, 'options'] as const,
  application: (merchantId: string, applicationId: string) =>
    ['kyc', merchantId, 'application', applicationId] as const,
}

/** The requirement set, what the registration already tells us, and the current application (if any). Always read fresh. */
export function useKycOptions() {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: kycKeys.options(merchantId),
    queryFn: () => kycService.getOptions(merchantId),
    retry: false,
    staleTime: 0,
  })
}

export function useKycApplication(applicationId: string | undefined) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: kycKeys.application(merchantId, applicationId ?? 'none'),
    queryFn: () => kycService.getApplication(merchantId, applicationId as string),
    enabled: Boolean(applicationId),
    retry: false,
    staleTime: 0,
  })
}

/** Every write returns the application as it now is; that becomes the cached copy, and the options (which name the live one) refresh. */
function useKycWrite<TVariables>(
  action: (merchantId: string, variables: TVariables) => Promise<KycApplication>,
) {
  const queryClient = useQueryClient()
  const merchantId = useSelectedMerchantId()
  return useMutation({
    mutationFn: (variables: TVariables) => action(merchantId, variables),
    onSuccess: (application) => {
      queryClient.setQueryData(kycKeys.application(merchantId, application.id), application)
      void queryClient.invalidateQueries({ queryKey: kycKeys.options(merchantId) })
    },
  })
}

export const useSaveAnswers = () =>
  useKycWrite(
    (merchantId, v: { applicationId: string; version: number; answers: Record<string, string> }) =>
      kycService.saveAnswers(merchantId, v.applicationId, v.version, v.answers),
  )

export const useDeclareDocument = () =>
  useKycWrite(
    (
      merchantId,
      v: { applicationId: string; version: number; documentKey: string; declaredReady: boolean },
    ) =>
      kycService.declareDocument(
        merchantId,
        v.applicationId,
        v.documentKey,
        v.version,
        v.declaredReady,
      ),
  )

export const useRecordConsent = () =>
  useKycWrite((merchantId, v: { applicationId: string; version: number; textVersion: string }) =>
    kycService.recordConsent(merchantId, v.applicationId, v.version, v.textVersion),
  )

export const useRespond = () =>
  useKycWrite((merchantId, v: { applicationId: string; requestId: string; response: string }) =>
    kycService.respondToInformationRequest(merchantId, v.applicationId, v.requestId, v.response),
  )

export function useStartApplication() {
  const queryClient = useQueryClient()
  const merchantId = useSelectedMerchantId()
  return useMutation({
    mutationFn: (clientOperationId: string) =>
      kycService.startApplication(merchantId, clientOperationId),
    onSuccess: ({ application }) => {
      queryClient.setQueryData(kycKeys.application(merchantId, application.id), application)
      void queryClient.invalidateQueries({ queryKey: kycKeys.options(merchantId) })
    },
  })
}

export function useSubmitApplication() {
  const queryClient = useQueryClient()
  const merchantId = useSelectedMerchantId()
  return useMutation({
    mutationFn: (v: { applicationId: string; version: number; submissionRequestId: string }) =>
      kycService.submit(merchantId, v.applicationId, v.version, v.submissionRequestId),
    onSuccess: ({ application }) => {
      queryClient.setQueryData(kycKeys.application(merchantId, application.id), application)
      void queryClient.invalidateQueries({ queryKey: kycKeys.options(merchantId) })
    },
  })
}

/** Showing a protected value is a recorded act, so it is a mutation (never cached, never refetched on its own). */
export function useRevealValue() {
  const merchantId = useSelectedMerchantId()
  return useMutation({
    mutationFn: (v: { applicationId: string; fieldKey: string }) =>
      kycService.revealValue(merchantId, v.applicationId, v.fieldKey),
  })
}
