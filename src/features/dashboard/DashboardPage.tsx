import { Plus } from 'lucide-react'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/common/PageHeader'
import { SampleDataNotice } from '@/components/common/SampleDataNotice'
import { Button } from '@/components/ui/button'
import { PermissionGuard } from '@/features/auth/permissions/PermissionGuard'
import { usePermission } from '@/features/auth/permissions/usePermission'
import { KpiCards } from './components/KpiCards'
import { PaymentActivityChart } from './components/PaymentActivityChart'
import { PaymentMethodBreakdown } from './components/PaymentMethodBreakdown'
import { QuickActions } from './components/QuickActions'
import { RecentInvoices } from './components/RecentInvoices'
import { RecentTransactions } from './components/RecentTransactions'

export function DashboardPage() {
  const { scope } = usePermission('dashboard:view')
  const isLimited = scope === 'limited'
  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title="Dashboard"
        description={
          isLimited
            ? 'Your recent payments and invoices.'
            : "Today's payments, invoices and team activity at a glance."
        }
        actions={
          <PermissionGuard permission="invoices:create">
            <Button asChild>
              <Link to="/invoices/new">
                <Plus aria-hidden="true" />
                Create invoice
              </Link>
            </Button>
          </PermissionGuard>
        }
      />
      <SampleDataNotice />
      <KpiCards />
      {isLimited ? (
        <>
          <RecentTransactions title="My recent transactions" />
          <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
            <RecentInvoices title="Assigned invoices" />
            <QuickActions />
          </div>
        </>
      ) : (
        <>
          <div className="grid gap-4 sm:gap-6 xl:grid-cols-3">
            <div className="min-w-0 xl:col-span-2">
              <PaymentActivityChart />
            </div>
            <QuickActions />
          </div>
          <RecentTransactions />
          <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
            <RecentInvoices />
            <PaymentMethodBreakdown />
          </div>
        </>
      )}
    </div>
  )
}
