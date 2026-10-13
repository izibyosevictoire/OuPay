// SAMPLE DATA ONLY: demo branches, assignments and invitations.
import type { Branch, BranchAssignment } from '@/types/branch'
import type { StaffInvitation } from '@/types/staff'
import {
  DEMO_INVITE_EXISTING_USER_TOKEN,
  DEMO_INVITE_NEW_USER_TOKEN,
  DEMO_USER_IDS,
} from './sampleAccounts'
import { SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID } from './sampleMerchants'

const CREATED_AT = '2026-09-02T09:00:00+02:00'

export const SAMPLE_BRANCH_IDS = {
  remera: 'brn-sample-001',
  cityCentre: 'brn-sample-002',
  nyamirambo: 'brn-sample-003',
  cafe: 'brn-sample-101',
} as const

export const SAMPLE_BRANCHES: Branch[] = [
  {
    id: SAMPLE_BRANCH_IDS.remera,
    merchantId: SAMPLE_MERCHANT_ID,
    name: 'Remera Main',
    code: 'RM01',
    location: {
      province: 'Kigali City',
      district: 'Gasabo',
      sector: 'Remera',
      physicalAddress: 'KG 11 Ave, near Sample Plaza',
    },
    contactPhone: '+250788000101',
    status: 'ACTIVE',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  },
  {
    id: SAMPLE_BRANCH_IDS.cityCentre,
    merchantId: SAMPLE_MERCHANT_ID,
    name: 'City Centre',
    code: 'KCC',
    location: {
      province: 'Kigali City',
      district: 'Nyarugenge',
      sector: 'Nyarugenge',
      physicalAddress: 'KN 4 Ave',
    },
    status: 'ACTIVE',
    createdAt: '2026-09-05T09:00:00+02:00',
    updatedAt: '2026-09-05T09:00:00+02:00',
  },
  {
    id: SAMPLE_BRANCH_IDS.nyamirambo,
    merchantId: SAMPLE_MERCHANT_ID,
    name: 'Nyamirambo Kiosk',
    code: 'NYA1',
    location: {
      province: 'Kigali City',
      district: 'Nyarugenge',
      sector: 'Nyamirambo',
      physicalAddress: 'Nyamirambo market, stall 12',
    },
    status: 'INACTIVE',
    createdAt: '2026-09-10T09:00:00+02:00',
    updatedAt: '2026-09-20T09:00:00+02:00',
  },
  {
    id: SAMPLE_BRANCH_IDS.cafe,
    merchantId: SAMPLE_SECOND_MERCHANT_ID,
    name: 'Cafe Nyamirambo',
    code: 'CAF1',
    location: {
      province: 'Kigali City',
      district: 'Nyarugenge',
      sector: 'Nyamirambo',
      physicalAddress: 'Nyamirambo main road',
    },
    status: 'ACTIVE',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
  },
]

const assignment = (
  id: string,
  merchantId: string,
  membershipId: string,
  branchId: string,
  status: BranchAssignment['status'] = 'ACTIVE',
): BranchAssignment => ({
  id,
  merchantId,
  membershipId,
  branchId,
  status,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
  ...(status === 'ENDED' ? { endedAt: '2026-09-25T09:00:00+02:00' } : {}),
})

export const SAMPLE_BRANCH_ASSIGNMENTS: BranchAssignment[] = [
  // Aline (cashier) works at two branches.
  assignment('asg-001', SAMPLE_MERCHANT_ID, 'mem-004', SAMPLE_BRANCH_IDS.remera),
  assignment('asg-002', SAMPLE_MERCHANT_ID, 'mem-004', SAMPLE_BRANCH_IDS.cityCentre),
  // Grace (manager).
  assignment('asg-003', SAMPLE_MERCHANT_ID, 'mem-003', SAMPLE_BRANCH_IDS.remera),
  // Eric is suspended; his assignment is to a branch that is now inactive (history stays).
  assignment('asg-004', SAMPLE_MERCHANT_ID, 'mem-005', SAMPLE_BRANCH_IDS.nyamirambo),
  // Diane was revoked, so her assignment ended.
  assignment('asg-005', SAMPLE_MERCHANT_ID, 'mem-006', SAMPLE_BRANCH_IDS.cityCentre, 'ENDED'),
  // The owner of the first business works as a cashier at the cafe.
  assignment('asg-006', SAMPLE_SECOND_MERCHANT_ID, 'mem-002', SAMPLE_BRANCH_IDS.cafe),
]

export const SAMPLE_INVITATIONS: StaffInvitation[] = [
  {
    id: 'inv-staff-001',
    merchantId: SAMPLE_MERCHANT_ID,
    email: 'invitee@oupay.demo',
    role: 'MANAGER',
    branchIds: [SAMPLE_BRANCH_IDS.remera],
    note: 'Welcome aboard! You will help run the Remera branch.',
    membershipId: 'mem-008',
    invitedByUserId: DEMO_USER_IDS.owner,
    status: 'PENDING',
    demoToken: DEMO_INVITE_EXISTING_USER_TOKEN,
    createdAt: '2026-10-08T09:00:00+02:00',
    updatedAt: '2026-10-08T09:00:00+02:00',
  },
  {
    id: 'inv-staff-002',
    merchantId: SAMPLE_MERCHANT_ID,
    email: 'new.hire@example.rw',
    role: 'CASHIER',
    branchIds: [SAMPLE_BRANCH_IDS.cityCentre],
    membershipId: 'mem-009',
    invitedByUserId: DEMO_USER_IDS.owner,
    status: 'PENDING',
    demoToken: DEMO_INVITE_NEW_USER_TOKEN,
    createdAt: '2026-10-09T09:00:00+02:00',
    updatedAt: '2026-10-09T09:00:00+02:00',
  },
]
