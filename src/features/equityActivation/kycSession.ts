/**
 * Identifiers that make a retry safe: the same start (per person and business) and the same submission (per application) keep one id
 * until they succeed, so a lost answer followed by a retry finds the application or submission that already exists instead of making
 * another. Held for this browser tab only. They are random identifiers, never personal data.
 */
const storage = (): Storage | undefined => {
  try {
    return typeof window === 'undefined' ? undefined : window.sessionStorage
  } catch {
    return undefined
  }
}

function stableId(key: string): string {
  const existing = storage()?.getItem(key)
  if (existing) return existing
  const fresh = crypto.randomUUID()
  try {
    storage()?.setItem(key, fresh)
  } catch {
    // Remembering is a convenience, never a requirement.
  }
  return fresh
}

function forget(key: string) {
  try {
    storage()?.removeItem(key)
  } catch {
    // ignore
  }
}

export const startOperationId = (scope: string) => stableId(`oupay.kyc.start.${scope}`)
export const forgetStartOperation = (scope: string) => forget(`oupay.kyc.start.${scope}`)
export const submissionId = (applicationId: string) => stableId(`oupay.kyc.submit.${applicationId}`)
export const forgetSubmission = (applicationId: string) =>
  forget(`oupay.kyc.submit.${applicationId}`)
