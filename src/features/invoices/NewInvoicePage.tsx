import { FilePlus2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useAuth } from '@/app/providers/AuthProvider'
import { EmptyState } from '@/components/common/EmptyState'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useCurrentRole } from '@/features/auth/permissions/usePermission'
import { InvoiceForm } from './InvoiceForm'
import { hasEligibleSeller } from './invoiceOptions'
import { useInvoiceFormOptions } from './useInvoiceQueries'

/** Explains why an invoice cannot be started: nothing eligible to put on it yet. */
export function NoEligibleBranchNotice({ isCashier }: { isCashier: boolean }) {
  return (
    <Card>
      <EmptyState
        icon={FilePlus2}
        title="No branch available for invoicing"
        description={
          isCashier
            ? 'You are not assigned to an active branch yet. Ask a manager to assign you to one.'
            : 'Invoices need an active branch with an assigned cashier. Add a branch and assign staff first.'
        }
      />
      {!isCashier && (
        <div className="flex justify-center gap-2 pb-8">
          <Button asChild variant="outline">
            <Link to="/branches">Branches</Link>
          </Button>
          <Button asChild variant="outline">
            <Link to="/cashiers">Staff</Link>
          </Button>
        </div>
      )}
    </Card>
  )
}

export function NewInvoicePage() {
  const optionsQuery = useInvoiceFormOptions()
  const role = useCurrentRole()
  const { user } = useAuth()

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader title="New invoice" description="Save a draft, or issue it to your customer." />
      <QueryBoundary
        query={optionsQuery}
        loadingFallback={<Skeleton className="h-96 w-full" />}
        errorMessage="The invoice form could not be loaded."
      >
        {(options) =>
          hasEligibleSeller(options) ? (
            <InvoiceForm
              options={options}
              fixedAssigneeUserId={role === 'CASHIER' ? user?.id : undefined}
            />
          ) : (
            <NoEligibleBranchNotice isCashier={role === 'CASHIER'} />
          )
        }
      </QueryBoundary>
    </div>
  )
}
