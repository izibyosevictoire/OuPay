import { z } from 'zod'
import {
  COLLECTION_CODE_MAX_BANK_REF,
  COLLECTION_CODE_MAX_LABEL,
  COLLECTION_CODE_MAX_REASON,
  COLLECTION_POINT_MAX_LABEL,
} from '@/constants/collectionCodes'
import type { AssigneeInput } from '@/types/collectionCodes'

/** UX validation only: the server decides and its answer is always shown. */

export const requestCodeSchema = z.object({
  displayLabel: z
    .string()
    .trim()
    .min(1, 'Enter a label, for example “Remera counter”.')
    .max(COLLECTION_CODE_MAX_LABEL, `Use ${COLLECTION_CODE_MAX_LABEL} characters or fewer.`),
  settlementDestinationId: z.string().min(1, 'Choose the settlement account.'),
  branchId: z.string(),
})
export type RequestCodeFormValues = z.infer<typeof requestCodeSchema>
export const REQUEST_CODE_DEFAULTS: RequestCodeFormValues = {
  displayLabel: '',
  settlementDestinationId: '',
  branchId: '',
}

const reasonField = z
  .string()
  .trim()
  .min(1, 'Give a reason. It is kept in the history.')
  .max(COLLECTION_CODE_MAX_REASON, `Use ${COLLECTION_CODE_MAX_REASON} characters or fewer.`)

export const reasonSchema = z.object({ reason: reasonField })
export type ReasonFormValues = z.infer<typeof reasonSchema>

export const submissionSchema = z.object({
  bankRequestRef: z
    .string()
    .trim()
    .min(1, 'Enter the reference the bank gave you for the request.')
    .max(COLLECTION_CODE_MAX_BANK_REF, `Use ${COLLECTION_CODE_MAX_BANK_REF} characters or fewer.`),
})
export type SubmissionFormValues = z.infer<typeof submissionSchema>

/** Who holds the code: one team member OR one collection point. `reason` is only asked for when replacing someone. */
export const assigneeSchema = z
  .object({
    assigneeKind: z.enum(['MEMBER', 'COLLECTION_POINT']),
    membershipId: z.string(),
    collectionPointLabel: z.string().trim(),
    branchId: z.string(),
    reason: z.string().trim(),
  })
  .superRefine((values, context) => {
    if (values.assigneeKind === 'MEMBER' && !values.membershipId) {
      context.addIssue({ code: 'custom', path: ['membershipId'], message: 'Choose a team member.' })
    }
    if (values.assigneeKind === 'COLLECTION_POINT') {
      if (!values.collectionPointLabel) {
        context.addIssue({
          code: 'custom',
          path: ['collectionPointLabel'],
          message: 'Enter the collection point, for example “Market stall”.',
        })
      } else if (values.collectionPointLabel.length > COLLECTION_POINT_MAX_LABEL) {
        context.addIssue({
          code: 'custom',
          path: ['collectionPointLabel'],
          message: `Use ${COLLECTION_POINT_MAX_LABEL} characters or fewer.`,
        })
      }
    }
    if (values.reason.length > COLLECTION_CODE_MAX_REASON) {
      context.addIssue({
        code: 'custom',
        path: ['reason'],
        message: `Use ${COLLECTION_CODE_MAX_REASON} characters or fewer.`,
      })
    }
  })
export type AssigneeFormValues = z.infer<typeof assigneeSchema>
export const ASSIGNEE_DEFAULTS: AssigneeFormValues = {
  assigneeKind: 'MEMBER',
  membershipId: '',
  collectionPointLabel: '',
  branchId: '',
  reason: '',
}

export function toAssigneeInput(values: AssigneeFormValues): AssigneeInput {
  const input: AssigneeInput =
    values.assigneeKind === 'MEMBER'
      ? { membershipId: values.membershipId }
      : { collectionPointLabel: values.collectionPointLabel }
  if (values.branchId) input.branchId = values.branchId
  return input
}

/** What makes two submissions of the request form "the same", so a retry keeps its identity and an edit gets a new one. */
export const requestSignature = (values: RequestCodeFormValues) =>
  JSON.stringify([values.displayLabel.trim(), values.settlementDestinationId, values.branchId])
