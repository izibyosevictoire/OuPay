import type { BusinessMembership } from '@/types/auth'

/**
 * Which business the user is currently working in, derived from their ACTIVE memberships.
 * Frontend convenience only: enforcing that a user may access a business is the backend's
 * job, and the frontend must never be treated as the authorization boundary.
 */
export interface BusinessContextValue {
  /** Memberships that currently grant access; suspended, revoked and invited ones are excluded. */
  availableMemberships: BusinessMembership[]
  /** Always one of `availableMemberships`, or null when the user has no usable business. */
  selectedMerchantId: string | null
  currentMembership: BusinessMembership | null
  /** Ignored unless the ID belongs to an available membership. */
  selectMerchant: (merchantId: string) => void
}
