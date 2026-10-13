import type { BusinessRole } from '@/types/auth'
import {
  PERMISSION_DEFINITIONS,
  type Permission,
  type PermissionScope,
} from './permissionDefinitions'

/** A record that may be assigned to a specific user, e.g. an invoice or transaction. */
export interface AssignableResource {
  assignedUserId?: string
}

export function getPermissionScope(
  role: BusinessRole | null | undefined,
  permission: Permission,
): PermissionScope | null {
  if (!role) return null
  return PERMISSION_DEFINITIONS[permission][role]
}

export function hasPermission(
  role: BusinessRole | null | undefined,
  permission: Permission,
): boolean {
  return getPermissionScope(role, permission) !== null
}

/**
 * Resource-scoped check: with `all` scope any record passes; with `limited` scope the
 * record must be assigned to the acting user.
 */
export function canAccessResource(
  role: BusinessRole | null | undefined,
  permission: Permission,
  resource: AssignableResource,
  userId: string | null | undefined,
): boolean {
  const scope = getPermissionScope(role, permission)
  if (scope === 'all') return true
  if (scope === 'limited') return Boolean(userId) && resource.assignedUserId === userId
  return false
}
