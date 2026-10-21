import { Loader2 } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import { FormField } from '@/components/common/FormField'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input, Select } from '@/components/ui/input'
import { SIMPLE_CHECKOUT_MAX_DESCRIPTION } from '@/constants/checkout'
import { formatRwf } from '@/lib/format'
import { CheckoutServiceError } from '@/services/checkoutService'
import type { SimpleCheckoutOptions, SimpleCheckoutResult } from '@/types/checkout'
import { useBillSimpleCheckout } from './checkoutQueries'
import { parseAmountInput } from './checkoutRules'
import { attemptFor, forgetAttempt, payloadKeyOf, rememberSale } from './checkoutSession'

interface CollectFormProps {
  /** The business and the signed-in person: what a remembered sale is kept under. */
  scope: string
  options: SimpleCheckoutOptions
  onBilled: (sale: SimpleCheckoutResult) => void
}

/** What a failed bill means for the cashier, in plain words. */
function failureMessage(error: unknown): { message: string; canRetrySafely: boolean } {
  if (error instanceof CheckoutServiceError) {
    if (error.code === 'service_unavailable') {
      return {
        message:
          'We could not confirm whether this payment was created. Press Try again: the same payment is never billed twice.',
        canRetrySafely: true,
      }
    }
    return { message: error.message, canRetrySafely: error.code === 'request_in_progress' }
  }
  return { message: 'The payment could not be created. Please try again.', canRetrySafely: true }
}

/**
 * The whole simplified checkout form: an amount, an optional note and, only when the person may bill at more than one branch,
 * which branch. Validation here is a convenience; the server decides.
 */
export function CollectForm({ scope, options, onBilled }: CollectFormProps) {
  const bill = useBillSimpleCheckout()
  // A second click in the same instant (a double-click) arrives before the button has re-rendered as disabled.
  const inFlight = useRef(false)
  const amountInput = useRef<HTMLInputElement>(null)
  const branchSelect = useRef<HTMLSelectElement>(null)
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [branchId, setBranchId] = useState('')
  const [fieldErrors, setFieldErrors] = useState<{ amount?: string; branch?: string }>({})
  const [failure, setFailure] = useState<{ message: string; canRetrySafely: boolean } | null>(null)

  const needsBranchChoice = options.branches.length > 1
  const parsed = parseAmountInput(amount, options.minAmountRwf, options.maxAmountRwf)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (inFlight.current) return
    setFailure(null)
    const errors: { amount?: string; branch?: string } = {}
    if (!parsed.ok) errors.amount = parsed.message
    if (needsBranchChoice && !branchId) errors.branch = 'Choose the branch you are billing for.'
    setFieldErrors(errors)
    if (!parsed.ok || errors.branch) {
      // Moves focus to the first field that needs fixing, so a screen reader announces it with its message.
      ;(errors.amount ? amountInput : branchSelect).current?.focus()
      return
    }

    const chosenBranch = needsBranchChoice ? branchId : (options.branches[0]?.id ?? '')
    // The same sale keeps the same ids, so a retry after a lost answer finds the sale instead of making another.
    const attempt = attemptFor(scope, payloadKeyOf(parsed.amount, description, chosenBranch))
    inFlight.current = true
    try {
      const sale = await bill.mutateAsync({
        amountRwf: parsed.amount,
        description: description.trim() || undefined,
        branchId: needsBranchChoice ? branchId : undefined,
        clientRequestId: attempt.clientRequestId,
        idempotencyKey: attempt.idempotencyKey,
      })
      // Done: the next sale is a new sale, even for the same amount.
      forgetAttempt(scope)
      rememberSale(scope, sale)
      onBilled(sale)
    } catch (error) {
      setFailure(failureMessage(error))
    } finally {
      inFlight.current = false
    }
  }

  return (
    <Card>
      <CardContent className="p-4 sm:p-6">
        <form onSubmit={(event) => void submit(event)} noValidate className="space-y-5">
          <FormField
            label="Amount (RWF)"
            required
            error={fieldErrors.amount}
            hint={`Whole francs, from ${formatRwf(options.minAmountRwf)} to ${formatRwf(options.maxAmountRwf)}.`}
          >
            {(control) => (
              <Input
                {...control}
                ref={amountInput}
                name="amount"
                inputMode="numeric"
                autoComplete="off"
                autoFocus
                placeholder="0"
                value={amount}
                onChange={(event) => {
                  setAmount(event.target.value)
                  setFieldErrors((previous) => ({ ...previous, amount: undefined }))
                }}
                className="h-14 text-2xl font-semibold tabular-nums"
              />
            )}
          </FormField>
          {parsed.ok && (
            <p className="-mt-3 text-sm text-muted-foreground" aria-live="polite">
              Billing {formatRwf(parsed.amount)}
            </p>
          )}

          <FormField
            label="Description"
            hint={`Shown on the invoice. If left empty it reads “${options.defaultDescription}”.`}
          >
            {(control) => (
              <Input
                {...control}
                name="description"
                autoComplete="off"
                maxLength={SIMPLE_CHECKOUT_MAX_DESCRIPTION}
                placeholder="For example: Moto ride"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            )}
          </FormField>

          {needsBranchChoice && (
            <FormField label="Branch" required error={fieldErrors.branch}>
              {(control) => (
                <Select
                  {...control}
                  ref={branchSelect}
                  name="branch"
                  value={branchId}
                  onChange={(event) => {
                    setBranchId(event.target.value)
                    setFieldErrors((previous) => ({ ...previous, branch: undefined }))
                  }}
                >
                  <option value="">Choose a branch</option>
                  {options.branches.map((branch) => (
                    <option key={branch.id} value={branch.id} disabled={!branch.paymentReady}>
                      {branch.name}
                      {branch.paymentReady ? '' : ' (no payment link set up)'}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
          )}

          {failure && (
            <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
              {failure.message}
            </p>
          )}

          <Button type="submit" className="h-12 w-full text-base" disabled={bill.isPending}>
            {bill.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
            {bill.isPending ? 'Billing…' : failure?.canRetrySafely ? 'Try again' : 'Bill'}
          </Button>
          <p className="text-center text-xs text-muted-foreground">
            The customer pays through the payment link or QR code. Payment is confirmed only when
            the bank reports it. OuPay never asks for a PIN or OTP.
          </p>
        </form>
      </CardContent>
    </Card>
  )
}
