import type { ReactNode } from 'react'
import type { Permission } from './permissionDefinitions'
import type { AssignableResource } from './permissions'
import { usePermission, useResourceAccess } from './usePermission'

interface PermissionGuardProps {
  permission: Permission
  /** When given, a `limited` scope only passes if the record is assigned to the user. */
  resource?: AssignableResource
  /** Rendered when access is denied. Defaults to nothing: unauthorized actions are hidden. */
  fallback?: ReactNode
  children: ReactNode
}

/** Hides UI the user may not use. This is presentation only, never a security boundary. */
export function PermissionGuard({
  permission,
  resource,
  fallback = null,
  children,
}: PermissionGuardProps) {
  const { isAllowed } = usePermission(permission)
  const canAccess = useResourceAccess(permission)
  const permitted = resource ? canAccess(resource) : isAllowed
  return <>{permitted ? children : fallback}</>
}
