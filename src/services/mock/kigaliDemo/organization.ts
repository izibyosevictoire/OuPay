// DEMO DATA ONLY (R9c). One fictional business, its people and its branches. Nothing here is a real business, person, bank account or
// payment, and none of it ever leaves the browser.
import type { BusinessMembership, User } from '@/types/auth'
import type { Branch, BranchAssignment } from '@/types/branch'
import type { Merchant } from '@/types/merchant'
import type { StaffInvitation } from '@/types/staff'

import { KIGALI_DEMO_ACCOUNTS, type DemoRoleKey } from '@/lib/demoAccounts'

export { KIGALI_DEMO_PASSWORD } from '@/lib/demoAccounts'

export const KD = {
  merchantId: 'kd-mrc-001',
  users: { owner: 'kd-usr-owner', manager: 'kd-usr-manager', cashier: 'kd-usr-cashier' },
  memberships: { owner: 'kd-mem-001', manager: 'kd-mem-002', cashier: 'kd-mem-003' },
  branches: { main: 'kd-brn-001', remera: 'kd-brn-002', kimironko: 'kd-brn-003' },
} as const

const personOf = (key: DemoRoleKey) => {
  const account = KIGALI_DEMO_ACCOUNTS.find((a) => a.key === key)!
  return { id: KD.users[key], name: account.name, email: account.email, phone: account.phone }
}

export const KD_PEOPLE = { owner: personOf('owner'), manager: personOf('manager'), cashier: personOf('cashier') } as const

const CREATED = '2026-10-01T08:00:00+02:00'

export const KIGALI_DEMO_MERCHANT_NAME = 'Kigali Demo Supermarket'

export const KIGALI_MERCHANTS: Merchant[] = [
  {
    id: KD.merchantId,
    ownerUserId: KD.users.owner,
    legalName: 'Kigali Demo Supermarket Ltd (demonstration)',
    tradingName: KIGALI_DEMO_MERCHANT_NAME,
    businessType: 'registered_company',
    status: 'active',
    operatingMode: 'BUSINESS',
    registration: { registrationNumber: 'DEMO-RDB-000001', tin: '100000099' },
    location: {
      country: 'RW',
      province: 'Kigali City',
      district: 'Nyarugenge',
      sector: 'Nyarugenge',
      physicalAddress: 'KN 4 Ave (demonstration data)',
    },
    contact: { fullName: KD_PEOPLE.owner.name, email: KD_PEOPLE.owner.email, phoneNumber: KD_PEOPLE.owner.phone },
    bankingConfiguration: { status: 'not_configured' },
    createdAt: CREATED,
    updatedAt: CREATED,
  },
]

const user = (p: { id: string; name: string; email: string; phone: string }): User => ({
  id: p.id,
  fullName: p.name,
  email: p.email,
  phoneNumber: p.phone,
  status: 'ACTIVE',
  createdAt: CREATED,
  updatedAt: CREATED,
})

export const KIGALI_USERS: User[] = [user(KD_PEOPLE.owner), user(KD_PEOPLE.manager), user(KD_PEOPLE.cashier)]

const membership = (id: string, userId: string, role: BusinessMembership['role']): BusinessMembership => ({
  id,
  userId,
  merchantId: KD.merchantId,
  role,
  status: 'ACTIVE',
  createdAt: CREATED,
  updatedAt: CREATED,
})

export const KIGALI_MEMBERSHIPS: BusinessMembership[] = [
  membership(KD.memberships.owner, KD.users.owner, 'OWNER'),
  membership(KD.memberships.manager, KD.users.manager, 'MANAGER'),
  membership(KD.memberships.cashier, KD.users.cashier, 'CASHIER'),
]

const branch = (id: string, name: string, code: string, district: string, sector: string, address: string, phone: string): Branch => ({
  id,
  merchantId: KD.merchantId,
  name,
  code,
  location: { province: 'Kigali City', district, sector, physicalAddress: address },
  contactPhone: phone,
  status: 'ACTIVE',
  createdAt: '2026-10-01T09:00:00+02:00',
  updatedAt: '2026-10-01T09:00:00+02:00',
})

export const KIGALI_BRANCHES: Branch[] = [
  branch(KD.branches.main, 'Kigali Main', 'KGM1', 'Nyarugenge', 'Nyarugenge', 'KN 4 Ave (demonstration data)', '+250788100101'),
  branch(KD.branches.remera, 'Remera', 'RMR2', 'Gasabo', 'Remera', 'KG 11 Ave (demonstration data)', '+250788100102'),
  branch(KD.branches.kimironko, 'Kimironko', 'KMR3', 'Gasabo', 'Kimironko', 'KG 19 Ave (demonstration data)', '+250788100103'),
]

const assignment = (id: string, membershipId: string, branchId: string): BranchAssignment => ({
  id,
  merchantId: KD.merchantId,
  membershipId,
  branchId,
  status: 'ACTIVE',
  createdAt: '2026-10-01T09:30:00+02:00',
  updatedAt: '2026-10-01T09:30:00+02:00',
})

/**
 * Who works where. The owner works at every branch (so the owner can prepare carts anywhere), the manager at Kigali Main and Remera, and the
 * cashier at Kigali Main only: the demo shows that a cashier sees a single branch.
 */
export const KIGALI_BRANCH_ASSIGNMENTS: BranchAssignment[] = [
  assignment('kd-asg-001', KD.memberships.owner, KD.branches.main),
  assignment('kd-asg-002', KD.memberships.owner, KD.branches.remera),
  assignment('kd-asg-003', KD.memberships.owner, KD.branches.kimironko),
  assignment('kd-asg-004', KD.memberships.manager, KD.branches.main),
  assignment('kd-asg-005', KD.memberships.manager, KD.branches.remera),
  assignment('kd-asg-006', KD.memberships.cashier, KD.branches.main),
]

/** No pending invitations: people add their own with the Staff screen. */
export const KIGALI_INVITATIONS: StaffInvitation[] = []
