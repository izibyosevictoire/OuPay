import { Building2, ChevronDown, LifeBuoy, LogOut, PlusCircle, Settings } from 'lucide-react'
import { Link, useNavigate } from 'react-router-dom'
import { useAuth } from '@/app/providers/AuthProvider'
import { useBusinessContext } from '@/app/providers/BusinessContextProvider'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { BUSINESS_ROLE_LABELS } from '@/constants/auth'
import { PermissionGuard } from '@/features/auth/permissions/PermissionGuard'
import { useMerchantsForCurrentUser } from '@/features/merchants/useMerchantQueries'

const initialsOf = (fullName: string) =>
  fullName
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join('')

export function AccountMenu() {
  const { user, logout } = useAuth()
  const { availableMemberships, currentMembership, selectedMerchantId, selectMerchant } =
    useBusinessContext()
  const merchantsQuery = useMerchantsForCurrentUser()
  const navigate = useNavigate()

  if (!user) return null

  const merchantName = (merchantId: string) => {
    const merchant = merchantsQuery.data?.find((candidate) => candidate.id === merchantId)
    return merchant ? (merchant.tradingName ?? merchant.legalName) : 'Business'
  }
  const roleLabel = currentMembership ? BUSINESS_ROLE_LABELS[currentMembership.role] : null

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className="flex min-h-10 items-center gap-2 rounded-md px-1.5 hover:bg-muted sm:px-2">
        <span
          className="flex size-8 items-center justify-center rounded-full bg-accent text-xs font-semibold text-accent-foreground"
          aria-hidden="true"
        >
          {initialsOf(user.fullName)}
        </span>
        <span className="hidden text-left sm:block" aria-hidden="true">
          <span className="block text-sm font-medium leading-tight">{user.fullName}</span>
          {roleLabel && (
            <span className="block text-xs leading-tight text-muted-foreground">{roleLabel}</span>
          )}
        </span>
        <ChevronDown className="hidden size-4 text-muted-foreground sm:block" aria-hidden="true" />
        <span className="sr-only">Account menu for {user.fullName}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-64">
        <DropdownMenuLabel>
          <span className="block">{user.fullName}</span>
          <span className="block text-xs font-normal text-muted-foreground">{user.email}</span>
          {currentMembership && (
            <span className="mt-1 block text-xs font-normal text-muted-foreground">
              {merchantName(currentMembership.merchantId)} · {roleLabel}
            </span>
          )}
        </DropdownMenuLabel>

        {availableMemberships.length > 1 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="text-xs font-medium text-muted-foreground">
              Switch business
            </DropdownMenuLabel>
            <DropdownMenuRadioGroup
              value={selectedMerchantId ?? ''}
              onValueChange={(merchantId) => {
                selectMerchant(merchantId)
                // The new role may not allow the current page, so start from the dashboard.
                navigate('/')
              }}
            >
              {availableMemberships.map((membership) => (
                <DropdownMenuRadioItem key={membership.id} value={membership.merchantId}>
                  <span>
                    <span className="block">{merchantName(membership.merchantId)}</span>
                    <span className="block text-xs text-muted-foreground">
                      {BUSINESS_ROLE_LABELS[membership.role]}
                    </span>
                  </span>
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </>
        )}

        <DropdownMenuSeparator />
        <PermissionGuard permission="profile:view">
          <DropdownMenuItem asChild>
            <Link to="/profile">
              <Building2 aria-hidden="true" /> Business profile
            </Link>
          </DropdownMenuItem>
        </PermissionGuard>
        <DropdownMenuItem asChild>
          <Link to="/onboarding">
            <PlusCircle aria-hidden="true" /> Register a business
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <Link to="/settings">
            <Settings aria-hidden="true" /> Account settings
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem disabled>
          <LifeBuoy aria-hidden="true" /> Help centre
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          // The route guard sends signed-out users to /login, so no navigation here.
          onSelect={() => void logout()}
        >
          <LogOut aria-hidden="true" /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
