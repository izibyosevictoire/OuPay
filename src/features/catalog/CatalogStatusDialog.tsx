import { useState } from 'react'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { useToast } from '@/components/common/Toaster'
import { CatalogServiceError } from '@/services/catalogService'
import type { CatalogItem } from '@/types/catalog'
import { useChangeCatalogItemStatus } from './catalogQueries'

interface CatalogStatusDialogProps {
  item: CatalogItem
  open: boolean
  onOpenChange: (open: boolean) => void
}

/** Items are deactivated, never deleted: past records keep pointing at them. */
export function CatalogStatusDialog({ item, open, onOpenChange }: CatalogStatusDialogProps) {
  const { notify } = useToast()
  const changeStatus = useChangeCatalogItemStatus()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const willDeactivate = item.active

  const confirm = async () => {
    setErrorMessage(null)
    try {
      await changeStatus.mutateAsync({
        itemId: item.id,
        expectedVersion: item.version,
        active: !willDeactivate,
      })
      notify('success', `${item.name} is now ${willDeactivate ? 'inactive' : 'active'}.`)
      onOpenChange(false)
    } catch (error) {
      setErrorMessage(
        error instanceof CatalogServiceError
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
      title={willDeactivate ? `Deactivate ${item.name}?` : `Activate ${item.name}?`}
      description={
        willDeactivate
          ? 'An inactive item stays in the catalog with its history, but is no longer offered for new sales. Nothing is deleted.'
          : 'An active item is offered for new sales again.'
      }
      confirmLabel={willDeactivate ? 'Deactivate item' : 'Activate item'}
      isDestructive={willDeactivate}
      isPending={changeStatus.isPending}
      errorMessage={errorMessage}
      onConfirm={() => void confirm()}
    />
  )
}
