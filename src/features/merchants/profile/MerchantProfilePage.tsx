import { Building2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/common/EmptyState'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { PermissionGuard } from '@/features/auth/permissions/PermissionGuard'
import { usePermission } from '@/features/auth/permissions/usePermission'
import { useCurrentMerchant } from '../useMerchantQueries'
import { LimitedProfileSummary } from './LimitedProfileSummary'
import { BankingConfigurationPlaceholder } from './BankingConfigurationPlaceholder'
import { MerchantStatusCard } from './MerchantStatusCard'
import { ProfileDetailsSection } from './ProfileDetailsSection'
import { RegistrationDetailsSection } from './RegistrationDetailsSection'

function ProfileSkeleton() {
  return (
    <div className="space-y-4">
      <Skeleton className="h-28 w-full" />
      <Skeleton className="h-48 w-full" />
    </div>
  )
}

export function MerchantProfilePage() {
  const merchantQuery = useCurrentMerchant()
  const { scope } = usePermission('profile:view')

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title="Business profile"
        description="Your registered business information and verification status."
      />
      <QueryBoundary
        query={merchantQuery}
        loadingFallback={<ProfileSkeleton />}
        errorMessage="Your business profile could not be loaded."
      >
        {(merchant) =>
          merchant === null ? (
            <Card>
              <EmptyState
                icon={Building2}
                title="No business registered yet"
                description="Register your business to see its profile and verification status here."
              />
              <div className="flex justify-center pb-8">
                <Button asChild>
                  <Link to="/onboarding">Register a business</Link>
                </Button>
              </div>
            </Card>
          ) : (
            <>
              <MerchantStatusCard merchant={merchant} />
              {scope === 'limited' ? (
                <LimitedProfileSummary merchant={merchant} />
              ) : (
                <>
                  <RegistrationDetailsSection merchant={merchant} />
                  <ProfileDetailsSection merchant={merchant} />
                  <PermissionGuard permission="banking:manage">
                    <BankingConfigurationPlaceholder
                      status={merchant.bankingConfiguration.status}
                    />
                  </PermissionGuard>
                </>
              )}
            </>
          )
        }
      </QueryBoundary>
    </div>
  )
}
