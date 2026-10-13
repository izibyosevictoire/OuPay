import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { FormField } from '@/components/common/FormField'
import { useToast } from '@/components/common/Toaster'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Select } from '@/components/ui/input'
import { BUSINESS_ROLE_LABELS } from '@/constants/auth'
import { useBranches, useUpdateBranchAssignments } from '@/features/branches/useBranchQueries'
import { OrganizationServiceError } from '@/services/organizationService'
import type { BusinessRole } from '@/types/auth'
import type { StaffMember } from '@/types/staff'
import { BranchAssignmentPicker } from './BranchAssignmentPicker'
import { useMembershipLifecycle, useUpdateMembershipRole } from './useStaffQueries'

const messageFrom = (error: unknown, fallback: string) =>
  error instanceof OrganizationServiceError ? error.message : fallback

interface MemberDialogProps {
  member: StaffMember
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ChangeRoleDialog({ member, open, onOpenChange }: MemberDialogProps) {
  const { notify } = useToast()
  const updateRole = useUpdateMembershipRole()
  const [role, setRole] = useState<BusinessRole>(member.role)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const save = async () => {
    setErrorMessage(null)
    try {
      await updateRole.mutateAsync({ membershipId: member.membershipId, role })
      notify('success', `${member.fullName} is now ${BUSINESS_ROLE_LABELS[role].toLowerCase()}.`)
      onOpenChange(false)
    } catch (error) {
      setErrorMessage(messageFrom(error, 'The role could not be changed. Please try again.'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !updateRole.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Change role</DialogTitle>
          <DialogDescription>
            Choose the business role for {member.fullName}. Roles decide what they can do; branch
            assignments only decide where they work.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <FormField label="Role" required>
            {(field) => (
              <Select
                {...field}
                value={role}
                onChange={(event) => setRole(event.target.value as BusinessRole)}
              >
                {(['OWNER', 'MANAGER', 'CASHIER'] as const).map((option) => (
                  <option key={option} value={option}>
                    {BUSINESS_ROLE_LABELS[option]}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          {errorMessage && (
            <p
              role="alert"
              className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
            >
              {errorMessage}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={updateRole.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={updateRole.isPending || role === member.role}
            aria-busy={updateRole.isPending}
          >
            {updateRole.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
            Save role
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function BranchAssignmentDialog({ member, open, onOpenChange }: MemberDialogProps) {
  const { notify } = useToast()
  const branchesQuery = useBranches()
  const updateAssignments = useUpdateBranchAssignments()
  const [selected, setSelected] = useState<string[]>(member.branchIds)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const save = async () => {
    setErrorMessage(null)
    try {
      await updateAssignments.mutateAsync({
        membershipId: member.membershipId,
        branchIds: selected,
      })
      notify('success', `Branches updated for ${member.fullName}.`)
      onOpenChange(false)
    } catch (error) {
      setErrorMessage(messageFrom(error, 'Branches could not be updated. Please try again.'))
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !updateAssignments.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manage branches</DialogTitle>
          <DialogDescription>
            Choose where {member.fullName} works. Assigning a branch does not change what they are
            allowed to do.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          {branchesQuery.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading branches…
            </p>
          ) : branchesQuery.isError ? (
            <p role="alert" className="text-sm text-danger">
              Branches could not be loaded.
            </p>
          ) : (
            <BranchAssignmentPicker
              branches={branchesQuery.data}
              selectedBranchIds={selected}
              onChange={setSelected}
            />
          )}
          {errorMessage && (
            <p
              role="alert"
              className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
            >
              {errorMessage}
            </p>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={updateAssignments.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void save()}
            disabled={updateAssignments.isPending || !branchesQuery.isSuccess}
            aria-busy={updateAssignments.isPending}
          >
            {updateAssignments.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
            Save branches
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

type LifecycleAction = 'suspend' | 'reactivate' | 'revoke'

export function MembershipLifecycleDialog({
  member,
  action,
  open,
  onOpenChange,
}: MemberDialogProps & { action: LifecycleAction }) {
  const { notify } = useToast()
  const lifecycle = useMembershipLifecycle()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const isInvitation = member.status === 'INVITED'

  const copy = {
    suspend: {
      title: `Suspend ${member.fullName}?`,
      description:
        'They lose access to this business straight away. You can reactivate them later; their branch assignments are kept.',
      confirm: 'Suspend access',
      done: `${member.fullName} was suspended.`,
    },
    reactivate: {
      title: `Reactivate ${member.fullName}?`,
      description: 'They regain access to this business with their previous role.',
      confirm: 'Reactivate access',
      done: `${member.fullName} was reactivated.`,
    },
    revoke: {
      title: isInvitation ? 'Cancel this invitation?' : `Revoke access for ${member.fullName}?`,
      description: isInvitation
        ? 'The invitation link stops working. You can invite them again later.'
        : 'This ends their access and all of their branch assignments. It cannot be undone: to bring them back you must send a new invitation.',
      confirm: isInvitation ? 'Cancel invitation' : 'Revoke access',
      done: isInvitation
        ? 'The invitation was cancelled.'
        : `Access was revoked for ${member.fullName}.`,
    },
  }[action]

  const confirm = async () => {
    setErrorMessage(null)
    try {
      await lifecycle.mutateAsync({ membershipId: member.membershipId, action })
      notify('success', copy.done)
      onOpenChange(false)
    } catch (error) {
      setErrorMessage(messageFrom(error, 'That could not be completed. Please try again.'))
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setErrorMessage(null)
        onOpenChange(next)
      }}
      title={copy.title}
      description={copy.description}
      confirmLabel={copy.confirm}
      isDestructive={action !== 'reactivate'}
      isPending={lifecycle.isPending}
      errorMessage={errorMessage}
      onConfirm={() => void confirm()}
    />
  )
}
