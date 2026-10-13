// DEMO-ONLY accounts. These are public, fake credentials for exercising the mock auth
// service. They protect nothing and must never be reused as real passwords.
import type { BusinessMembership, User } from '@/types/auth'
import { SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID, SAMPLE_USER_ID } from './sampleMerchants'

export const DEMO_PASSWORD = 'DemoPass123!'

export const DEMO_USER_IDS = {
  owner: SAMPLE_USER_ID,
  manager: 'usr-demo-manager',
  cashier: 'usr-demo-cashier',
  suspended: 'usr-demo-suspended',
  revoked: 'usr-demo-revoked',
  newcomer: 'usr-demo-newcomer',
  /** Owner of the second business, so it has its own people. */
  cafeOwner: 'usr-demo-cafe-owner',
  /** Existing account with a pending invitation to the first business. */
  invitee: 'usr-demo-invitee',
  /** Invited by email only: no usable account until the invitation is accepted. */
  pendingHire: 'usr-demo-pending-hire',
} as const

/** Demo invitation links (mock tokens, not secure). */
export const DEMO_INVITE_EXISTING_USER_TOKEN = 'demo-invite-existing'
export const DEMO_INVITE_NEW_USER_TOKEN = 'demo-invite-new'

/** Mock-only triggers for deterministic outcomes. */
export const DEMO_OUTAGE_EMAIL = 'outage@oupay.demo'
export const DEMO_VALID_RESET_TOKEN = 'demo-valid-token'
export const DEMO_EXPIRED_RESET_TOKEN = 'demo-expired-token'
/** The account whose demo password the valid reset token changes. */
export const DEMO_RESET_TARGET_EMAIL = 'owner@oupay.demo'

const CREATED_AT = '2026-09-01T08:00:00+02:00'

const demoUser = (id: string, fullName: string, email: string, phone: string): User => ({
  id,
  fullName,
  email,
  phoneNumber: phone,
  status: 'ACTIVE',
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
})

export const DEMO_USERS: User[] = [
  demoUser(DEMO_USER_IDS.owner, 'Sample Owner', 'owner@oupay.demo', '+250788000001'),
  demoUser(DEMO_USER_IDS.manager, 'Grace Mukamana', 'manager@oupay.demo', '+250788000002'),
  demoUser(DEMO_USER_IDS.cashier, 'Aline Uwase', 'cashier@oupay.demo', '+250788000003'),
  demoUser(DEMO_USER_IDS.suspended, 'Eric Niyonzima', 'suspended@oupay.demo', '+250788000004'),
  demoUser(DEMO_USER_IDS.revoked, 'Diane Ingabire', 'revoked@oupay.demo', '+250788000005'),
  demoUser(DEMO_USER_IDS.newcomer, 'Patrick Nshuti', 'newcomer@oupay.demo', '+250788000006'),
  demoUser(DEMO_USER_IDS.cafeOwner, 'Claudine Mukashema', 'cafe-owner@oupay.demo', '+250788000007'),
  demoUser(DEMO_USER_IDS.invitee, 'Olivier Habineza', 'invitee@oupay.demo', '+250788000008'),
  {
    // Invited by email only: no name or phone yet, and no way to sign in until acceptance.
    ...demoUser(DEMO_USER_IDS.pendingHire, 'new.hire@example.rw', 'new.hire@example.rw', ''),
    status: 'PENDING',
  },
]

const membership = (
  id: string,
  userId: string,
  merchantId: string,
  role: BusinessMembership['role'],
  status: BusinessMembership['status'],
): BusinessMembership => ({
  id,
  userId,
  merchantId,
  role,
  status,
  createdAt: CREATED_AT,
  updatedAt: CREATED_AT,
})

export const DEMO_MEMBERSHIPS: BusinessMembership[] = [
  // One user, two businesses, two roles: owner of the first, cashier of the second.
  membership('mem-001', DEMO_USER_IDS.owner, SAMPLE_MERCHANT_ID, 'OWNER', 'ACTIVE'),
  membership('mem-002', DEMO_USER_IDS.owner, SAMPLE_SECOND_MERCHANT_ID, 'CASHIER', 'ACTIVE'),
  membership('mem-003', DEMO_USER_IDS.manager, SAMPLE_MERCHANT_ID, 'MANAGER', 'ACTIVE'),
  membership('mem-004', DEMO_USER_IDS.cashier, SAMPLE_MERCHANT_ID, 'CASHIER', 'ACTIVE'),
  membership('mem-005', DEMO_USER_IDS.suspended, SAMPLE_MERCHANT_ID, 'CASHIER', 'SUSPENDED'),
  membership('mem-006', DEMO_USER_IDS.revoked, SAMPLE_MERCHANT_ID, 'MANAGER', 'REVOKED'),
  membership('mem-007', DEMO_USER_IDS.cafeOwner, SAMPLE_SECOND_MERCHANT_ID, 'OWNER', 'ACTIVE'),
  // Pending invitations: INVITED until accepted, never ACTIVE by default.
  membership('mem-008', DEMO_USER_IDS.invitee, SAMPLE_MERCHANT_ID, 'MANAGER', 'INVITED'),
  membership('mem-009', DEMO_USER_IDS.pendingHire, SAMPLE_MERCHANT_ID, 'CASHIER', 'INVITED'),
]

/** Demo accounts listed on the login screen. */
export const DEMO_ACCOUNT_DESCRIPTIONS = [
  { email: 'owner@oupay.demo', description: 'Owner of one business, cashier at another' },
  { email: 'manager@oupay.demo', description: 'Manager' },
  { email: 'cashier@oupay.demo', description: 'Cashier (assigned records only)' },
  { email: 'suspended@oupay.demo', description: 'Suspended membership' },
  { email: 'revoked@oupay.demo', description: 'Revoked membership' },
  { email: 'newcomer@oupay.demo', description: 'No business yet (goes to onboarding)' },
  { email: 'cafe-owner@oupay.demo', description: 'Owner of Sample Corner Cafe' },
  { email: 'invitee@oupay.demo', description: 'Has a pending invitation (manager)' },
] as const
