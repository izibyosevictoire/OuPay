import { Loader2 } from 'lucide-react'
import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'

interface ConfirmDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  confirmLabel: string
  /** Visually emphasises irreversible actions. */
  isDestructive?: boolean
  isPending?: boolean
  /** Failure from the last attempt, shown without closing the dialog. */
  errorMessage?: string | null
  onConfirm: () => void
}

/** Asks before an action with consequences; stays open and shows the error if it fails. */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  isDestructive = false,
  isPending = false,
  errorMessage,
  onConfirm,
}: ConfirmDialogProps) {
  return (
    <Dialog open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {errorMessage && (
          <p
            role="alert"
            className="mx-4 mt-4 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger sm:mx-5"
          >
            {errorMessage}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button
            onClick={onConfirm}
            disabled={isPending}
            aria-busy={isPending}
            className={
              isDestructive
                ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                : undefined
            }
          >
            {isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
