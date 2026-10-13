import { useAuth } from '@/app/providers/AuthProvider'
import { useBusinessContext } from '@/app/providers/BusinessContextProvider'
import type { Permission, PermissionScope } from './permissionDefinitions'
import {
  canAccessResource,
  getPermissionScope,
  hasPermission,
  type AssignableResource,
} from './permissions'

/** The signed-in user's role in the currently selected business. */
export function useCurrentRole() {
  return useBusinessContext().currentMembership?.role ?? null
}

export function usePermission(permission: Permission): {
  isAllowed: boolean
  scope: PermissionScope | null
} {
  const role = useCurrentRole()
  return { isAllowed: hasPermission(role, permission), scope: getPermissionScope(role, permission) }
}

/** Returns a checker for resource-scoped rules, e.g. "may I open this invoice?". */
export function useResourceAccess(permission: Permission) {
  const role = useCurrentRole()
  const { user } = useAuth()
  return (resource: AssignableResource) => canAccessResource(role, permission, resource, user?.id)
}
