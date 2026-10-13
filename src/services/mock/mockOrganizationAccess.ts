import { hasPermission } from '@/features/auth/permissions/permissions'
import type { Permission } from '@/features/auth/permissions/permissionDefinitions'
import { OrganizationServiceError } from '@/services/organizationService'
import type { BusinessMembership, User } from '@/types/auth'
import type { MockAuthStore } from './mockAuthStore'

export interface Actor {
  user: User
  membership: BusinessMembership
}

/**
 * MOCK-ONLY authorization shared by the branch and staff services. Every call must pass
 * through here, so a component that asks for another merchant's data gets "not found"
 * even if it skips its own filtering. A real backend must perform the equivalent checks.
 *
 * - Not signed in -> `unauthenticated`.
 * - No ACTIVE membership in the merchant -> `not_found` (indistinguishable from a
 *   business that does not exist, so nothing is revealed).
 * - Missing permission -> `forbidden`.
 */
export function requireActor(
  store: MockAuthStore,
  merchantId: string,
  permission?: Permission,
): Actor {
  const session = store.readSession()
  if (!session) throw new OrganizationServiceError('unauthenticated', 'Please sign in to continue.')

  const user = store.loadUsers().find((candidate) => candidate.id === session.userId)
  const membership = store
    .loadMemberships()
    .find(
      (candidate) =>
        candidate.userId === session.userId &&
        candidate.merchantId === merchantId &&
        candidate.status === 'ACTIVE',
    )
  if (!user || !membership) {
    throw new OrganizationServiceError('not_found', 'This business could not be found.')
  }
  if (permission && !hasPermission(membership.role, permission)) {
    throw new OrganizationServiceError('forbidden', 'You do not have permission to do that.')
  }
  return { user, membership }
}

/** Runs an operation after a simulated network delay; thrown errors become rejections. */
export function createOperationRunner(delayInMilliseconds: number) {
  return async function run<T>(operation: () => T): Promise<T> {
    await new Promise((resolve) => setTimeout(resolve, delayInMilliseconds))
    return structuredClone(operation())
  }
}
