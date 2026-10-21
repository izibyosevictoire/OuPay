import { NavLink } from 'react-router-dom'
import { PRIMARY_NAVIGATION } from '@/constants/navigation'
import { useCurrentRole } from '@/features/auth/permissions/usePermission'
import { useCurrentMerchant } from '@/features/merchants/useMerchantQueries'
import { getPermissionScope } from '@/features/auth/permissions/permissions'
import { cn } from '@/lib/utils'

interface NavigationLinksProps {
  onNavigate?: () => void
}

/** Only items the current role may open are shown; unauthorized destinations never appear. */
export function NavigationLinks({ onNavigate }: NavigationLinksProps) {
  const role = useCurrentRole()
  const merchant = useCurrentMerchant().data
  const visibleItems = PRIMARY_NAVIGATION.flatMap((item) => {
    // A mode-specific entry needs the business's mode to be known AND to match: while it loads, nothing flashes in.
    if (item.requiresMode && merchant?.operatingMode !== item.requiresMode) return []
    const scope = item.permission ? getPermissionScope(role, item.permission) : 'all'
    if (!scope) return []
    return [
      { ...item, label: scope === 'limited' && item.limitedLabel ? item.limitedLabel : item.label },
    ]
  })

  return (
    <nav aria-label="Primary">
      <ul className="flex flex-col gap-1">
        {visibleItems.map(({ label, path, icon: Icon }) => (
          <li key={path}>
            <NavLink
              to={path}
              end={path === '/'}
              onClick={onNavigate}
              className={({ isActive }) =>
                cn(
                  'flex min-h-10 items-center gap-3 rounded-md px-3 text-sm font-medium transition-colors',
                  isActive
                    ? 'bg-accent text-accent-foreground'
                    : 'text-muted-foreground hover:bg-muted hover:text-foreground',
                )
              }
            >
              <Icon className="size-[18px] shrink-0" aria-hidden="true" />
              {label}
            </NavLink>
          </li>
        ))}
      </ul>
    </nav>
  )
}
