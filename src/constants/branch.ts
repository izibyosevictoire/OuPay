import type { BranchStatus } from '@/types/branch'

export const BRANCH_STATUS_LABELS: Record<BranchStatus, string> = {
  ACTIVE: 'Active',
  INACTIVE: 'Inactive',
}

export const BRANCH_STATUS_DESCRIPTIONS: Record<BranchStatus, string> = {
  ACTIVE: 'Can receive staff assignments and, in future, new invoices.',
  INACTIVE: 'Keeps all history, but cannot receive new staff assignments or new invoices.',
}
