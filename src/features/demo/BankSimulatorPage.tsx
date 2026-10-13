import { useMutation, useQueryClient } from '@tanstack/react-query'
import { FlaskConical, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { FormField } from '@/components/common/FormField'
import { PageHeader } from '@/components/common/PageHeader'
import { SimulatedBadge } from '@/components/common/StatusBadge'
import { Button } from '@/components/ui/button'
import { SIMULATOR_SCENARIOS } from '@/constants/simulatorScenarios'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Select } from '@/components/ui/input'
import { useSelectedMerchantId } from '@/features/branches/useBranchQueries'
import { invalidateMerchantPayments, usePayableInvoices } from '@/features/payments/paymentQueries'
import { bankSimulator } from '@/services'
import type { SimulatorRunResult, SimulatorScenarioId } from '@/services/bankSimulatorService'
import { PaymentServiceError } from '@/services/paymentServiceError'

/**
 * DEMO ONLY. Sends SIMULATED events through the provider adapter into the trusted processor.
 * Never routed in builds without demo tools, and every result it creates is marked simulated.
 */
export function BankSimulatorPage() {
  const merchantId = useSelectedMerchantId()
  const queryClient = useQueryClient()
  const payableQuery = usePayableInvoices()
  const [scenarioId, setScenarioId] = useState<SimulatorScenarioId>('success')
  const [reference, setReference] = useState('')
  const [amount, setAmount] = useState('')
  const [result, setResult] = useState<SimulatorRunResult | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const scenario = SIMULATOR_SCENARIOS.find((s) => s.id === scenarioId)!

  const run = useMutation({
    mutationFn: () => {
      if (!bankSimulator) throw new Error('Demo tools are disabled.')
      return bankSimulator.run(merchantId, {
        scenarioId,
        reference: reference.trim() || undefined,
        amount: amount ? Number(amount) : undefined,
      })
    },
    onSuccess: async (outcome) => {
      setResult(outcome)
      await invalidateMerchantPayments(queryClient, merchantId)
    },
    onError: (error) =>
      setErrorMessage(
        error instanceof PaymentServiceError ? error.message : 'The simulation failed.',
      ),
  })

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title="Bank simulator"
        description="Send simulated bank events to see reconciliation work end to end."
      />
      <div
        role="note"
        className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning-soft px-3 py-2 text-xs text-warning"
      >
        <FlaskConical className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
        <p>
          <strong className="font-semibold">Demo tool.</strong> Everything created here is simulated
          and marked so. It exists only in development and demo builds, and is not how real banks
          reach OuPay.
        </p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>Scenario</CardTitle>
          <CardDescription>{scenario.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-4"
            noValidate
            onSubmit={(event) => {
              event.preventDefault()
              setErrorMessage(null)
              setResult(null)
              run.mutate()
            }}
          >
            <FormField label="Scenario" required>
              {(control) => (
                <Select
                  {...control}
                  value={scenarioId}
                  onChange={(e) => setScenarioId(e.target.value as SimulatorScenarioId)}
                >
                  {SIMULATOR_SCENARIOS.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.label}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField
              label="Invoice or request reference"
              required={scenario.needsReference}
              hint="Pick an invoice, or type an exact payment reference."
            >
              {(control) => (
                <>
                  <Select
                    {...control}
                    value=""
                    onChange={(e) => e.target.value && setReference(e.target.value)}
                  >
                    <option value="">Choose an invoice…</option>
                    {(payableQuery.data ?? []).map((invoice) => (
                      <option key={invoice.invoiceId} value={invoice.invoiceNumber}>
                        {invoice.invoiceNumber} · {invoice.customerName} ·{' '}
                        {invoice.remainingBalance} RWF left
                      </option>
                    ))}
                  </Select>
                  <Input
                    aria-label="Reference"
                    className="mt-2"
                    value={reference}
                    onChange={(e) => setReference(e.target.value)}
                    autoComplete="off"
                  />
                </>
              )}
            </FormField>
            <FormField
              label="Amount (RWF)"
              hint="Leave empty to use the invoice's remaining balance."
            >
              {(control) => (
                <Input
                  {...control}
                  inputMode="numeric"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
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
            <Button type="submit" disabled={run.isPending} aria-busy={run.isPending}>
              {run.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
              Run simulation
            </Button>
          </form>
        </CardContent>
      </Card>
      {result && (
        <Card aria-live="polite">
          <CardHeader>
            <CardTitle>Result</CardTitle>
          </CardHeader>
          <CardContent>
            <ol className="divide-y">
              {result.steps.map((step, index) => (
                <li key={index} className="space-y-0.5 py-2.5 text-sm">
                  <p className="flex flex-wrap items-center gap-2 font-medium">
                    {step.description} <SimulatedBadge />
                  </p>
                  <p className="text-muted-foreground">
                    Outcome: {step.outcome}
                    {step.reason ? ` · ${step.reason}` : ''}
                  </p>
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
