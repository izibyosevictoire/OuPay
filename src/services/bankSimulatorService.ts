import type { BankEventOutcome } from '@/types/payment'

export type SimulatorScenarioId =
  | 'success'
  | 'pending'
  | 'failed'
  | 'duplicate'
  | 'invalid_reference'
  | 'unmatched'
  | 'partial'
  | 'multiple'
  | 'reversal'
  | 'out_of_order'
  | 'same_amount_concurrent'

export interface SimulatorScenario {
  id: SimulatorScenarioId
  label: string
  description: string
  /** Whether the scenario needs an invoice reference to be meaningful. */
  needsReference: boolean
}

export interface SimulatorRunInput {
  scenarioId: SimulatorScenarioId
  /** An exact invoice number or payment-request reference. */
  reference?: string
  /** Integer RWF. Optional: sensible defaults come from the invoice's remaining balance. */
  amount?: number
}

export interface SimulatorStep {
  description: string
  outcome: BankEventOutcome | 'INVALID'
  reason?: string
  transactionId?: string
}

export interface SimulatorRunResult {
  scenarioId: SimulatorScenarioId
  steps: SimulatorStep[]
}

export type RequestSimulationKind = 'success' | 'pending' | 'failed' | 'reversal'

/**
 * DEMO ONLY. Feeds SIMULATED bank events through the provider adapter into the trusted event
 * processor. It exists only when demo tools are enabled, is reachable only from a labelled demo
 * screen, and everything it creates is marked simulated. It is how a developer proves the flow
 * without a real bank; it is NOT a way for a cashier or customer to confirm a payment.
 */
export interface BankSimulatorService {
  listScenarios(): Promise<SimulatorScenario[]>
  run(merchantId: string, input: SimulatorRunInput): Promise<SimulatorRunResult>
  /**
   * Simulates the bank's side of ONE customer payment request, identified by its public
   * reference (used by the demo buttons on the public payment page, where nobody is signed in).
   */
  simulateRequestPayment(
    publicReference: string,
    kind: RequestSimulationKind,
  ): Promise<SimulatorRunResult>
}
