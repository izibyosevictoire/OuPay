import type { BusinessRole, MembershipStatus } from './auth'
import type { MerchantOwned } from './merchant'

/**
 * ACTIVE branches can receive new assignments and, in future modules, new invoices.
 * INACTIVE branches keep all historical records but accept nothing new.
 */
export type BranchStatus = 'ACTIVE' | 'INACTIVE'

export interface BranchLocation {
  province: string
  district: string
  sector: string
  physicalAddress: string
}

export interface Branch extends MerchantOwned {
  /** Immutable: never changes after creation, so future records can reference it safely. */
  id: string
  name: string
  /** Unique within the merchant, stored upper-case, e.g. "RM01". */
  code: string
  location: BranchLocation
  contactPhone?: string
  status: BranchStatus
  createdAt: string
  updatedAt: string
}

export interface BranchSummary extends Branch {
  /** Staff with an ACTIVE assignment to this branch (membership must still be ACTIVE or SUSPENDED). */
  assignedStaffCount: number
}

export type CreateBranchInput = Pick<
  Branch,
  'name' | 'code' | 'location' | 'contactPhone' | 'status'
>

/** Everything editable after creation. Identity (`id`) and status (own action) are not. */
export type UpdateBranchInput = Pick<Branch, 'name' | 'code' | 'location' | 'contactPhone'>

export type BranchAssignmentStatus = 'ACTIVE' | 'ENDED'

/**
 * Connects one business membership to one branch, inside one merchant.
 * Assignments are history, not state: removing someone ends the assignment instead of
 * deleting it, so past activity stays attributable.
 *
 * How this interacts with permissions (not yet enforced for invoices, by design):
 * - The business ROLE (OWNER/MANAGER/CASHIER) decides which kinds of action are allowed.
 *   An assignment never grants extra permissions.
 * - The BRANCH ASSIGNMENT says where someone works. In future modules it is a precondition
 *   for recording sales at a branch (an active assignment to an active branch).
 * - A cashier's `limited` read scope stays "records assigned to me"; being assigned to a
 *   branch does not expose that branch's other records.
 * - Owners and managers have `all` scope across every branch of their business.
 */
export interface BranchAssignment extends MerchantOwned {
  id: string
  membershipId: string
  branchId: string
  status: BranchAssignmentStatus
  createdAt: string
  updatedAt: string
  endedAt?: string
}

/** A person shown on a branch's detail page. */
export interface BranchStaffMember {
  membershipId: string
  fullName: string
  role: BusinessRole
  membershipStatus: MembershipStatus
  assignedAt: string
}

export interface BranchDetails {
  branch: Branch
  assignedStaff: BranchStaffMember[]
}
