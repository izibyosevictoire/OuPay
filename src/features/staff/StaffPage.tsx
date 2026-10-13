import { SearchX, UserPlus, Users } from 'lucide-react'
import { useMemo, useState } from 'react'
import { useAuth } from '@/app/providers/AuthProvider'
import { EmptyState } from '@/components/common/EmptyState'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { MembershipStatusBadge, RoleBadge } from '@/components/common/StatusBadge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, Select } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { BUSINESS_ROLE_LABELS, MEMBERSHIP_STATUS_LABELS } from '@/constants/auth'
import { getInvitableRoles } from '@/features/auth/permissions/staffPolicy'
import { useCurrentRole } from '@/features/auth/permissions/usePermission'
import { useBranches } from '@/features/branches/useBranchQueries'
import { formatDate } from '@/lib/format'
import type { BusinessRole, MembershipStatus } from '@/types/auth'
import type { StaffMember } from '@/types/staff'
import { InviteStaffDialog, type InviteDefaults } from './InviteStaffDialog'
import { getAvailableStaffActions, type StaffRowAction } from './staffActions'
import {
  BranchAssignmentDialog,
  ChangeRoleDialog,
  MembershipLifecycleDialog,
} from './StaffMemberDialogs'
import { StaffRowActions } from './StaffRowActions'
import { useStaff } from './useStaffQueries'

type DialogState =
  | { type: 'invite'; defaults?: InviteDefaults }
  | {
      type: 'assign_branches' | 'change_role' | 'suspend' | 'reactivate' | 'revoke'
      member: StaffMember
    }

function StaffSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2, 3].map((index) => (
        <Skeleton key={index} className="h-14 w-full" />
      ))}
    </div>
  )
}

interface StaffListProps {
  staff: StaffMember[]
  branchNames: Map<string, string>
  renderActions: (member: StaffMember) => React.ReactNode
}

function BranchNames({
  member,
  branchNames,
}: {
  member: StaffMember
  branchNames: Map<string, string>
}) {
  if (member.branchIds.length === 0)
    return <span className="text-muted-foreground">No branches</span>
  const names = member.branchIds.map((id) => branchNames.get(id) ?? 'Unknown branch').join(', ')
  return (
    <span>
      {names}
      {member.status === 'INVITED' && (
        <span className="text-xs text-muted-foreground"> (on acceptance)</span>
      )}
    </span>
  )
}

function StaffList({ staff, branchNames, renderActions }: StaffListProps) {
  return (
    <>
      {/* Phones: one card per person. */}
      <ul className="divide-y md:hidden">
        {staff.map((member) => (
          <li key={member.membershipId} className="flex items-start justify-between gap-2 py-3">
            <div className="min-w-0 space-y-1">
              <p className="truncate font-medium">{member.fullName}</p>
              {member.fullName !== member.email && (
                <p className="truncate text-xs text-muted-foreground">{member.email}</p>
              )}
              {member.phoneNumber && (
                <p className="text-xs text-muted-foreground">{member.phoneNumber}</p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <RoleBadge role={member.role} />
                <MembershipStatusBadge status={member.status} />
              </div>
              <p className="text-xs text-muted-foreground">
                <BranchNames member={member} branchNames={branchNames} />
              </p>
              <p className="text-xs text-muted-foreground">
                {member.status === 'INVITED' ? 'Invited' : 'Joined'} {formatDate(member.joinedAt)}
              </p>
            </div>
            {renderActions(member)}
          </li>
        ))}
      </ul>

      <table className="hidden w-full text-left md:table">
        <caption className="sr-only">Staff</caption>
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th scope="col" className="pb-2 font-medium">
              Name
            </th>
            <th scope="col" className="pb-2 font-medium">
              Phone
            </th>
            <th scope="col" className="pb-2 font-medium">
              Role
            </th>
            <th scope="col" className="pb-2 font-medium">
              Status
            </th>
            <th scope="col" className="pb-2 font-medium">
              Branches
            </th>
            <th scope="col" className="pb-2 font-medium">
              Date
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {staff.map((member) => (
            <tr key={member.membershipId}>
              <th scope="row" className="py-3 pr-3 font-medium">
                <span className="block">{member.fullName}</span>
                {member.fullName !== member.email && (
                  <span className="block text-xs font-normal text-muted-foreground">
                    {member.email}
                  </span>
                )}
              </th>
              <td className="py-3 pr-3 text-muted-foreground">{member.phoneNumber || '—'}</td>
              <td className="py-3 pr-3">
                <RoleBadge role={member.role} />
              </td>
              <td className="py-3 pr-3">
                <MembershipStatusBadge status={member.status} />
              </td>
              <td className="py-3 pr-3">
                <BranchNames member={member} branchNames={branchNames} />
              </td>
              <td className="py-3 pr-3 text-muted-foreground">
                <span className="block text-xs">
                  {member.status === 'INVITED' ? 'Invited' : 'Joined'}
                </span>
                {formatDate(member.joinedAt)}
              </td>
              <td className="py-3 text-right">{renderActions(member)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

export function StaffPage() {
  const staffQuery = useStaff()
  const branchesQuery = useBranches()
  const actorRole = useCurrentRole()
  const { user } = useAuth()
  const [dialog, setDialog] = useState<DialogState | null>(null)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState<'ALL' | BusinessRole>('ALL')
  const [statusFilter, setStatusFilter] = useState<'ALL' | MembershipStatus>('ALL')
  const [branchFilter, setBranchFilter] = useState('ALL')

  const branches = useMemo(() => branchesQuery.data ?? [], [branchesQuery.data])
  const branchNames = useMemo(() => new Map(branches.map((b) => [b.id, b.name])), [branches])
  const canInvite = getInvitableRoles(actorRole).length > 0

  const filteredStaff = useMemo(() => {
    const term = search.trim().toLowerCase()
    return (staffQuery.data ?? []).filter(
      (member) =>
        (roleFilter === 'ALL' || member.role === roleFilter) &&
        (statusFilter === 'ALL' || member.status === statusFilter) &&
        (branchFilter === 'ALL' || member.branchIds.includes(branchFilter)) &&
        (!term || `${member.fullName} ${member.email}`.toLowerCase().includes(term)),
    )
  }, [staffQuery.data, search, roleFilter, statusFilter, branchFilter])

  const handleAction = (
    action: Exclude<StaffRowAction, 'open_invitation'>,
    member: StaffMember,
  ) => {
    if (action === 'invite_again') {
      setDialog({
        type: 'invite',
        defaults: {
          email: member.email,
          role: member.role === 'MANAGER' ? 'MANAGER' : 'CASHIER',
        },
      })
    } else {
      setDialog({ type: action, member })
    }
  }

  const closeDialog = (open: boolean) => !open && setDialog(null)

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title="Cashiers & staff"
        description="Everyone who works in this business, their roles and the branches they are assigned to."
        actions={
          canInvite ? (
            <Button onClick={() => setDialog({ type: 'invite' })}>
              <UserPlus aria-hidden="true" />
              Invite staff
            </Button>
          ) : null
        }
      />

      <Card className="p-4 sm:p-5">
        <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Input
            type="search"
            aria-label="Search staff"
            placeholder="Search by name or email"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="sm:col-span-2 lg:col-span-1"
          />
          <Select
            aria-label="Filter by role"
            value={roleFilter}
            onChange={(event) => setRoleFilter(event.target.value as 'ALL' | BusinessRole)}
          >
            <option value="ALL">All roles</option>
            {(['OWNER', 'MANAGER', 'CASHIER'] as const).map((role) => (
              <option key={role} value={role}>
                {BUSINESS_ROLE_LABELS[role]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as 'ALL' | MembershipStatus)}
          >
            <option value="ALL">All statuses</option>
            {(['ACTIVE', 'INVITED', 'SUSPENDED', 'REVOKED'] as const).map((status) => (
              <option key={status} value={status}>
                {MEMBERSHIP_STATUS_LABELS[status]}
              </option>
            ))}
          </Select>
          <Select
            aria-label="Filter by branch"
            value={branchFilter}
            onChange={(event) => setBranchFilter(event.target.value)}
          >
            <option value="ALL">All branches</option>
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>
                {branch.name}
              </option>
            ))}
          </Select>
        </div>

        <QueryBoundary
          query={staffQuery}
          loadingFallback={<StaffSkeleton />}
          errorMessage="Staff could not be loaded."
        >
          {(staff) =>
            staff.length === 0 ? (
              <EmptyState
                icon={Users}
                title="No staff yet"
                description="Invite cashiers and managers to start building your team."
              />
            ) : filteredStaff.length === 0 ? (
              <EmptyState
                icon={SearchX}
                title="No staff match"
                description="Try a different search or clear a filter."
              />
            ) : (
              <StaffList
                staff={filteredStaff}
                branchNames={branchNames}
                renderActions={(member) => (
                  <StaffRowActions
                    member={member}
                    actions={getAvailableStaffActions(
                      actorRole,
                      member,
                      member.userId === user?.id,
                    )}
                    onAction={handleAction}
                  />
                )}
              />
            )
          }
        </QueryBoundary>
      </Card>

      {dialog?.type === 'invite' && (
        <InviteStaffDialog open defaults={dialog.defaults} onOpenChange={closeDialog} />
      )}
      {dialog?.type === 'assign_branches' && (
        <BranchAssignmentDialog open member={dialog.member} onOpenChange={closeDialog} />
      )}
      {dialog?.type === 'change_role' && (
        <ChangeRoleDialog open member={dialog.member} onOpenChange={closeDialog} />
      )}
      {(dialog?.type === 'suspend' ||
        dialog?.type === 'reactivate' ||
        dialog?.type === 'revoke') && (
        <MembershipLifecycleDialog
          open
          member={dialog.member}
          action={dialog.type}
          onOpenChange={closeDialog}
        />
      )}
    </div>
  )
}
