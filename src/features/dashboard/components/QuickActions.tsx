import { FileText, Plus, UserPlus, type LucideIcon } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import type { Permission } from '@/features/auth/permissions/permissionDefinitions'
import { hasPermission } from '@/features/auth/permissions/permissions'
import { useCurrentRole } from '@/features/auth/permissions/usePermission'

interface QuickAction {
  label: string
  path: string
  icon: LucideIcon
  permission: Permission
}

// Destinations are placeholders until those modules are built.
const QUICK_ACTIONS: QuickAction[] = [
  { label: 'Create invoice', path: '/invoices/new', icon: Plus, permission: 'invoices:create' },
  {
    label: 'Verify a payment',
    path: '/payments',
    icon: FileText,
    permission: 'payments:view_confirmations',
  },
  { label: 'Add cashier', path: '/cashiers', icon: UserPlus, permission: 'cashiers:manage' },
]

export function QuickActions() {
  const role = useCurrentRole()
  const actions = QUICK_ACTIONS.filter(({ permission }) => hasPermission(role, permission))
  if (actions.length === 0) return null
  return (
    <Card>
      <CardHeader>
        <CardTitle>Quick actions</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {actions.map(({ label, path, icon: Icon }, index) => (
          <Button
            key={label}
            asChild
            variant={index === 0 ? 'default' : 'outline'}
            className="justify-start"
          >
            <Link to={path}>
              <Icon aria-hidden="true" />
              {label}
            </Link>
          </Button>
        ))}
      </CardContent>
    </Card>
  )
}
