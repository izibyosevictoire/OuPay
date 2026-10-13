import type {
  Branch,
  BranchAssignment,
  BranchDetails,
  BranchStatus,
  BranchSummary,
  CreateBranchInput,
  UpdateBranchInput,
} from '@/types/branch'

/**
 * Every method takes the merchant explicitly and must verify that the signed-in user has a
 * suitable ACTIVE membership in it. The mock does this; a real backend must do it
 * independently, because the browser can send any merchant ID.
 */
export interface BranchService {
  listBranches(merchantId: string): Promise<BranchSummary[]>
  getBranch(merchantId: string, branchId: string): Promise<BranchDetails>
  createBranch(merchantId: string, input: CreateBranchInput): Promise<Branch>
  /** `id` and `merchantId` can never change. */
  updateBranch(merchantId: string, branchId: string, input: UpdateBranchInput): Promise<Branch>
  /** Deactivating keeps every historical record; it only blocks new assignments and invoices. */
  changeBranchStatus(merchantId: string, branchId: string, status: BranchStatus): Promise<Branch>
  listBranchAssignments(
    merchantId: string,
    filter?: { membershipId?: string; branchId?: string },
  ): Promise<BranchAssignment[]>
  /**
   * Replaces a member's set of ACTIVE branch assignments. Only ACTIVE branches can be newly
   * assigned; existing assignments to inactive branches may be kept or removed.
   */
  updateBranchAssignments(
    merchantId: string,
    membershipId: string,
    branchIds: string[],
  ): Promise<BranchAssignment[]>
}
