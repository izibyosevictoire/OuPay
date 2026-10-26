import type {
  KycAnswer,
  KycApplication,
  KycApplicationStatus,
  KycAppliesWhen,
  KycField,
  KycRequirementDefinition,
} from '@/types/kyc'

/** Whether a field or document applies, given the answers so far. Nothing hidden by a condition is ever required. */
export function applies(when: KycAppliesWhen | null | undefined, values: Record<string, string>) {
  if (!when) return true
  const current = values[when.key]
  return current !== undefined && when.in.includes(current)
}

/** The current non-protected answers of an application, plus the owner's unsaved edits on top. */
export function valuesOf(
  answers: KycAnswer[],
  edits: Record<string, string> = {},
): Record<string, string> {
  const values: Record<string, string> = {}
  for (const answer of answers) {
    if (answer.value !== null) values[answer.key] = answer.value
  }
  for (const [key, value] of Object.entries(edits)) {
    if (value.trim() === '') delete values[key]
    else values[key] = value
  }
  return values
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const PHONE = /^\+?[0-9][0-9 ]{5,18}[0-9]$/
const DEFAULT_MAX = 200

/** A browser-side hint for one value. The server decides; a message names the field and never repeats the value. */
export function fieldProblem(field: KycField, raw: string): string | null {
  const value = raw.trim()
  if (value === '') return null
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(value)) return `${field.label} must be on one line.`
  if (field.type === 'EMAIL' && (value.length > 254 || !EMAIL.test(value)))
    return `${field.label} is not a valid email address.`
  if (field.type === 'PHONE' && !PHONE.test(value))
    return `${field.label} is not a valid phone number.`
  if (field.type === 'CHOICE' && !field.options?.some((option) => option.value === value))
    return `Choose one of the options for ${field.label}.`
  if (field.type === 'TEXT' && value.length > (field.maxLength ?? DEFAULT_MAX))
    return `${field.label} can be at most ${field.maxLength ?? DEFAULT_MAX} characters.`
  if (field.pattern && !new RegExp(field.pattern).test(value))
    return field.patternHint
      ? `${field.label}: ${field.patternHint}`
      : `${field.label} is not in the expected format.`
  return null
}

/** Required fields that apply and have no value (a saved protected value counts as given). */
export function missingRequired(
  definition: KycRequirementDefinition,
  application: KycApplication,
  edits: Record<string, string> = {},
): string[] {
  const values = valuesOf(application.answers, edits)
  const protectedGiven = new Set(
    application.answers.filter((a) => a.sensitive && a.hasValue).map((a) => a.key),
  )
  return definition.fields
    .filter(
      (field) =>
        field.required &&
        applies(field.appliesWhen, values) &&
        !values[field.key] &&
        !protectedGiven.has(field.key),
    )
    .map((field) => field.key)
}

export interface KycStatusWording {
  label: string
  /** What this status really means, in plain words. Never overstates what OuPay or Equity has done. */
  explanation: string
  tone: 'neutral' | 'info' | 'warning' | 'success' | 'danger'
}

/** The honest wording of each status. `COLLECTED` is never described as sent to, or received by, Equity. */
export function describeKycStatus(
  status: KycApplicationStatus,
  decisionReason?: string | null,
): KycStatusWording {
  switch (status) {
    case 'DRAFT':
      return {
        label: 'Draft',
        explanation: 'You are still filling this in. Nothing has been submitted.',
        tone: 'neutral',
      }
    case 'COLLECTED':
      return {
        label: 'Submitted to OuPay',
        explanation:
          'OuPay has your information and will review it. It has not been sent to Equity, and Equity has not received, reviewed or approved it.',
        tone: 'info',
      }
    case 'HANDED_OFF':
      return {
        label: 'Handed to Equity',
        explanation:
          'OuPay has recorded evidence that your application was handed to Equity. Equity has not yet recorded a decision.',
        tone: 'info',
      }
    case 'MORE_INFO_REQUESTED':
      return {
        label: 'More information needed',
        explanation:
          'Equity asked for more information. Answer the requests below to send it back to OuPay.',
        tone: 'warning',
      }
    case 'APPROVED':
      return {
        label: 'Approved by Equity',
        explanation: 'OuPay has recorded evidence that Equity approved this application.',
        tone: 'success',
      }
    case 'REJECTED':
      return {
        label: 'Not approved by Equity',
        explanation: decisionReason
          ? `OuPay has recorded evidence that Equity did not approve this application. Reason given: ${decisionReason}`
          : 'OuPay has recorded evidence that Equity did not approve this application.',
        tone: 'danger',
      }
  }
}

/** Last four characters of an identifier shown as a hint; never more. */
export const maskedHint = (value: string) => `••••${value.slice(-4)}`
