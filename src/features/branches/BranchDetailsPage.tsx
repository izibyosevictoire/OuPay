import { ArrowLeft, Pencil, Power, PowerOff, Receipt, Users } from 'lucide-react'
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { DescriptionList } from '@/components/common/DescriptionList'
import { EmptyState } from '@/components/common/EmptyState'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import {
  BranchStatusBadge,
  MembershipStatusBadge,
  RoleBadge,
} from '@/components/common/StatusBadge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { BRANCH_STATUS_DESCRIPTIONS } from '@/constants/branch'
import { formatDate } from '@/lib/format'
import { OrganizationServiceError } from '@/services/organizationService'
import type { BranchDetails } from '@/types/branch'
import { BranchFormDialog } from './BranchFormDialog'
import { BranchStatusDialog } from './BranchStatusDialog'
import { useBranch } from './useBranchQueries'

function DetailsContent({ details }: { details: BranchDetails }) {
  const { branch, assignedStaff } = details
  const [isEditing, setIsEditing] = useState(false)
  const [isChangingStatus, setIsChangingStatus] = useState(false)
  const isActive = branch.status === 'ACTIVE'

  return (
    <>
      <PageHeader
        title={branch.name}
        description={`Branch code ${branch.code}`}
        actions={
          <>
            <Button variant="outline" onClick={() => setIsEditing(true)}>
              <Pencil aria-hidden="true" /> Edit
            </Button>
            <Button variant="outline" onClick={() => setIsChangingStatus(true)}>
              {isActive ? <PowerOff aria-hidden="true" /> : <Power aria-hidden="true" />}
              {isActive ? 'Deactivate' : 'Activate'}
            </Button>
          </>
        }
      />

      <Card className="p-4 sm:p-5">
        <div className="flex flex-wrap items-center gap-3">
          <BranchStatusBadge status={branch.status} />
          <p className="text-sm text-muted-foreground">
            {BRANCH_STATUS_DESCRIPTIONS[branch.status]}
          </p>
        </div>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>General information</CardTitle>
        </CardHeader>
        <DescriptionList
          rows={[
            { label: 'Branch ID', value: branch.id },
            { label: 'Branch code', value: branch.code },
            { label: 'Province', value: branch.location.province },
            { label: 'District', value: branch.location.district },
            { label: 'Sector', value: branch.location.sector },
            { label: 'Physical address', value: branch.location.physicalAddress },
            { label: 'Contact phone', value: branch.contactPhone },
            { label: 'Created', value: formatDate(branch.createdAt) },
            { label: 'Last updated', value: formatDate(branch.updatedAt) },
          ]}
        />
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Assigned staff</CardTitle>
          <CardDescription>
            Manage who works here from the{' '}
            <Link to="/cashiers" className="font-medium text-primary hover:underline">
              staff page
            </Link>
            .
          </CardDescription>
        </CardHeader>
        <CardContent>
          {assignedStaff.length === 0 ? (
            <EmptyState
              icon={Users}
              title="No staff assigned"
              description="Assign cashiers and managers to this branch from the staff page."
            />
          ) : (
            <ul className="divide-y">
              {assignedStaff.map((member) => (
                <li
                  key={member.membershipId}
                  className="flex flex-wrap items-center justify-between gap-2 py-3 first:pt-0 last:pb-0"
                >
                  <div className="min-w-0">
                    <p className="truncate font-medium">{member.fullName}</p>
                    <p className="text-xs text-muted-foreground">
                      Assigned {formatDate(member.assignedAt)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <RoleBadge role={member.role} />
                    <MembershipStatusBadge status={member.membershipStatus} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Invoices and payment activity</CardTitle>
        </CardHeader>
        <CardContent>
          <EmptyState
            icon={Receipt}
            title="Coming soon"
            description="Invoices and payments for this branch will appear here once those modules are built."
          />
        </CardContent>
      </Card>

      {isEditing && <BranchFormDialog open branch={branch} onOpenChange={setIsEditing} />}
      {isChangingStatus && (
        <BranchStatusDialog open branch={branch} onOpenChange={setIsChangingStatus} />
      )}
    </>
  )
}

export function BranchDetailsPage() {
  const { branchId = '' } = useParams()
  const branchQuery = useBranch(branchId)
  const isMissing =
    branchQuery.error instanceof OrganizationServiceError && branchQuery.error.code === 'not_found'

  return (
    <div className="space-y-4 sm:space-y-6">
      <Link
        to="/branches"
        className="inline-flex items-center gap-1 rounded-sm text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden="true" /> All branches
      </Link>
      {isMissing ? (
        <>
          <PageHeader title="Branch not found" />
          <Card>
            <EmptyState
              icon={Users}
              title="We could not find that branch"
              description="It may belong to a different business or may have been removed."
            />
          </Card>
        </>
      ) : (
        <QueryBoundary
          query={branchQuery}
          loadingFallback={<Skeleton className="h-64 w-full" />}
          errorMessage="This branch could not be loaded."
        >
          {(details) => <DetailsContent details={details} />}
        </QueryBoundary>
      )}
    </div>
  )
}
