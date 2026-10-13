import type { SimulatorScenario } from '@/services/bankSimulatorService'

/** Static copy of the simulator's scenario list, so the demo page can describe them without a round trip. */
export const SIMULATOR_SCENARIOS: SimulatorScenario[] = [
  {
    id: 'success',
    label: 'Successful payment',
    description: 'The bank confirms the full amount with the exact reference.',
    needsReference: true,
  },
  {
    id: 'pending',
    label: 'Pending payment',
    description: 'The bank reports the payment as pending. Nothing is counted yet.',
    needsReference: true,
  },
  {
    id: 'failed',
    label: 'Failed payment',
    description: 'The bank rejects the payment. Nothing is counted.',
    needsReference: true,
  },
  {
    id: 'duplicate',
    label: 'Duplicate webhook',
    description: 'The same confirmation arrives twice. It must be counted once.',
    needsReference: true,
  },
  {
    id: 'invalid_reference',
    label: 'Invalid reference',
    description: 'Money arrives with a reference that matches nothing. It goes to review.',
    needsReference: false,
  },
  {
    id: 'unmatched',
    label: 'Unmatched payment',
    description: 'Money arrives with no reference at all. It stays unmatched.',
    needsReference: false,
  },
  {
    id: 'partial',
    label: 'Partial payment',
    description: 'Half of the invoice is paid. The rest stays outstanding.',
    needsReference: true,
  },
  {
    id: 'multiple',
    label: 'Multiple payments',
    description: 'Two separate payments settle one invoice.',
    needsReference: true,
  },
  {
    id: 'reversal',
    label: 'Reversal',
    description: 'A confirmed payment is reversed by the bank; the invoice balance is restored.',
    needsReference: true,
  },
  {
    id: 'out_of_order',
    label: 'Out-of-order events',
    description:
      'A reversal arrives before the older confirmation. The old event must not resurrect the payment.',
    needsReference: true,
  },
  {
    id: 'same_amount_concurrent',
    label: 'Same-amount concurrent',
    description:
      'Two payments of the same amount arrive together; only the one with the exact reference is matched.',
    needsReference: true,
  },
]
