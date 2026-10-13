import { Lock } from 'lucide-react'
import { Link, useParams } from 'react-router-dom'
import { useAuth } from '@/app/providers/AuthProvider'
import { EmptyState } from '@/components/common/EmptyState'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { useCurrentRole } from '@/features/auth/permissions/usePermission'
import { InvoiceServiceError } from '@/services/invoiceService'
import { canPerformInvoiceAction } from './invoicePolicy'
import { InvoiceForm } from './InvoiceForm'
import { InvoiceNotFound } from './InvoiceDetailsPage'
import { useInvoice, useInvoiceFormOptions } from './useInvoiceQueries'

export function EditInvoicePage() {
  const { invoiceId = '' } = useParams()
  const invoiceQuery = useInvoice(invoiceId)
  const optionsQuery = useInvoiceFormOptions()
  const role = useCurrentRole()
  const { user } = useAuth()

  if (
    invoiceQuery.error instanceof InvoiceServiceError &&
    invoiceQuery.error.code === 'not_found'
  ) {
    return <InvoiceNotFound />
  }

  // One boundary for the invoice and the options it can be edited with.
  const combined = {
    data:
      invoiceQuery.data && optionsQuery.data
        ? { invoice: invoiceQuery.data, options: optionsQuery.data }
        : undefined,
    isPending: invoiceQuery.isPending || optionsQuery.isPending,
    isError: invoiceQuery.isError || optionsQuery.isError,
    refetch: () => Promise.all([invoiceQuery.refetch(), optionsQuery.refetch()]),
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title={invoiceQuery.data ? `Edit ${invoiceQuery.data.invoiceNumber}` : 'Edit invoice'}
        description="Only drafts can be edited."
      />
      <QueryBoundary
        query={combined}
        loadingFallback={<Skeleton className="h-96 w-full" />}
        errorMessage="This invoice could not be loaded."
      >
        {({ invoice, options }) =>
          canPerformInvoiceAction(role, user?.id, invoice, 'edit_draft') ? (
            <InvoiceForm
              invoice={invoice}
              options={options}
              fixedAssigneeUserId={role === 'CASHIER' ? user?.id : undefined}
            />
          ) : (
            <Card>
              <EmptyState
                icon={Lock}
                title="This invoice can no longer be edited"
                description="Issued, cancelled and voided invoices keep their amounts and customer details."
              />
              <div className="flex justify-center pb-8">
                <Button asChild variant="outline">
                  <Link to={`/invoices/${invoice.id}`}>View invoice</Link>
                </Button>
              </div>
            </Card>
          )
        }
      </QueryBoundary>
    </div>
  )
}
