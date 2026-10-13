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
import { Textarea } from '@/components/ui/input'
import { formatRwf } from '@/lib/format'
import { InvoiceServiceError } from '@/services/invoiceService'
import type { Invoice } from '@/types/invoice'
import { useCancelDraft, useIssueInvoice, useVoidInvoice } from './useInvoiceQueries'

interface InvoiceDialogProps {
  invoice: Invoice
  open: boolean
  onOpenChange: (open: boolean) => void
}

const messageFrom = (error: unknown) =>
  error instanceof InvoiceServiceError
    ? error.message
    : 'That could not be completed. Please try again.'

export function IssueInvoiceDialog({ invoice, open, onOpenChange }: InvoiceDialogProps) {
  const { notify } = useToast()
  const issue = useIssueInvoice()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const confirm = async () => {
    setErrorMessage(null)
    try {
      await issue.mutateAsync({ invoiceId: invoice.id, version: invoice.version })
      notify('success', `Invoice ${invoice.invoiceNumber} issued.`)
      onOpenChange(false)
    } catch (error) {
      setErrorMessage(messageFrom(error))
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setErrorMessage(null)
        onOpenChange(next)
      }}
      title={`Issue ${invoice.invoiceNumber}?`}
      description={`Total ${formatRwf(invoice.grandTotal)}. Once issued, its amounts and customer details can no longer be edited. It will show as unpaid until a bank-confirmed payment is recorded.`}
      confirmLabel="Issue invoice"
      isPending={issue.isPending}
      errorMessage={errorMessage}
      onConfirm={() => void confirm()}
    />
  )
}

export function CancelDraftDialog({ invoice, open, onOpenChange }: InvoiceDialogProps) {
  const { notify } = useToast()
  const cancel = useCancelDraft()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const confirm = async () => {
    setErrorMessage(null)
    try {
      await cancel.mutateAsync({ invoiceId: invoice.id, version: invoice.version })
      notify('success', `Draft ${invoice.invoiceNumber} was cancelled.`)
      onOpenChange(false)
    } catch (error) {
      setErrorMessage(messageFrom(error))
    }
  }

  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setErrorMessage(null)
        onOpenChange(next)
      }}
      title={`Cancel draft ${invoice.invoiceNumber}?`}
      description="The draft is kept on file as cancelled and its number is not reused. This cannot be undone."
      confirmLabel="Cancel draft"
      isDestructive
      isPending={cancel.isPending}
      errorMessage={errorMessage}
      onConfirm={() => void confirm()}
    />
  )
}

/** Owner-only correction for an issued, unpaid invoice. A reason is mandatory. */
export function VoidInvoiceDialog({ invoice, open, onOpenChange }: InvoiceDialogProps) {
  const { notify } = useToast()
  const voidInvoice = useVoidInvoice()
  const [reason, setReason] = useState('')
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const submit = async () => {
    setErrorMessage(null)
    if (reason.trim().length < 3) {
      setFieldError('Give a reason for voiding this invoice.')
      return
    }
    setFieldError(null)
    try {
      await voidInvoice.mutateAsync({ invoiceId: invoice.id, version: invoice.version, reason })
      notify('success', `Invoice ${invoice.invoiceNumber} was voided.`)
      onOpenChange(false)
    } catch (error) {
      setErrorMessage(messageFrom(error))
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !voidInvoice.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Void {invoice.invoiceNumber}?</DialogTitle>
          <DialogDescription>
            Voiding is a correction for an invoice issued by mistake. The invoice, its number and
            its amounts stay on file marked as voided. It cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <FormField label="Reason" required error={fieldError ?? undefined}>
            {(field) => (
              <Textarea
                {...field}
                value={reason}
                onChange={(event) => setReason(event.target.value)}
              />
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
            disabled={voidInvoice.isPending}
          >
            Keep invoice
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={voidInvoice.isPending}
            aria-busy={voidInvoice.isPending}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {voidInvoice.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
            Void invoice
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
