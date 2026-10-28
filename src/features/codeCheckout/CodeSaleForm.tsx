import { Loader2 } from 'lucide-react'
import { useRef, useState, type FormEvent } from 'react'
import { FormField } from '@/components/common/FormField'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input, Select } from '@/components/ui/input'
import { CODE_CHECKOUT_MAX_DESCRIPTION } from '@/constants/codeCheckout'
import { parseAmountInput } from '@/features/checkout/checkoutRules'
import { formatRwf } from '@/lib/format'
import { CodeCheckoutServiceError } from '@/services/codeCheckoutService'
import type { CodeCheckoutOptions, CodeSale } from '@/types/codeCheckout'
import { useBillCodeSale } from './codeCheckoutQueries'
import { attemptFor, forgetAttempt, payloadKeyOf, rememberSale } from './codeCheckoutSession'

interface CodeSaleFormProps {
  scope: string
  options: CodeCheckoutOptions
  onBilled: (sale: CodeSale) => void
}

function failureMessage(error: unknown): { message: string; canRetrySafely: boolean } {
  if (error instanceof CodeCheckoutServiceError) {
    if (error.code === 'service_unavailable') {
      return {
        message:
          'We could not confirm whether this sale was created. Press Try again: the same sale is never billed twice.',
        canRetrySafely: true,
      }
    }
    return { message: error.message, canRetrySafely: error.code === 'request_in_progress' }
  }
  return { message: 'The sale could not be created. Please try again.', canRetrySafely: true }
}

/** The code checkout form: an amount, an optional note and which of the person's codes. Validation here is a convenience; the server decides. */
export function CodeSaleForm({ scope, options, onBilled }: CodeSaleFormProps) {
  const bill = useBillCodeSale()
  const inFlight = useRef(false)
  const amountInput = useRef<HTMLInputElement>(null)
  const codeSelect = useRef<HTMLSelectElement>(null)
  const billable = options.codes.filter((c) => c.mode !== 'UNAVAILABLE' && c.paymentReady)
  const [amount, setAmount] = useState('')
  const [description, setDescription] = useState('')
  const [codeId, setCodeId] = useState(billable.length === 1 ? (billable[0]?.id ?? '') : '')
  const [fieldErrors, setFieldErrors] = useState<{ amount?: string; code?: string }>({})
  const [failure, setFailure] = useState<{ message: string; canRetrySafely: boolean } | null>(null)

  const parsed = parseAmountInput(amount, options.minAmountRwf, options.maxAmountRwf)
  const unavailable = options.codes.filter((c) => c.mode === 'UNAVAILABLE' || !c.paymentReady)
  const chosen = billable.find((c) => c.id === codeId)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (inFlight.current) return
    setFailure(null)
    const errors: { amount?: string; code?: string } = {}
    if (!parsed.ok) errors.amount = parsed.message
    if (!chosen) errors.code = 'Choose the code you are billing through.'
    setFieldErrors(errors)
    if (!parsed.ok || !chosen) {
      ;(errors.amount ? amountInput : codeSelect).current?.focus()
      return
    }
    // The same sale keeps the same ids, so a retry after a lost answer finds the sale instead of making another.
    const attempt = attemptFor(scope, payloadKeyOf(parsed.amount, description, chosen.id))
    inFlight.current = true
    try {
      const sale = await bill.mutateAsync({
        amountRwf: parsed.amount,
        description: description.trim() || undefined,
        collectionCodeId: chosen.id,
        clientRequestId: attempt.clientRequestId,
        idempotencyKey: attempt.idempotencyKey,
      })
      forgetAttempt(scope)
      rememberSale(scope, { saleId: sale.saleId, saleReference: sale.saleReference })
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

          <FormField label="Description" hint="Shown on the invoice. Optional.">
            {(control) => (
              <Input
                {...control}
                name="description"
                autoComplete="off"
                maxLength={CODE_CHECKOUT_MAX_DESCRIPTION}
                placeholder="For example: Two coffees"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            )}
          </FormField>

          <FormField label="Collection code" required error={fieldErrors.code}>
            {(control) => (
              <Select
                {...control}
                ref={codeSelect}
                name="code"
                value={codeId}
                onChange={(event) => {
                  setCodeId(event.target.value)
                  setFieldErrors((previous) => ({ ...previous, code: undefined }))
                }}
              >
                {billable.length !== 1 && <option value="">Choose a code</option>}
                {options.codes.map((code) => {
                  const ready = code.mode !== 'UNAVAILABLE' && code.paymentReady
                  return (
                    <option key={code.id} value={code.id} disabled={!ready}>
                      {code.label}
                      {code.mode === 'DEMONSTRATION' ? ' (demonstration)' : ''}
                      {code.mode === 'UNAVAILABLE' ? ' (not available)' : ''}
                      {code.mode !== 'UNAVAILABLE' && !code.paymentReady
                        ? ' (no payment link)'
                        : ''}
                    </option>
                  )
                })}
              </Select>
            )}
          </FormField>
          {chosen?.mode === 'DEMONSTRATION' && (
            <p className="-mt-3 text-sm font-medium text-warning">
              This is a simulated code. The sale is a demonstration: no real payment can be made.
            </p>
          )}
          {unavailable.length > 0 && (
            <ul className="space-y-1 text-xs text-muted-foreground">
              {unavailable.map((code) => (
                <li key={code.id}>
                  <strong className="font-medium">{code.label}:</strong>{' '}
                  {code.reason ?? 'There is no payment link on this code’s settlement account.'}
                </li>
              ))}
            </ul>
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
            The customer pays with the code shown after billing. A payment is confirmed only when
            the bank reports it. OuPay never asks for a PIN or OTP.
          </p>
        </form>
      </CardContent>
    </Card>
  )
}
