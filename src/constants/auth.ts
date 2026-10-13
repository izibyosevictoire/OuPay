import type { BusinessRole, MembershipStatus } from '@/types/auth'

export const BUSINESS_ROLE_LABELS: Record<BusinessRole, string> = {
  OWNER: 'Owner',
  MANAGER: 'Manager',
  CASHIER: 'Cashier',
}

export const MEMBERSHIP_STATUS_LABELS: Record<MembershipStatus, string> = {
  INVITED: 'Invited',
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  REVOKED: 'Revoked',
}
