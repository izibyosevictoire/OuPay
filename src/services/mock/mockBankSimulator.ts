import { SIMULATOR_SCENARIOS } from '@/constants/simulatorScenarios'
import { isDemoToolsEnabled } from '@/lib/demoTools'
import { getAdapter } from '@/services/banking/providerRegistry'
import { InvalidProviderEventError } from '@/services/banking/bankingProviderAdapter'
import type { SimulatedEquityEventV0 } from '@/services/banking/equityMockAdapter'
import type {
  BankSimulatorService,
  RequestSimulationKind,
  SimulatorRunInput,
  SimulatorRunResult,
  SimulatorStep,
} from '@/services/bankSimulatorService'
import { PaymentServiceError } from '@/services/paymentServiceError'
import { createMockAuthStore, type MockAuthStore } from './mockAuthStore'
import { createBankEventProcessor } from './ledger/bankEventProcessor'
import { createLedgerOperations } from './ledger/ledgerOperations'
import { createLedgerStore, type LedgerStore } from './ledger/mockLedgerStore'
import { createOperationRunner } from './mockOrganizationAccess'
import { requirePaymentActor } from './mockPaymentAccess'

interface MockBankSimulatorOptions {
  authStore?: MockAuthStore
  ledger?: LedgerStore
  delayInMilliseconds?: number
  now?: () => Date
}

const SCENARIOS = SIMULATOR_SCENARIOS

const randomId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 10).toUpperCase()}`

/**
 * MOCK-ONLY simulator. All input goes through the adapter's normalizeTransactionEvent and the
 * trusted event processor, exactly like a real provider event would. It refuses to work when
 * demo tools are disabled.
 */
export function createMockBankSimulator(
  options: MockBankSimulatorOptions = {},
): BankSimulatorService {
  const store = options.authStore ?? createMockAuthStore()
  const ledger = options.ledger ?? createLedgerStore(store)
  const clock = options.now ?? (() => new Date())
  const ops = createLedgerOperations(store, ledger, clock)
  const processor = createBankEventProcessor(store, ledger, clock)
  const run = createOperationRunner(options.delayInMilliseconds ?? 300)

  const requireDemo = () => {
    if (!isDemoToolsEnabled()) {
      throw new PaymentServiceError('forbidden', 'Demo tools are disabled in this build.')
    }
  }

  const connectedAccount = (merchantId: string): string => {
    const connection = ledger.bankConnections
      .load()
      .find((c) => c.merchantId === merchantId && c.status === 'CONNECTED' && c.bankAccountId)
    if (!connection?.bankAccountId) {
      throw new PaymentServiceError(
        'invalid_state',
        'Link a demo bank account first (Banking), then simulate payments.',
      )
    }
    return connection.bankAccountId
  }

  const secondsFromNow = (seconds: number) =>
    new Date(clock().getTime() + seconds * 1000).toISOString()

  /** Pushes one raw simulated event through normalisation and the trusted processor. */
  const send = (description: string, raw: SimulatedEquityEventV0): SimulatorStep => {
    try {
      const adapter = getAdapter('EQUITY_MOCK')!
      const result = processor.processEvent(adapter.normalizeTransactionEvent(raw))
      return {
        description,
        outcome: result.outcome,
        reason: result.reason,
        transactionId: result.transactionId,
      }
    } catch (error) {
      if (error instanceof InvalidProviderEventError) {
        return { description, outcome: 'INVALID', reason: error.message }
      }
      throw error
    }
  }

  const event = (
    accountRef: string,
    state: SimulatedEquityEventV0['state'],
    amount: number,
    reference: string | null,
    at: string,
    ids: { eventId?: string; transactionId: string },
  ): SimulatedEquityEventV0 => ({
    __simulated: true,
    eventId: ids.eventId ?? randomId('SIM-EVT'),
    transactionId: ids.transactionId,
    state,
    amount,
    currency: 'RWF',
    reference,
    payerName: 'Demo Payer (simulated)',
    occurredAt: at,
    accountRef,
  })

  /** What the reference would still owe: the invoice's remaining balance, if it names one. */
  const remainingFor = (merchantId: string, reference: string | undefined): number | undefined => {
    if (!reference) return undefined
    const request = ledger.paymentRequests
      .load()
      .find((r) => r.merchantId === merchantId && r.publicReference === reference)
    const invoice = store
      .loadInvoices()
      .find(
        (candidate) =>
          candidate.merchantId === merchantId &&
          (candidate.id === request?.invoiceId || candidate.invoiceNumber === reference),
      )
    if (invoice) return ops.decorate(invoice).payment!.remainingBalance
    return request?.requestedAmount
  }

  const runScenario = (merchantId: string, input: SimulatorRunInput): SimulatorRunResult => {
    const account = connectedAccount(merchantId)
    const reference = input.reference?.trim() || undefined
    const scenario = SCENARIOS.find((s) => s.id === input.scenarioId)
    if (!scenario) throw new PaymentServiceError('validation', 'Unknown scenario.')
    if (scenario.needsReference && !reference) {
      throw new PaymentServiceError(
        'validation',
        'Choose an invoice or request reference for this scenario.',
      )
    }
    const remaining = remainingFor(merchantId, reference)
    const full = input.amount ?? remaining ?? 10_000
    if (!Number.isInteger(full) || full <= 0) {
      throw new PaymentServiceError(
        'validation',
        'The amount must be a positive whole number of francs.',
      )
    }
    const half = Math.max(Math.floor(full / 2), 1)
    const tx = randomId('SIM-TX')
    const steps: SimulatorStep[] = []

    switch (input.scenarioId) {
      case 'success':
        steps.push(
          send(
            'Bank confirms the payment',
            event(account, 'POSTED', full, reference ?? null, secondsFromNow(0), {
              transactionId: tx,
            }),
          ),
        )
        break
      case 'pending':
        steps.push(
          send(
            'Bank reports the payment as pending',
            event(account, 'PENDING', full, reference ?? null, secondsFromNow(0), {
              transactionId: tx,
            }),
          ),
        )
        break
      case 'failed':
        steps.push(
          send(
            'Bank rejects the payment',
            event(account, 'REJECTED', full, reference ?? null, secondsFromNow(0), {
              transactionId: tx,
            }),
          ),
        )
        break
      case 'duplicate': {
        const posted = event(account, 'POSTED', full, reference ?? null, secondsFromNow(0), {
          transactionId: tx,
        })
        steps.push(send('Bank confirms the payment', posted))
        steps.push(send('The SAME event is delivered again', posted))
        break
      }
      case 'invalid_reference':
        steps.push(
          send(
            'Bank confirms a payment with an unknown reference',
            event(account, 'POSTED', full, 'NO-SUCH-REFERENCE', secondsFromNow(0), {
              transactionId: tx,
            }),
          ),
        )
        break
      case 'unmatched':
        steps.push(
          send(
            'Bank confirms a payment with no reference',
            event(account, 'POSTED', full, null, secondsFromNow(0), { transactionId: tx }),
          ),
        )
        break
      case 'partial':
        steps.push(
          send(
            `Bank confirms a partial payment of ${half}`,
            event(account, 'POSTED', half, reference ?? null, secondsFromNow(0), {
              transactionId: tx,
            }),
          ),
        )
        break
      case 'multiple':
        steps.push(
          send(
            'First payment (half)',
            event(account, 'POSTED', half, reference ?? null, secondsFromNow(0), {
              transactionId: tx,
            }),
          ),
        )
        steps.push(
          send(
            'Second payment (the rest)',
            event(account, 'POSTED', full - half, reference ?? null, secondsFromNow(1), {
              transactionId: randomId('SIM-TX'),
            }),
          ),
        )
        break
      case 'reversal':
        steps.push(
          send(
            'Bank confirms the payment',
            event(account, 'POSTED', full, reference ?? null, secondsFromNow(0), {
              transactionId: tx,
            }),
          ),
        )
        steps.push(
          send(
            'Bank reverses the payment',
            event(account, 'REVERSED', full, reference ?? null, secondsFromNow(5), {
              transactionId: tx,
            }),
          ),
        )
        break
      case 'out_of_order':
        steps.push(
          send(
            'A reversal arrives first (newer)',
            event(account, 'REVERSED', full, reference ?? null, secondsFromNow(10), {
              transactionId: tx,
            }),
          ),
        )
        steps.push(
          send(
            'The older confirmation arrives late',
            event(account, 'POSTED', full, reference ?? null, secondsFromNow(2), {
              transactionId: tx,
            }),
          ),
        )
        break
      case 'same_amount_concurrent': {
        const at = secondsFromNow(0)
        steps.push(
          send(
            'Payment A: same amount, exact reference',
            event(account, 'POSTED', full, reference ?? null, at, { transactionId: tx }),
          ),
        )
        steps.push(
          send(
            'Payment B: same amount, same time, NO reference',
            event(account, 'POSTED', full, null, at, { transactionId: randomId('SIM-TX') }),
          ),
        )
        break
      }
    }
    return { scenarioId: input.scenarioId, steps }
  }

  return {
    listScenarios: () =>
      run(() => {
        requireDemo()
        return SCENARIOS
      }),

    run: (merchantId, input) =>
      run(() => {
        requireDemo()
        requirePaymentActor(store, merchantId, 'payments:reconcile')
        return runScenario(merchantId, input)
      }),

    simulateRequestPayment: (publicReference, kind: RequestSimulationKind) =>
      run(() => {
        requireDemo()
        const request = ledger.paymentRequests
          .load()
          .find((r) => r.publicReference === publicReference)
        if (!request)
          throw new PaymentServiceError('not_found', 'This payment page could not be found.')
        const account = connectedAccount(request.merchantId)
        const remaining =
          remainingFor(request.merchantId, publicReference) ?? request.requestedAmount
        const amount = request.invoiceId ? remaining : request.requestedAmount
        if (amount <= 0) throw new PaymentServiceError('invalid_state', 'Nothing is left to pay.')
        // One bank transaction per request, so pending, confirmed, failed and reversed events are
        // successive states of the SAME payment, exactly as a real provider would report them.
        const tx = `SIM-TX-${publicReference}`
        const steps: SimulatorStep[] = []
        if (kind === 'success') {
          steps.push(
            send(
              'Bank confirms the payment',
              event(account, 'POSTED', amount, publicReference, secondsFromNow(0), {
                transactionId: tx,
              }),
            ),
          )
        } else if (kind === 'pending') {
          steps.push(
            send(
              'Bank reports the payment as pending',
              event(account, 'PENDING', amount, publicReference, secondsFromNow(0), {
                transactionId: tx,
              }),
            ),
          )
        } else if (kind === 'failed') {
          steps.push(
            send(
              'Bank rejects the payment',
              event(account, 'REJECTED', amount, publicReference, secondsFromNow(0), {
                transactionId: tx,
              }),
            ),
          )
        } else {
          steps.push(
            send(
              'Bank confirms the payment',
              event(account, 'POSTED', amount, publicReference, secondsFromNow(0), {
                transactionId: tx,
              }),
            ),
          )
          steps.push(
            send(
              'Bank reverses the payment',
              event(account, 'REVERSED', amount, publicReference, secondsFromNow(5), {
                transactionId: tx,
              }),
            ),
          )
        }
        return { scenarioId: 'success', steps }
      }),
  }
}
