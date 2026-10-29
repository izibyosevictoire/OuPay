import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { reconciliationService } from '@/services'
import { PaymentServiceError } from '@/services/paymentServiceError'
import { SAMPLE_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { findAccessibilityViolations } from '@/test/axe'
import { getActiveTestBackend, useFastBackend, type DemoUserKey } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'
import type { BankAttribution } from '@/types/bankAttribution'
import type { AuditEntry, BankTransactionDetails, BankTransactionView } from '@/types/payment'
import { codePaymentFacts, explainCodePayment, isCodePayment } from './codePayment'

const M = SAMPLE_MERCHANT_ID

beforeEach(() => {
  useFastBackend()
})

/** An incoming payment with nothing established beyond the bank's confirmation. */
const base = (
  transactionId: string,
  overrides: Partial<BankAttribution> = {},
): BankAttribution => ({
  merchantId: M,
  transactionId,
  providerTransactionId: `prov-${transactionId}`,
  transactionStatus: 'CONFIRMED',
  amountRwf: 12_000,
  occurredAt: '2026-10-28T10:00:00Z',
  reportedCode: null,
  reportedCodeMasked: false,
  collectionCode: null,
  attributionStatus: 'NOT_REPORTED',
  attributionBasis: 'ACCOUNT_ONLY',
  agentAttribution: 'UNRESOLVED',
  agentName: null,
  saleReference: null,
  saleInvoiceId: null,
  stage: 'AWAITING_MATCHING',
  codeResolved: false,
  saleReferenceNamed: false,
  saleReferenceMatched: false,
  allocatedToSaleRwf: 0,
  allocationOrigin: null,
  saleFullyPaid: false,
  reviewState: 'NONE',
  createdAt: '2026-10-28T10:00:01Z',
  ...overrides,
})

const COUNTER = { id: 'cc-1', label: 'Counter', branchId: null }

/** The situations the screens must tell apart. Each one is a different set of facts, not a different colour. */
const SCENARIOS = {
  confirmedUnmatched: (id: string) =>
    base(id, {
      saleReferenceNamed: true,
      saleReference: 'OP-ABCDEFGHJKMN',
      saleInvoiceId: 'inv-1',
      agentAttribution: 'SALE_NAMED_UNCONFIRMED',
    }),
  codeResolved: (id: string) =>
    base(id, {
      attributionStatus: 'RESOLVED',
      attributionBasis: 'CODE_REPORTED',
      reportedCode: 'EQ-LIVE-A1',
      collectionCode: COUNTER,
      codeResolved: true,
      stage: 'CODE_RESOLVED',
    }),
  autoPartial: (id: string) =>
    base(id, {
      attributionStatus: 'RESOLVED',
      attributionBasis: 'CODE_REPORTED',
      reportedCode: 'EQ-LIVE-A1',
      collectionCode: COUNTER,
      codeResolved: true,
      saleReferenceNamed: true,
      saleReferenceMatched: true,
      saleReference: 'OP-ABCDEFGHJKMN',
      saleInvoiceId: 'inv-1',
      agentAttribution: 'CONFIRMED_FROM_SALE_SNAPSHOT',
      agentName: 'Aline Uwase',
      allocatedToSaleRwf: 5_000,
      allocationOrigin: 'AUTO_REFERENCE',
      stage: 'ALLOCATED',
    }),
  autoPaid: (id: string) =>
    base(id, {
      attributionStatus: 'RESOLVED',
      attributionBasis: 'CODE_REPORTED',
      reportedCode: 'EQ-LIVE-A1',
      collectionCode: COUNTER,
      codeResolved: true,
      saleReferenceNamed: true,
      saleReferenceMatched: true,
      saleReference: 'OP-ABCDEFGHJKMN',
      saleInvoiceId: 'inv-1',
      agentAttribution: 'CONFIRMED_FROM_SALE_SNAPSHOT',
      agentName: 'Aline Uwase',
      allocatedToSaleRwf: 12_000,
      allocationOrigin: 'AUTO_REFERENCE',
      saleFullyPaid: true,
      stage: 'FULLY_PAID',
    }),
  manualPaid: (id: string) =>
    base(id, {
      saleReferenceNamed: true,
      saleReference: 'OP-ABCDEFGHJKMN',
      saleInvoiceId: 'inv-1',
      agentAttribution: 'SALE_NAMED_UNCONFIRMED',
      allocatedToSaleRwf: 12_000,
      allocationOrigin: 'MANUAL',
      saleFullyPaid: true,
      stage: 'FULLY_PAID',
    }),
  conflict: (id: string) =>
    base(id, {
      attributionStatus: 'CONFLICT',
      attributionBasis: 'CODE_REPORTED',
      reportedCode: 'EQ-LIVE-B2',
      collectionCode: { id: 'cc-2', label: 'Other', branchId: null },
      codeResolved: true,
      saleReferenceNamed: true,
      saleReference: 'OP-ABCDEFGHJKMN',
      saleInvoiceId: 'inv-1',
      stage: 'CONFLICT',
    }),
  reversed: (id: string) =>
    base(id, {
      transactionStatus: 'REVERSED',
      attributionStatus: 'RESOLVED',
      attributionBasis: 'CODE_REPORTED',
      reportedCode: 'EQ-LIVE-A1',
      collectionCode: COUNTER,
      codeResolved: true,
      saleReferenceNamed: true,
      saleReference: 'OP-ABCDEFGHJKMN',
      agentAttribution: 'CONFIRMED_FROM_SALE_SNAPSHOT',
      stage: 'NOT_CONFIRMED',
    }),
  unknownCode: (id: string) =>
    base(id, {
      attributionStatus: 'UNRESOLVED',
      attributionBasis: 'CODE_REPORTED',
      reportedCode: '••••-9',
      reportedCodeMasked: true,
    }),
} satisfies Record<string, (id: string) => BankAttribution>

const stateOf = (a: BankAttribution, id: string) => codePaymentFacts(a).find((f) => f.id === id)!

describe('the five facts about a code payment are different facts', () => {
  it('shows confirmed but unmatched funds as confirmed, with nothing attributed, matched, applied or paid', () => {
    const a = SCENARIOS.confirmedUnmatched('t')
    expect(isCodePayment(a)).toBe(true)
    expect(stateOf(a, 'confirmed')).toMatchObject({ state: 'done', stateText: 'Confirmed' })
    expect(stateOf(a, 'code')).toMatchObject({ state: 'none', stateText: 'No code reported' })
    expect(stateOf(a, 'sale')).toMatchObject({ state: 'open', stateText: 'Named, not matched' })
    expect(stateOf(a, 'allocated')).toMatchObject({ state: 'none', stateText: 'Nothing applied' })
    expect(stateOf(a, 'paid')).toMatchObject({ state: 'open', stateText: 'Not fully paid' })
    expect(explainCodePayment(a)).toMatch(/did not report a collection code/)
    expect(explainCodePayment(a)).toMatch(/agent is not confirmed/)
  })

  it('shows a resolved code with no sale matched, and says why no sale was matched', () => {
    const a = SCENARIOS.codeResolved('t')
    expect(stateOf(a, 'code')).toMatchObject({ state: 'done', stateText: 'Resolved' })
    expect(stateOf(a, 'sale')).toMatchObject({ state: 'none', stateText: 'None' })
    expect(explainCodePayment(a)).toMatch(/no exact sale reference, so no sale was matched/)
  })

  it('never describes manual money as an automatic match', () => {
    const manual = SCENARIOS.manualPaid('t')
    const text = `${explainCodePayment(manual)} ${codePaymentFacts(manual)
      .map((f) => f.detail)
      .join(' ')}`
    expect(text).toMatch(/by hand/)
    // Saying it was NOT matched automatically is accurate; claiming an automatic match or application is not.
    expect(text).not.toMatch(/(?<!not )(matched|applied) automatically|on complete bank evidence/i)
    // Paid, yet the sale reference is not "matched" and the agent is not confirmed: separate facts.
    expect(stateOf(manual, 'paid')).toMatchObject({ state: 'done', stateText: 'Fully paid' })
    expect(stateOf(manual, 'sale').stateText).not.toBe('Matched')
    const auto = SCENARIOS.autoPaid('t')
    expect(explainCodePayment(auto)).toMatch(/Matched automatically/)
    expect(stateOf(auto, 'sale')).toMatchObject({ state: 'done', stateText: 'Matched' })
  })

  it('tells a partly paid sale from a fully paid one', () => {
    const partial = SCENARIOS.autoPartial('t')
    expect(stateOf(partial, 'allocated').detail).toMatch(/RWF\s5,000 of RWF\s12,000 applied/)
    expect(stateOf(partial, 'paid')).toMatchObject({ state: 'open', stateText: 'Not fully paid' })
    expect(explainCodePayment(partial)).toMatch(/still has a balance/)
    expect(stateOf(SCENARIOS.autoPaid('t'), 'paid')).toMatchObject({
      state: 'done',
      stateText: 'Fully paid',
    })
  })

  it('shows a conflict as a problem that can never be overridden, and a reversal as no longer confirmed', () => {
    const conflict = SCENARIOS.conflict('t')
    expect(stateOf(conflict, 'code')).toMatchObject({ state: 'problem', stateText: 'Conflict' })
    expect(explainCodePayment(conflict)).toMatch(/can never be overridden/)
    const reversed = SCENARIOS.reversed('t')
    expect(stateOf(reversed, 'confirmed')).toMatchObject({
      state: 'problem',
      stateText: 'Reversed',
    })
    expect(explainCodePayment(reversed)).toMatch(/reversed this payment/)
    expect(stateOf(SCENARIOS.unknownCode('t'), 'code')).toMatchObject({
      state: 'problem',
      stateText: 'Not recognised',
    })
  })

  it('treats money for an ordinary invoice as not a code payment at all', () => {
    expect(isCodePayment(base('t'))).toBe(false)
    expect(isCodePayment(undefined)).toBe(false)
  })
})

/** The mock's own transactions, so the screens render real rows. */
async function sampleTransactions(user: DemoUserKey = 'owner') {
  const backend = getActiveTestBackend()
  backend.signInAs(user)
  return backend.fastReconciliation.listBankTransactions(M)
}

describe('transactions list', () => {
  it('shows the code payment stage next to the bank and reconciliation status, and the sale and agent only as far as the evidence goes', async () => {
    const txs = await sampleTransactions()
    const [first, second, third] = txs
    vi.spyOn(reconciliationService, 'listBankAttributions').mockResolvedValue([
      SCENARIOS.confirmedUnmatched(first!.id),
      SCENARIOS.autoPaid(second!.id),
      SCENARIOS.manualPaid(third!.id),
    ])
    await renderAppAt('/transactions')
    await screen.findByRole('table')
    const rows = within(screen.getByRole('table')).getAllByRole('row').slice(1)
    const rowOf = (id: string) =>
      rows.find((r) =>
        within(r).queryByRole('link', {
          name: new RegExp(txs.find((t) => t.id === id)!.paymentReference ?? 'No reference'),
        }),
      )!
    const unmatched = rowOf(first!.id)
    expect(within(unmatched).getByText('Verified funds awaiting matching')).toBeInTheDocument()
    expect(unmatched).toHaveTextContent('Sale OP-ABCDEFGHJKMN')
    expect(unmatched).not.toHaveTextContent('Agent')
    const paid = rowOf(second!.id)
    expect(within(paid).getByText('Sale fully paid')).toBeInTheDocument()
    expect(paid).toHaveTextContent('Agent Aline Uwase')
    expect(paid).toHaveTextContent('Counter')
    // The manual one is paid too, but names no agent: it was not confirmed by the bank.
    const manual = rowOf(third!.id)
    expect(within(manual).getByText('Sale fully paid')).toBeInTheDocument()
    expect(manual).not.toHaveTextContent('Agent')
  })

  it('filters by code payment stage, and searches by sale reference and agent', async () => {
    const user = userEvent.setup()
    const txs = await sampleTransactions()
    vi.spyOn(reconciliationService, 'listBankAttributions').mockResolvedValue([
      SCENARIOS.conflict(txs[0]!.id),
      SCENARIOS.autoPaid(txs[1]!.id),
    ])
    await renderAppAt('/transactions')
    const table = await screen.findByRole('table')
    await user.selectOptions(screen.getByLabelText('Code payment'), 'CONFLICT')
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(1)
    expect(within(table).getByText('Conflict: needs investigation')).toBeInTheDocument()
    await user.selectOptions(screen.getByLabelText('Code payment'), 'NOT_CODE')
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(txs.length - 2)
    await user.selectOptions(screen.getByLabelText('Code payment'), 'CODE')
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(2)
    await user.selectOptions(screen.getByLabelText('Code payment'), 'ALL')
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'aline')
    expect(within(table).getAllByRole('row').slice(1).length).toBeGreaterThan(0)
    expect(within(table).getByText('Sale fully paid')).toBeInTheDocument()
  })

  it('still lists every transaction when the code payment details cannot be loaded', async () => {
    const txs = await sampleTransactions()
    vi.spyOn(reconciliationService, 'listBankAttributions').mockRejectedValue(
      new PaymentServiceError('service_unavailable', 'down'),
    )
    await renderAppAt('/transactions')
    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(txs.length)
    expect(await screen.findByText(/Code payment details could not be loaded/)).toBeInTheDocument()
  })

  it('is usable on a phone: a stacked list with the stage on every card, and the table only on wide screens', async () => {
    const txs = await sampleTransactions()
    vi.spyOn(reconciliationService, 'listBankAttributions').mockResolvedValue([
      SCENARIOS.autoPartial(txs[0]!.id),
    ])
    const { container } = await renderAppAt('/transactions')
    await screen.findByRole('table')
    const list = screen.getByRole('list', { name: 'Bank transactions' })
    expect(list).toHaveClass('lg:hidden')
    expect(within(list).getByText('Money allocated, sale not fully paid')).toBeInTheDocument()
    expect(screen.getByRole('table')).toHaveClass('hidden', 'lg:table')
    // The filter form stacks on a phone and the search field spans the row.
    expect(screen.getByRole('search', { name: 'Filter transactions' })).toHaveClass(
      'sm:grid-cols-2',
    )
    expect(await findAccessibilityViolations(container)).toEqual([])
  })
})

describe('transactions pagination', () => {
  const many = async (count: number): Promise<BankTransactionView[]> => {
    const [one] = await sampleTransactions()
    return Array.from({ length: count }, (_, i) => ({
      ...one!,
      id: `tx-page-${i}`,
      providerTransactionId: `prov-${i}`,
      paymentReference: `REF-${String(i).padStart(3, '0')}`,
      providerOccurredAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 100 - i)).toISOString(),
      invoices: [],
    }))
  }

  it('pages a long list, says where you are, and starts again when a filter changes', async () => {
    const user = userEvent.setup()
    vi.spyOn(reconciliationService, 'listBankTransactions').mockResolvedValue(await many(40))
    await renderAppAt('/transactions')
    const table = await screen.findByRole('table')
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(15)
    expect(within(table).getByRole('rowheader', { name: 'REF-000' })).toBeInTheDocument()
    const pages = screen.getByRole('navigation', { name: 'Transactions pages' })
    expect(within(pages).getByText('Showing 1–15 of 40')).toBeInTheDocument()
    expect(within(pages).getByRole('button', { name: 'Previous' })).toBeDisabled()

    await user.click(within(pages).getByRole('button', { name: 'Next' }))
    expect(within(pages).getByText('Showing 16–30 of 40')).toBeInTheDocument()
    expect(within(table).getByRole('rowheader', { name: 'REF-015' })).toBeInTheDocument()
    await user.click(within(pages).getByRole('button', { name: 'Next' }))
    expect(within(pages).getByText('Showing 31–40 of 40')).toBeInTheDocument()
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(10)
    expect(within(pages).getByRole('button', { name: 'Next' })).toBeDisabled()

    // A filter is a different list: back to its first page.
    await user.type(screen.getByRole('searchbox', { name: 'Search' }), 'REF-03')
    expect(within(table).getAllByRole('row').slice(1)).toHaveLength(10)
    expect(screen.queryByRole('navigation', { name: 'Transactions pages' })).not.toBeInTheDocument()
  })

  it('shows no page controls for a short list', async () => {
    vi.spyOn(reconciliationService, 'listBankTransactions').mockResolvedValue(await many(5))
    await renderAppAt('/transactions')
    await screen.findByRole('table')
    expect(screen.queryByRole('navigation', { name: 'Transactions pages' })).not.toBeInTheDocument()
  })
})

describe('transaction details', () => {
  const auditOf = (transactionId: string): AuditEntry[] => [
    {
      id: 'a1',
      merchantId: M,
      kind: 'ATTRIBUTION_RECORDED',
      actorUserId: null,
      message: 'Attribution not reported.',
      bankTransactionId: transactionId,
      invoiceId: null,
      createdAt: '2026-10-28T10:00:02Z',
    },
    {
      id: 'a2',
      merchantId: M,
      kind: 'MANUAL_ALLOCATED',
      actorUserId: 'usr-1',
      message: 'Manually applied RWF 12000 to invoice INV-0007. Note: Customer showed the bank SMS',
      bankTransactionId: transactionId,
      invoiceId: 'inv-1',
      createdAt: '2026-10-28T11:00:00Z',
    },
  ]

  async function open(scenario: (id: string) => BankAttribution, user: DemoUserKey = 'owner') {
    const [tx] = await sampleTransactions()
    const real = await getActiveTestBackend().fastReconciliation.getBankTransaction(M, tx!.id)
    const details: BankTransactionDetails = { ...real, auditHistory: auditOf(tx!.id) }
    vi.spyOn(reconciliationService, 'getBankTransaction').mockResolvedValue(details)
    vi.spyOn(reconciliationService, 'getBankAttribution').mockResolvedValue(scenario(tx!.id))
    return renderAppAt(`/transactions/${tx!.id}`, { signedInAs: user })
  }

  it('lists the five facts separately, with the sale, the collection code, the amounts and a way to the invoice', async () => {
    const { container } = await open(SCENARIOS.autoPaid)
    const panel = (await screen.findByText('Code payment', { selector: 'h2, h3, div' })).closest(
      'div',
    )!
    expect(panel).toBeTruthy()
    const facts = await screen.findByRole('list', { name: 'What is established' })
    const items = within(facts).getAllByRole('listitem')
    expect(items.map((li) => li.getAttribute('data-fact'))).toEqual([
      'confirmed',
      'code',
      'sale',
      'allocated',
      'paid',
    ])
    expect(items.map((li) => li.getAttribute('data-state'))).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
    ])
    expect(screen.getByText('Sale fully paid')).toBeInTheDocument()
    expect(screen.getByText('OP-ABCDEFGHJKMN')).toBeInTheDocument()
    expect(screen.getAllByText('Counter').length).toBeGreaterThan(0)
    expect(screen.getByText('Aline Uwase')).toBeInTheDocument()
    expect(screen.getByText('Applied automatically on complete bank evidence')).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /View the sale’s invoice/ })).toHaveAttribute(
      'href',
      '/invoices/inv-1',
    )
    expect(await findAccessibilityViolations(container)).toEqual([])
  })

  it('shows a manually reconciled sale as paid by hand, with its reason, and an unconfirmed agent', async () => {
    await open(SCENARIOS.manualPaid)
    await screen.findByRole('list', { name: 'What is established' })
    expect(screen.getByText('Applied by hand by an authorised person')).toBeInTheDocument()
    expect(screen.getByTestId('code-payment-explanation')).toHaveTextContent(
      /applied to the sale by hand/,
    )
    expect(screen.getByTestId('code-payment-explanation')).not.toHaveTextContent(
      /Matched automatically/,
    )
    expect(screen.getByText(/Not confirmed: the sale is named/)).toBeInTheDocument()
    expect(screen.queryByText('Aline Uwase')).not.toBeInTheDocument()
    const history = screen.getByRole('list', { name: 'Manual reconciliation history' })
    expect(within(history).getByText(/Customer showed the bank SMS/)).toBeInTheDocument()
  })

  it('explains a conflict and keeps the agent out of it', async () => {
    await open(SCENARIOS.conflict)
    await screen.findByRole('list', { name: 'What is established' })
    expect(screen.getByTestId('code-payment-explanation')).toHaveTextContent(
      /can never be overridden by hand/,
    )
    expect(screen.getByText('Conflict: needs investigation')).toBeInTheDocument()
    expect(screen.queryByText('Aline Uwase')).not.toBeInTheDocument()
  })

  it('shows a reversal without inventing a paid sale', async () => {
    await open(SCENARIOS.reversed)
    const facts = await screen.findByRole('list', { name: 'What is established' })
    expect(within(facts).getByText('Reversed')).toBeInTheDocument()
    expect(screen.getByText('Not confirmed by the bank')).toBeInTheDocument()
    expect(within(facts).queryByText('Fully paid')).not.toBeInTheDocument()
  })

  it('labels a simulated payment and never calls it a real deposit', async () => {
    await open(SCENARIOS.confirmedUnmatched)
    await screen.findByRole('list', { name: 'What is established' })
    // Everything the mock provider reports is simulated.
    expect(screen.getByRole('note')).toHaveTextContent(/Simulated payment from the demo provider/)
    expect(screen.getByRole('note')).toHaveTextContent(/not a deposit into a real bank account/)
  })

  it('shows the manual reconciliation history only to people who may reconcile', async () => {
    await open(SCENARIOS.manualPaid, 'cashier').catch(() => undefined)
    // A cashier is not allowed to reconcile: the history block never renders for them.
    await waitFor(() => {
      expect(
        screen.queryByRole('list', { name: 'Manual reconciliation history' }),
      ).not.toBeInTheDocument()
    })
  })

  it('does not show a code payment panel for money that is not a code payment', async () => {
    await open((id) => base(id))
    await screen.findByText('Allocations')
    expect(screen.queryByRole('list', { name: 'What is established' })).not.toBeInTheDocument()
  })

  it('says a payment is not found when the server will not show it', async () => {
    const [tx] = await sampleTransactions()
    vi.spyOn(reconciliationService, 'getBankAttribution').mockRejectedValue(
      new PaymentServiceError('not_found', 'not here'),
    )
    await renderAppAt(`/transactions/${tx!.id}`)
    await screen.findByText('Allocations')
    expect(screen.queryByRole('list', { name: 'What is established' })).not.toBeInTheDocument()
  })
})
