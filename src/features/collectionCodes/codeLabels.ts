import { COLLECTION_CODE_STATUS_HINTS } from '@/constants/collectionCodes'
import type { CodeAssignment, CollectionCodeStatus } from '@/types/collectionCodes'

export function statusHint(status: CollectionCodeStatus) {
  return COLLECTION_CODE_STATUS_HINTS[status]
}

/** "Aline Uwase (cashier)" or "Front desk (collection point)". */
export function assigneeLabel(assignment: CodeAssignment | null) {
  if (!assignment) return 'Nobody yet'
  return assignment.assigneeKind === 'MEMBER'
    ? `${assignment.assigneeName}${assignment.assigneeRole ? ` (${assignment.assigneeRole.toLowerCase()})` : ''}`
    : `${assignment.assigneeName} (collection point)`
}
