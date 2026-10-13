import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { FormField } from '@/components/common/FormField'
import { QueryBoundary } from '@/components/common/QueryBoundary'
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
import { Input, Textarea } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { formatRwf } from '@/lib/format'
import { PaymentServiceError } from '@/services/paymentServiceError'
import type { AllocationView, BankTransactionView } from '@/types/payment'
import {
  useAllocateManually,
  useMarkReviewed,
  usePayableInvoices,
  useReverseAllocation,
} from './paymentQueries'
import { referenceOf } from './transactionHelpers'

const messageOf = (error: unknown) =>
  error instanceof PaymentServiceError ? error.message : 'Something went wrong. Please try again.'

interface TransactionDialogProps {
  transaction: BankTransactionView
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * Applies already-bank-confirmed money to invoices. A person can only split money that exists;
 * they can never mark an invoice paid or create a payment.
 */
export function ManualAllocationDialog({
  transaction,
  open,
  onOpenChange,
}: TransactionDialogProps) {
  const { notify } = useToast()
  const payableQuery = usePayableInvoices(open)
  const allocate = useAllocateManually()
  const [amounts, setAmounts] = useState<Record<string, string>>({})
  const [note, setNote] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const chosen = Object.entries(amounts).filter(([, value]) => value.trim() !== '')
  const total = chosen.reduce((sum, [, value]) => sum + Number(value || 0), 0)

  const submit = async () => {
    setErrorMessage(null)
    const invoices = payableQuery.data ?? []
    const lines = chosen.map(([invoiceId, value]) => ({
      invoiceId,
      amount: Number(value),
      expectedRemainingBalance:
        invoices.find((invoice) => invoice.invoiceId === invoiceId)?.remainingBalance ?? -1,
    }))
    if (lines.length === 0) return setErrorMessage('Enter an amount for at least one invoice.')
    if (lines.some((line) => !Number.isInteger(line.amount) || line.amount <= 0)) {
      return setErrorMessage('Amounts must be positive whole numbers of francs.')
    }
    if (total > transaction.unappliedAmount) {
      return setErrorMessage(
        `That is more than the ${formatRwf(transaction.unappliedAmount)} still unapplied.`,
      )
    }
    try {
      await allocate.mutateAsync({
        bankTransactionId: transaction.id,
        expectedTransactionVersion: transaction.version,
        allocations: lines,
        note: note.trim() || undefined,
      })
      notify('success', `${formatRwf(total)} applied to ${lines.length} invoice(s).`)
      setAmounts({})
      setNote('')
      onOpenChange(false)
    } catch (error) {
      setErrorMessage(messageOf(error))
      // A conflict means the figures on screen are stale: reload them.
      if (error instanceof PaymentServiceError && error.code === 'allocation_conflict') {
        void payableQuery.refetch()
      }
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !allocate.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Apply money to invoices</DialogTitle>
          <DialogDescription>
            {formatRwf(transaction.unappliedAmount)} of this bank-confirmed payment (reference{' '}
            {referenceOf(transaction)}) is not on any invoice. Split it across invoices below.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-4">
          <QueryBoundary
            query={payableQuery}
            loadingFallback={<Skeleton className="h-24 w-full" />}
            errorMessage="Invoices could not be loaded."
          >
            {(invoices) =>
              invoices.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No issued invoice has a balance to pay.
                </p>
              ) : (
                <ul className="space-y-3">
                  {invoices.map((invoice) => (
                    <li key={invoice.invoiceId}>
                      <FormField
                        label={`${invoice.invoiceNumber} · ${invoice.customerName}`}
                        hint={`Remaining ${formatRwf(invoice.remainingBalance)}`}
                      >
                        {(control) => (
                          <Input
                            {...control}
                            inputMode="numeric"
                            placeholder="Amount in RWF"
                            value={amounts[invoice.invoiceId] ?? ''}
                            onChange={(event) =>
                              setAmounts((current) => ({
                                ...current,
                                [invoice.invoiceId]: event.target.value.replace(/[^\d]/g, ''),
                              }))
                            }
                          />
                        )}
                      </FormField>
                    </li>
                  ))}
                </ul>
              )
            }
          </QueryBoundary>
          <FormField label="Note">
            {(control) => (
              <Textarea {...control} value={note} onChange={(e) => setNote(e.target.value)} />
            )}
          </FormField>
          <p className="text-sm" aria-live="polite">
            Applying <span className="font-semibold tabular-nums">{formatRwf(total)}</span> of{' '}
            {formatRwf(transaction.unappliedAmount)}
          </p>
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
            disabled={allocate.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void submit()}
            disabled={allocate.isPending}
            aria-busy={allocate.isPending}
          >
            {allocate.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
            Apply to invoices
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function MarkReviewedDialog({ transaction, open, onOpenChange }: TransactionDialogProps) {
  const { notify } = useToast()
  const markReviewed = useMarkReviewed()
  const [note, setNote] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const submit = async () => {
    setErrorMessage(null)
    if (note.trim().length < 3) return setErrorMessage('Add a short note about what you checked.')
    try {
      await markReviewed.mutateAsync({
        bankTransactionId: transaction.id,
        note: note.trim(),
        expectedTransactionVersion: transaction.version,
      })
      notify('success', 'Marked as reviewed. No money was moved.')
      setNote('')
      onOpenChange(false)
    } catch (error) {
      setErrorMessage(messageOf(error))
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !markReviewed.isPending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark as reviewed</DialogTitle>
          <DialogDescription>
            This records that you looked at the payment. It does not apply the money to an invoice.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="space-y-3">
          <FormField label="What did you check?" required>
            {(control) => (
              <Textarea {...control} value={note} onChange={(e) => setNote(e.target.value)} />
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
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={markReviewed.isPending}>
            {markReviewed.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
            Mark as reviewed
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface ReverseDialogProps {
  allocation: AllocationView
  open: boolean
  onOpenChange: (open: boolean) => void
}

export function ReverseAllocationDialog({ allocation, open, onOpenChange }: ReverseDialogProps) {
  const { notify } = useToast()
  const reverse = useReverseAllocation()
  const [reason, setReason] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const submit = async () => {
    setErrorMessage(null)
    if (reason.trim().length < 3) return setErrorMessage('Give a reason for the correction.')
    try {
      await reverse.mutateAsync({ allocationId: allocation.id, reason: reason.trim() })
      notify('success', `The allocation to ${allocation.invoiceNumber} was reversed.`)
      setReason('')
      onOpenChange(false)
    } catch (error) {
      setErrorMessage(messageOf(error))
    }
  }

  return (
    <ConfirmDialogWithReason
      open={open}
      onOpenChange={onOpenChange}
      title={`Reverse the allocation to ${allocation.invoiceNumber}?`}
      description={`${formatRwf(allocation.amount)} will stop counting towards the invoice and its balance is restored. The history stays on record.`}
      reason={reason}
      onReasonChange={setReason}
      isPending={reverse.isPending}
      errorMessage={errorMessage}
      onConfirm={() => void submit()}
    />
  )
}

interface ReasonDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  reason: string
  onReasonChange: (value: string) => void
  isPending: boolean
  errorMessage: string | null
  onConfirm: () => void
}

function ConfirmDialogWithReason(props: ReasonDialogProps) {
  return (
    <ConfirmDialog
      open={props.open}
      onOpenChange={props.onOpenChange}
      title={props.title}
      description={
        <span className="block space-y-3">
          <span className="block">{props.description}</span>
          <span className="block">
            <label htmlFor="reverse-reason" className="mb-1 block text-sm font-medium">
              Reason
            </label>
            <Textarea
              id="reverse-reason"
              value={props.reason}
              onChange={(event) => props.onReasonChange(event.target.value)}
            />
          </span>
        </span>
      }
      confirmLabel="Reverse allocation"
      isDestructive
      isPending={props.isPending}
      errorMessage={props.errorMessage}
      onConfirm={props.onConfirm}
    />
  )
}
