import type { BusinessRole } from '@/types/auth'
import type { Permission } from './permissionDefinitions'
import { canAccessResource, getPermissionScope, hasPermission } from './permissions'

// Written out independently of the definitions file, straight from the product requirements.
const EXPECTED_MATRIX: [Permission, Record<BusinessRole, 'all' | 'limited' | null>][] = [
  ['dashboard:view', { OWNER: 'all', MANAGER: 'all', CASHIER: 'limited' }],
  ['profile:view', { OWNER: 'all', MANAGER: 'all', CASHIER: 'limited' }],
  ['profile:edit', { OWNER: 'all', MANAGER: null, CASHIER: null }],
  ['invoices:view', { OWNER: 'all', MANAGER: 'all', CASHIER: 'limited' }],
  ['invoices:create', { OWNER: 'all', MANAGER: 'all', CASHIER: 'all' }],
  ['invoices:void', { OWNER: 'all', MANAGER: null, CASHIER: null }],
  ['transactions:view', { OWNER: 'all', MANAGER: 'all', CASHIER: 'limited' }],
  ['payments:view_confirmations', { OWNER: 'all', MANAGER: 'all', CASHIER: 'limited' }],
  ['payments:reconcile', { OWNER: 'all', MANAGER: 'all', CASHIER: null }],
  ['payment_profiles:view', { OWNER: 'all', MANAGER: 'all', CASHIER: 'limited' }],
  ['payment_profiles:manage', { OWNER: 'all', MANAGER: 'all', CASHIER: null }],
  ['branches:manage', { OWNER: 'all', MANAGER: 'all', CASHIER: null }],
  ['cashiers:manage', { OWNER: 'all', MANAGER: 'all', CASHIER: null }],
  ['membership:manage', { OWNER: 'all', MANAGER: null, CASHIER: null }],
  ['catalog:view', { OWNER: 'all', MANAGER: 'all', CASHIER: 'all' }],
  ['catalog:manage', { OWNER: 'all', MANAGER: 'all', CASHIER: null }],
  ['inventory:view', { OWNER: 'all', MANAGER: 'all', CASHIER: 'limited' }],
  ['inventory:receive', { OWNER: 'all', MANAGER: 'limited', CASHIER: null }],
  ['inventory:adjust', { OWNER: 'all', MANAGER: 'limited', CASHIER: null }],
  ['collection_codes:view', { OWNER: 'all', MANAGER: 'all', CASHIER: null }],
  ['collection_codes:assign', { OWNER: 'all', MANAGER: 'limited', CASHIER: null }],
  ['collection_codes:manage', { OWNER: 'all', MANAGER: null, CASHIER: null }],
  ['reports:view', { OWNER: 'all', MANAGER: 'all', CASHIER: null }],
  ['banking:manage', { OWNER: 'all', MANAGER: null, CASHIER: null }],
]

describe('permission definitions', () => {
  it.each(EXPECTED_MATRIX)('%s matches the product matrix', (permission, expected) => {
    for (const role of ['OWNER', 'MANAGER', 'CASHIER'] as const) {
      expect(getPermissionScope(role, permission)).toBe(expected[role])
      expect(hasPermission(role, permission)).toBe(expected[role] !== null)
    }
  })

  it('denies everything when there is no role', () => {
    for (const [permission] of EXPECTED_MATRIX) {
      expect(hasPermission(null, permission)).toBe(false)
      expect(hasPermission(undefined, permission)).toBe(false)
    }
  })
})

describe('resource-scoped access', () => {
  it('lets owners and managers open any invoice', () => {
    for (const role of ['OWNER', 'MANAGER'] as const) {
      expect(
        canAccessResource(role, 'invoices:view', { assignedUserId: 'someone-else' }, 'me'),
      ).toBe(true)
      expect(canAccessResource(role, 'invoices:view', {}, 'me')).toBe(true)
    }
  })

  it('lets a cashier open only invoices assigned to them', () => {
    expect(canAccessResource('CASHIER', 'invoices:view', { assignedUserId: 'me' }, 'me')).toBe(true)
    expect(canAccessResource('CASHIER', 'invoices:view', { assignedUserId: 'other' }, 'me')).toBe(
      false,
    )
    expect(canAccessResource('CASHIER', 'invoices:view', {}, 'me')).toBe(false)
  })

  it('never grants a limited role access without a known user', () => {
    expect(
      canAccessResource('CASHIER', 'invoices:view', { assignedUserId: undefined }, undefined),
    ).toBe(false)
  })

  it('denies resources for permissions the role lacks entirely', () => {
    expect(canAccessResource('CASHIER', 'reports:view', { assignedUserId: 'me' }, 'me')).toBe(false)
  })
})
