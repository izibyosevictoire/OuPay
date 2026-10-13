import { ShieldX } from 'lucide-react'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/common/PageHeader'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { BUSINESS_ROLE_LABELS } from '@/constants/auth'
import { useCurrentRole } from '../permissions/usePermission'

/** 403: the user is signed in and belongs to the business, but their role lacks this capability. */
export function ForbiddenPage() {
  const role = useCurrentRole()
  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title="Access denied"
        description="Error 403: you do not have permission to view this page."
      />
      <Card>
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <span className="flex size-10 items-center justify-center rounded-full bg-danger-soft text-danger">
            <ShieldX className="size-5" aria-hidden="true" />
          </span>
          <p className="text-sm font-medium">This page is not available for your role</p>
          <p className="max-w-sm text-xs text-muted-foreground">
            {role ? `You are signed in as ${BUSINESS_ROLE_LABELS[role]} in this business. ` : ''}
            Ask a business owner if you need access.
          </p>
          <Button asChild variant="outline" className="mt-3">
            <Link to="/">Back to dashboard</Link>
          </Button>
        </div>
      </Card>
    </div>
  )
}
