import { useState } from 'react'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useToast } from '@/components/common/Toaster'
import { OrganizationServiceError } from '@/services/organizationService'
import type { Branch } from '@/types/branch'
import { useChangeBranchStatus } from './useBranchQueries'

interface BranchStatusDialogProps {
  branch: Branch
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Confirms activating or deactivating a branch, and explains what each does. */
export function BranchStatusDialog({ branch, open, onOpenChange }: BranchStatusDialogProps) {
  const { notify } = useToast()
  const changeStatus = useChangeBranchStatus()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const willDeactivate = branch.status === 'ACTIVE'

  const confirm = async () => {
    setErrorMessage(null)
    try {
      await changeStatus.mutateAsync({
        branchId: branch.id,
        status: willDeactivate ? 'INACTIVE' : 'ACTIVE',
      })
      notify('success', `${branch.name} is now ${willDeactivate ? 'inactive' : 'active'}.`)
      onOpenChange(false)
    } catch (error) {
      setErrorMessage(
        error instanceof OrganizationServiceError
          ? error.message
          : 'The status could not be changed. Please try again.',
      )
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setErrorMessage(null)
        onOpenChange(next)
      }}
      title={willDeactivate ? `Deactivate ${branch.name}?` : `Activate ${branch.name}?`}
      description={
        willDeactivate
          ? 'An inactive branch keeps all its history but cannot receive new staff assignments or, in future, new invoices. Staff already assigned stay assigned.'
          : 'An active branch can receive staff assignments and, in future, new invoices.'
      }
      confirmLabel={willDeactivate ? 'Deactivate branch' : 'Activate branch'}
      isDestructive={willDeactivate}
      isPending={changeStatus.isPending}
      errorMessage={errorMessage}
      onConfirm={() => void confirm()}
    />
  )
}
