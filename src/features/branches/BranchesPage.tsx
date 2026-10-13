import { Building2, Plus, SearchX } from 'lucide-react'
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/common/EmptyState'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { BranchStatusBadge } from '@/components/common/StatusBadge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, Select } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { formatDate } from '@/lib/format'
import type { Branch, BranchStatus, BranchSummary } from '@/types/branch'
import { BranchFormDialog } from './BranchFormDialog'
import { BranchRowActions } from './BranchRowActions'
import { BranchStatusDialog } from './BranchStatusDialog'
import { useBranches } from './useBranchQueries'

type StatusFilter = 'ALL' | BranchStatus

const locationOf = (branch: Branch) => `${branch.location.district}, ${branch.location.sector}`

function BranchesSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2, 3].map((index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  )
}

interface BranchListProps {
  branches: BranchSummary[]
  onEdit: (branch: Branch) => void
  onChangeStatus: (branch: Branch) => void
}

function BranchList({ branches, onEdit, onChangeStatus }: BranchListProps) {
  return (
    <>
      {/* Phones: stacked cards instead of a wide table. */}
      <ul className="divide-y md:hidden">
        {branches.map((branch) => (
          <li key={branch.id} className="flex items-start justify-between gap-2 py-3">
            <div className="min-w-0 space-y-1">
              <Link
                to={`/branches/${branch.id}`}
                className="block truncate rounded-sm font-medium text-primary hover:underline"
              >
                {branch.name}
              </Link>
              <p className="text-xs text-muted-foreground">
                {branch.code} · {locationOf(branch)}
              </p>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <BranchStatusBadge status={branch.status} />
                <span>
                  {branch.assignedStaffCount} staff · Created {formatDate(branch.createdAt)}
                </span>
              </div>
            </div>
            <BranchRowActions branch={branch} onEdit={onEdit} onChangeStatus={onChangeStatus} />
          </li>
        ))}
      </ul>

      <table className="hidden w-full text-left md:table">
        <caption className="sr-only">Branches</caption>
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th scope="col" className="pb-2 font-medium">
              Branch
            </th>
            <th scope="col" className="pb-2 font-medium">
              Code
            </th>
            <th scope="col" className="pb-2 font-medium">
              Location
            </th>
            <th scope="col" className="pb-2 font-medium">
              Status
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              Staff
            </th>
            <th scope="col" className="pb-2 pl-4 font-medium">
              Created
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {branches.map((branch) => (
            <tr key={branch.id}>
              <th scope="row" className="py-3 pr-2 font-medium">
                <Link
                  to={`/branches/${branch.id}`}
                  className="rounded-sm text-primary hover:underline"
                >
                  {branch.name}
                </Link>
              </th>
              <td className="py-3 font-mono text-xs">{branch.code}</td>
              <td className="py-3 text-muted-foreground">{locationOf(branch)}</td>
              <td className="py-3">
                <BranchStatusBadge status={branch.status} />
              </td>
              <td className="py-3 text-right tabular-nums">{branch.assignedStaffCount}</td>
              <td className="py-3 pl-4 text-muted-foreground">{formatDate(branch.createdAt)}</td>
              <td className="py-3 text-right">
                <BranchRowActions branch={branch} onEdit={onEdit} onChangeStatus={onChangeStatus} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

export function BranchesPage() {
  const branchesQuery = useBranches()
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL')
  const [formTarget, setFormTarget] = useState<{ branch?: Branch } | null>(null)
  const [statusTarget, setStatusTarget] = useState<Branch | null>(null)

  const filteredBranches = useMemo(() => {
    const term = search.trim().toLowerCase()
    return (branchesQuery.data ?? []).filter(
      (branch) =>
        (statusFilter === 'ALL' || branch.status === statusFilter) &&
        (!term ||
          [branch.name, branch.code, branch.location.district, branch.location.sector]
            .join(' ')
            .toLowerCase()
            .includes(term)),
    )
  }, [branchesQuery.data, search, statusFilter])

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title="Branches"
        description="The locations where your business operates and the staff assigned to each."
        actions={
          <Button onClick={() => setFormTarget({})}>
            <Plus aria-hidden="true" />
            Add branch
          </Button>
        }
      />

      <Card className="p-4 sm:p-5">
        <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_12rem]">
          <Input
            type="search"
            aria-label="Search branches"
            placeholder="Search by name, code or location"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
          >
            <option value="ALL">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </Select>
        </div>

        <QueryBoundary
          query={branchesQuery}
          loadingFallback={<BranchesSkeleton />}
          errorMessage="Branches could not be loaded."
        >
          {(branches) =>
            branches.length === 0 ? (
              <EmptyState
                icon={Building2}
                title="No branches yet"
                description="Add your first branch to start assigning staff to locations."
              />
            ) : filteredBranches.length === 0 ? (
              <EmptyState
                icon={SearchX}
                title="No branches match"
                description="Try a different search or clear the status filter."
              />
            ) : (
              <BranchList
                branches={filteredBranches}
                onEdit={(branch) => setFormTarget({ branch })}
                onChangeStatus={setStatusTarget}
              />
            )
          }
        </QueryBoundary>
      </Card>

      {formTarget && (
        <BranchFormDialog
          open
          branch={formTarget.branch}
          onOpenChange={(open) => !open && setFormTarget(null)}
        />
      )}
      {statusTarget && (
        <BranchStatusDialog
          open
          branch={statusTarget}
          onOpenChange={(open) => !open && setStatusTarget(null)}
        />
      )}
    </div>
  )
}
