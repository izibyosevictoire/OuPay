import {
  equityMockAdapter,
  type SimulatedEquityEventV0,
} from '@/services/banking/equityMockAdapter'
import { PaymentServiceError } from '@/services/paymentServiceError'
import type { Invoice } from '@/types/invoice'
import { createTestBackend } from '@/test/merchantTestDouble'
import { DEMO_USER_IDS } from '../sampleAccounts'
import { SAMPLE_BANK_ACCOUNT_IDS } from '../sampleLedger'
import { SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID } from '../sampleMerchants'

const MERCHANT = SAMPLE_MERCHANT_ID
const at = (seconds: number) => new Date(Date.UTC(2026, 9, 12, 10, 0, seconds)).toISOString()

let counter = 0
function setup() {
  const backend = createTestBackend()
  backend.signInAs('owner')
  const template = backend.store.loadInvoices().find((i) => i.id === 'inv-smp-inv-1044')!

  /** An issued invoice of exactly `total` RWF, assigned to the demo cashier. */
  const addInvoice = (number: string, total: number, overrides: Partial<Invoice> = {}) => {
    const invoice: Invoice = {
      ...template,
      id: `inv-${number.toLowerCase()}`,
      invoiceNumber: number,
      grandTotal: total,
      status: 'ISSUED',
      assignedToUserId: DEMO_USER_IDS.cashier,
      assignedToName: 'Aline Uwase',
      ...overrides,
    }
    backend.store.saveInvoices([...backend.store.loadInvoices(), invoice])
    return invoice
  }

  const send = (
    state: SimulatedEquityEventV0['state'],
    amount: number,
    reference: string | null,
    seconds: number,
    ids: { eventId?: string; transactionId?: string } = {},
    accountRef: string = SAMPLE_BANK_ACCOUNT_IDS.shop,
  ) => {
    counter += 1
    return backend.processor.processEvent(
      equityMockAdapter.normalizeTransactionEvent({
        __simulated: true,
        eventId: ids.eventId ?? `evt-${counter}`,
        transactionId: ids.transactionId ?? `tx-${counter}`,
        state,
        amount,
        currency: 'RWF',
        reference,
        payerName: 'Test Payer',
        occurredAt: at(seconds),
        accountRef,
      } satisfies SimulatedEquityEventV0),
    )
  }

  const invoice = (id: string) => backend.fastInvoices.getInvoice(MERCHANT, id)
  const as = (user: keyof typeof DEMO_USER_IDS) => backend.signInAs(user)
  return { ...backend, addInvoice, send, invoice, as }
}

describe('invoice balance is derived from confirmed allocations', () => {
  it('partial, full, then a reversal of the first payment (50,000 example)', async () => {
    const t = setup()
    const inv = t.addInvoice('T-50K', 50_000)

    expect(await t.invoice(inv.id)).toMatchObject({ paymentStatus: 'UNPAID' })

    t.send('POSTED', 20_000, 'T-50K', 1, { transactionId: 'first' })
    expect((await t.invoice(inv.id)).payment).toMatchObject({
      allocatedAmount: 20_000,
      remainingBalance: 30_000,
    })
    expect((await t.invoice(inv.id)).paymentStatus).toBe('PARTIALLY_PAID')

    t.send('POSTED', 30_000, 'T-50K', 2, { transactionId: 'second' })
    expect((await t.invoice(inv.id)).payment?.remainingBalance).toBe(0)
    expect((await t.invoice(inv.id)).paymentStatus).toBe('PAID')

    t.send('REVERSED', 20_000, 'T-50K', 3, { transactionId: 'first' })
    const after = await t.invoice(inv.id)
    expect(after.payment?.remainingBalance).toBe(20_000)
    expect(after.paymentStatus).toBe('PARTIALLY_PAID')
  })

  it('ignores a forged stored paymentStatus: only allocations count', async () => {
    const t = setup()
    const inv = t.addInvoice('T-FORGED', 10_000, { paymentStatus: 'PAID' })
    expect((await t.invoice(inv.id)).paymentStatus).toBe('UNPAID')
    expect((await t.invoice(inv.id)).payment?.remainingBalance).toBe(10_000)
  })

  it('does not count pending or failed payments', async () => {
    const t = setup()
    const inv = t.addInvoice('T-PEND', 10_000)
    t.send('PENDING', 10_000, 'T-PEND', 1, { transactionId: 'p' })
    t.send('REJECTED', 10_000, 'T-PEND', 2, { transactionId: 'f' })
    expect((await t.invoice(inv.id)).paymentStatus).toBe('UNPAID')
    t.send('POSTED', 10_000, 'T-PEND', 3, { transactionId: 'p' })
    expect((await t.invoice(inv.id)).paymentStatus).toBe('PAID')
  })

  it('stays derived after a manual correction restores the balance', async () => {
    const t = setup()
    const inv = t.addInvoice('T-FIX', 10_000)
    const result = t.send('POSTED', 10_000, 'T-FIX', 1)
    const details = await t.fastReconciliation.getBankTransaction(MERCHANT, result.transactionId!)
    const allocation = details.allocations[0]!
    await t.fastReconciliation.reverseAllocation(MERCHANT, allocation.id, {
      reason: 'Wrong invoice',
    })
    expect((await t.invoice(inv.id)).payment?.remainingBalance).toBe(10_000)
    // The reversed allocation stays on record.
    expect(
      (await t.fastReconciliation.listAllocations(MERCHANT)).find((a) => a.id === allocation.id),
    ).toMatchObject({ allocationStatus: 'REVERSED' })
  })
})

describe('matching rules', () => {
  it('matches only an exact reference: same amount and a different reference stays unmatched', async () => {
    const t = setup()
    const inv = t.addInvoice('T-EXACT', 5_000)
    // Same amount, no reference, and a near-miss reference: neither may match by amount or similarity.
    const noRef = t.send('POSTED', 5_000, null, 1)
    const nearMiss = t.send('POSTED', 5_000, 't-exact', 2)
    expect((await t.invoice(inv.id)).paymentStatus).toBe('UNPAID')
    const list = await t.fastReconciliation.listBankTransactions(MERCHANT)
    expect(list.find((x) => x.id === noRef.transactionId)?.reconciliationStatus).toBe('UNMATCHED')
    expect(list.find((x) => x.id === nearMiss.transactionId)?.reconciliationStatus).toBe(
      'UNMATCHED',
    )
    expect(list.find((x) => x.id === nearMiss.transactionId)?.reviewState).toBe('NEEDS_REVIEW')
  })

  it('two same-amount concurrent payments: only the exact reference is allocated', async () => {
    const t = setup()
    const a = t.addInvoice('T-A', 7_000)
    const b = t.addInvoice('T-B', 7_000)
    t.send('POSTED', 7_000, 'T-A', 1)
    t.send('POSTED', 7_000, null, 1)
    expect((await t.invoice(a.id)).paymentStatus).toBe('PAID')
    expect((await t.invoice(b.id)).paymentStatus).toBe('UNPAID')
  })

  it('counts a replayed event once', async () => {
    const t = setup()
    const inv = t.addInvoice('T-DUP', 10_000)
    const first = t.send('POSTED', 10_000, 'T-DUP', 1, { eventId: 'same', transactionId: 'dup-tx' })
    const second = t.send('POSTED', 10_000, 'T-DUP', 1, {
      eventId: 'same',
      transactionId: 'dup-tx',
    })
    expect(first.outcome).toBe('APPLIED')
    expect(second.outcome).toBe('DUPLICATE')
    expect(
      t.ledger.bankTransactions.load().filter((x) => x.providerTransactionId === 'dup-tx'),
    ).toHaveLength(1)
    expect((await t.invoice(inv.id)).payment?.allocatedAmount).toBe(10_000)
  })

  it('the same transaction re-sent under a new event ID is still counted once', async () => {
    const t = setup()
    const inv = t.addInvoice('T-DUP2', 10_000)
    t.send('POSTED', 10_000, 'T-DUP2', 1, { eventId: 'e1', transactionId: 'dup2' })
    const again = t.send('POSTED', 10_000, 'T-DUP2', 2, { eventId: 'e2', transactionId: 'dup2' })
    expect(again.outcome).toBe('DUPLICATE')
    expect((await t.invoice(inv.id)).payment?.allocatedAmount).toBe(10_000)
  })

  it('does not let a late older confirmation undo a newer reversal (out of order)', async () => {
    const t = setup()
    const inv = t.addInvoice('T-ORDER', 10_000)
    t.send('REVERSED', 10_000, 'T-ORDER', 10, { transactionId: 'ooo' })
    const late = t.send('POSTED', 10_000, 'T-ORDER', 2, { transactionId: 'ooo' })
    expect(late.outcome).toBe('STALE')
    expect((await t.invoice(inv.id)).paymentStatus).toBe('UNPAID')
    expect(
      t.ledger.bankTransactions.load().find((x) => x.providerTransactionId === 'ooo')?.status,
    ).toBe('REVERSED')
  })

  it('rejects an event with a different amount for a known transaction', async () => {
    const t = setup()
    t.addInvoice('T-AMT', 10_000)
    t.send('PENDING', 10_000, 'T-AMT', 1, { transactionId: 'amt' })
    expect(t.send('POSTED', 99_000, 'T-AMT', 2, { transactionId: 'amt' }).outcome).toBe('REJECTED')
  })

  it('refuses events for an unknown or disabled bank account', async () => {
    const t = setup()
    expect(t.send('POSTED', 1_000, null, 1, {}, 'bacc-unknown').outcome).toBe('REJECTED')
    await t.fastBanking.disableConnection(MERCHANT, 'bcn-sample-001')
    expect(t.send('POSTED', 1_000, null, 2).outcome).toBe('REJECTED')
  })

  it('keeps an unreferenced confirmed payment unmatched and visible, never counted on an invoice', async () => {
    const t = setup()
    const result = t.send('POSTED', 9_999, null, 1)
    const tx = (await t.fastReconciliation.listBankTransactions(MERCHANT)).find(
      (x) => x.id === result.transactionId,
    )!
    expect(tx).toMatchObject({ reconciliationStatus: 'UNMATCHED', unappliedAmount: 9_999 })
  })
})

describe('overpayment protection', () => {
  it('applies no more than the invoice owes and flags the excess', async () => {
    const t = setup()
    const inv = t.addInvoice('T-OVER', 50_000)
    const result = t.send('POSTED', 60_000, 'T-OVER', 1)
    expect((await t.invoice(inv.id)).payment).toMatchObject({
      allocatedAmount: 50_000,
      remainingBalance: 0,
    })
    const tx = (await t.fastReconciliation.listBankTransactions(MERCHANT)).find(
      (x) => x.id === result.transactionId,
    )!
    expect(tx).toMatchObject({ unappliedAmount: 10_000, reviewState: 'NEEDS_REVIEW' })
  })

  it('flags a payment to an already-settled invoice and applies nothing', async () => {
    const t = setup()
    const inv = t.addInvoice('T-PAID', 5_000)
    t.send('POSTED', 5_000, 'T-PAID', 1)
    const extra = t.send('POSTED', 5_000, 'T-PAID', 2)
    expect((await t.invoice(inv.id)).payment?.allocatedAmount).toBe(5_000)
    expect(
      t.ledger.bankTransactions.load().find((x) => x.id === extra.transactionId)?.reviewState,
    ).toBe('NEEDS_REVIEW')
  })

  it('does not apply money to a voided or cancelled invoice', async () => {
    const t = setup()
    const voided = t.addInvoice('T-VOID', 5_000, { status: 'VOIDED' })
    const result = t.send('POSTED', 5_000, 'T-VOID', 1)
    expect(t.ledger.allocations.load().filter((a) => a.invoiceId === voided.id)).toHaveLength(0)
    expect(
      t.ledger.bankTransactions.load().find((x) => x.id === result.transactionId)?.reviewState,
    ).toBe('NEEDS_REVIEW')
  })
})

describe('manual reconciliation', () => {
  const unmatched = (t: ReturnType<typeof setup>, amount: number) => {
    const result = t.send('POSTED', amount, null, 1)
    return t.fastReconciliation.getBankTransaction(MERCHANT, result.transactionId!)
  }

  it('splits one transaction across several invoices', async () => {
    const t = setup()
    const a = t.addInvoice('T-M1', 30_000)
    const b = t.addInvoice('T-M2', 20_000)
    const { transaction } = await unmatched(t, 50_000)
    await t.fastReconciliation.allocateManually(MERCHANT, {
      bankTransactionId: transaction.id,
      expectedTransactionVersion: transaction.version,
      allocations: [
        { invoiceId: a.id, amount: 30_000, expectedRemainingBalance: 30_000 },
        { invoiceId: b.id, amount: 20_000, expectedRemainingBalance: 20_000 },
      ],
    })
    expect((await t.invoice(a.id)).paymentStatus).toBe('PAID')
    expect((await t.invoice(b.id)).paymentStatus).toBe('PAID')
    const after = await t.fastReconciliation.getBankTransaction(MERCHANT, transaction.id)
    expect(after.transaction).toMatchObject({
      reconciliationStatus: 'FULLY_ALLOCATED',
      unappliedAmount: 0,
    })
  })

  it('applies nothing at all when any line is invalid (no half-applied split)', async () => {
    const t = setup()
    const a = t.addInvoice('T-N1', 30_000)
    const b = t.addInvoice('T-N2', 1_000)
    const { transaction } = await unmatched(t, 40_000)
    await expect(
      t.fastReconciliation.allocateManually(MERCHANT, {
        bankTransactionId: transaction.id,
        expectedTransactionVersion: transaction.version,
        allocations: [
          { invoiceId: a.id, amount: 30_000, expectedRemainingBalance: 30_000 },
          // More than invoice B owes.
          { invoiceId: b.id, amount: 5_000, expectedRemainingBalance: 1_000 },
        ],
      }),
    ).rejects.toBeInstanceOf(PaymentServiceError)
    expect((await t.invoice(a.id)).paymentStatus).toBe('UNPAID')
    expect(
      t.ledger.allocations.load().filter((x) => x.bankTransactionId === transaction.id),
    ).toHaveLength(0)
  })

  it('refuses more than the unapplied amount or the invoice balance', async () => {
    const t = setup()
    const a = t.addInvoice('T-U1', 100_000)
    const { transaction } = await unmatched(t, 40_000)
    await expect(
      t.fastReconciliation.allocateManually(MERCHANT, {
        bankTransactionId: transaction.id,
        expectedTransactionVersion: transaction.version,
        allocations: [{ invoiceId: a.id, amount: 40_001, expectedRemainingBalance: 100_000 }],
      }),
    ).rejects.toMatchObject({ code: 'exceeds_unapplied' })
  })

  it('detects a conflict when the transaction or an invoice balance changed since it was loaded', async () => {
    const t = setup()
    const a = t.addInvoice('T-C1', 30_000)
    const { transaction } = await unmatched(t, 30_000)
    // Someone else applies part of the money first.
    await t.fastReconciliation.allocateManually(MERCHANT, {
      bankTransactionId: transaction.id,
      expectedTransactionVersion: transaction.version,
      allocations: [{ invoiceId: a.id, amount: 10_000, expectedRemainingBalance: 30_000 }],
    })
    // The second person still holds the old version and balance.
    await expect(
      t.fastReconciliation.allocateManually(MERCHANT, {
        bankTransactionId: transaction.id,
        expectedTransactionVersion: transaction.version,
        allocations: [{ invoiceId: a.id, amount: 20_000, expectedRemainingBalance: 30_000 }],
      }),
    ).rejects.toMatchObject({ code: 'allocation_conflict' })
    // A fresh version but a stale invoice balance is also a conflict.
    const fresh = (await t.fastReconciliation.getBankTransaction(MERCHANT, transaction.id))
      .transaction
    await expect(
      t.fastReconciliation.allocateManually(MERCHANT, {
        bankTransactionId: transaction.id,
        expectedTransactionVersion: fresh.version,
        allocations: [{ invoiceId: a.id, amount: 20_000, expectedRemainingBalance: 30_000 }],
      }),
    ).rejects.toMatchObject({ code: 'allocation_conflict' })
  })

  it('two payers competing for the last balance: only one allocation wins', async () => {
    const t = setup()
    const a = t.addInvoice('T-RACE', 10_000)
    const first = await unmatched(t, 10_000)
    const second = await unmatched(t, 10_000)
    const line = { invoiceId: a.id, amount: 10_000, expectedRemainingBalance: 10_000 }
    await t.fastReconciliation.allocateManually(MERCHANT, {
      bankTransactionId: first.transaction.id,
      expectedTransactionVersion: first.transaction.version,
      allocations: [line],
    })
    await expect(
      t.fastReconciliation.allocateManually(MERCHANT, {
        bankTransactionId: second.transaction.id,
        expectedTransactionVersion: second.transaction.version,
        allocations: [line],
      }),
    ).rejects.toMatchObject({ code: 'allocation_conflict' })
    expect((await t.invoice(a.id)).payment?.allocatedAmount).toBe(10_000)
  })

  it('cannot allocate money the bank has not confirmed', async () => {
    const t = setup()
    const a = t.addInvoice('T-NC', 10_000)
    const pending = t.send('PENDING', 10_000, null, 1)
    const { transaction } = await t.fastReconciliation.getBankTransaction(
      MERCHANT,
      pending.transactionId!,
    )
    await expect(
      t.fastReconciliation.allocateManually(MERCHANT, {
        bankTransactionId: transaction.id,
        expectedTransactionVersion: transaction.version,
        allocations: [{ invoiceId: a.id, amount: 10_000, expectedRemainingBalance: 10_000 }],
      }),
    ).rejects.toMatchObject({ code: 'exceeds_unapplied' })
  })

  it('marks a flagged payment reviewed without moving money', async () => {
    const t = setup()
    const { transaction } = await unmatched(t, 4_000)
    const reviewed = await t.fastReconciliation.markReviewed(MERCHANT, transaction.id, {
      note: 'Checked with the customer: a donation.',
      expectedTransactionVersion: transaction.version,
    })
    expect(reviewed.transaction).toMatchObject({ reviewState: 'REVIEWED', unappliedAmount: 4_000 })
  })
})

describe('authorization and isolation', () => {
  it('lets a cashier read only transactions applied to their own invoices, and never reconcile', async () => {
    const t = setup()
    const mine = t.addInvoice('T-MINE', 5_000)
    t.addInvoice('T-THEIRS', 5_000, {
      assignedToUserId: DEMO_USER_IDS.manager,
      assignedToName: 'Grace Mukamana',
    })
    t.send('POSTED', 5_000, 'T-MINE', 1, { transactionId: 'mine' })
    t.send('POSTED', 5_000, 'T-THEIRS', 2, { transactionId: 'theirs' })
    const unmatchedTx = t.send('POSTED', 3_333, null, 3)

    t.as('cashier')
    const visible = await t.fastReconciliation.listBankTransactions(MERCHANT)
    const references = visible.map((x) => x.paymentReference)
    expect(references).toContain('T-MINE')
    expect(references).not.toContain('T-THEIRS')
    // Unmatched money is never shown to a cashier, and no unapplied figure leaks.
    expect(visible.some((x) => x.id === unmatchedTx.transactionId)).toBe(false)
    expect(visible.every((x) => x.unappliedAmount === 0)).toBe(true)
    await expect(
      t.fastReconciliation.getBankTransaction(MERCHANT, unmatchedTx.transactionId!),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(t.fastReconciliation.listPayableInvoices(MERCHANT)).rejects.toMatchObject({
      code: 'forbidden',
    })
    await expect(
      t.fastReconciliation.allocateManually(MERCHANT, {
        bankTransactionId: 'x',
        expectedTransactionVersion: 1,
        allocations: [],
      }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      t.fastReconciliation.markReviewed(MERCHANT, 'x', {
        note: 'abc',
        expectedTransactionVersion: 1,
      }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    await expect(
      t.fastReconciliation.reverseAllocation(MERCHANT, 'alc-001', { reason: 'abc' }),
    ).rejects.toMatchObject({ code: 'forbidden' })
    expect(mine.id).toBeTruthy()
  })

  it('shows another business as not found, and never mixes the two businesses', async () => {
    const t = setup()
    t.as('manager')
    await expect(
      t.fastReconciliation.listBankTransactions(SAMPLE_SECOND_MERCHANT_ID),
    ).rejects.toMatchObject({
      code: 'not_found',
    })
    t.as('owner')
    const cafe = await t.fastReconciliation.listBankTransactions(SAMPLE_SECOND_MERCHANT_ID)
    expect(cafe.every((x) => x.merchantId === SAMPLE_SECOND_MERCHANT_ID)).toBe(true)
    // A shop transaction ID is invisible through the cafe.
    await expect(
      t.fastReconciliation.getBankTransaction(SAMPLE_SECOND_MERCHANT_ID, 'btx-001'),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('refuses everything to a suspended or revoked member', async () => {
    const t = setup()
    t.as('suspended')
    await expect(t.fastReconciliation.listBankTransactions(MERCHANT)).rejects.toMatchObject({
      code: 'not_found',
    })
    t.as('revoked')
    await expect(t.fastReconciliation.listBankTransactions(MERCHANT)).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('has no way for a cashier to confirm a payment or mark an invoice paid', () => {
    const t = setup()
    const methods = Object.keys(t.fastReconciliation)
    expect(methods.some((name) => /confirm|markPaid|createTransaction/i.test(name))).toBe(false)
  })
})

describe('dashboard figures share the same ledger', () => {
  it('verified incoming = allocated + unmatched, and moves with every ledger change', async () => {
    const t = setup()
    t.addInvoice('T-DASH', 10_000)
    const before = await t.fastDashboard.getSummary({ merchantId: MERCHANT })
    expect(before).toMatchObject({
      verifiedIncomingTotal: 486_500,
      allocatedTotal: 172_000,
      unappliedConfirmedTotal: 314_500,
    })
    t.send('POSTED', 10_000, 'T-DASH', 1)
    t.send('POSTED', 2_500, null, 2)
    const after = await t.fastDashboard.getSummary({ merchantId: MERCHANT })
    expect(after.verifiedIncomingTotal).toBe(499_000)
    expect(after.allocatedTotal).toBe(182_000)
    expect(after.unappliedConfirmedTotal).toBe(317_000)
    expect(after.verifiedIncomingTotal).toBe(after.allocatedTotal + after.unappliedConfirmedTotal)
  })

  it('does not count pending, failed or reversed money as verified', async () => {
    const t = setup()
    const before = await t.fastDashboard.getSummary({ merchantId: MERCHANT })
    t.send('PENDING', 1_000, null, 1)
    t.send('REJECTED', 2_000, null, 2)
    t.send('POSTED', 4_000, null, 3, { transactionId: 'rev' })
    t.send('REVERSED', 4_000, null, 4, { transactionId: 'rev' })
    const after = await t.fastDashboard.getSummary({ merchantId: MERCHANT })
    expect(after.verifiedIncomingTotal).toBe(before.verifiedIncomingTotal)
  })

  it('subtracts remaining balances, not full totals, from outstanding', async () => {
    const t = setup()
    const inv = t.addInvoice('T-OUT', 50_000)
    const { summarizeInvoices } = await import('@/features/invoices/invoiceSummary')
    const sum = async () =>
      summarizeInvoices((await t.fastInvoices.listInvoices(MERCHANT)).items).outstandingTotal
    const start = await sum()
    t.send('POSTED', 20_000, 'T-OUT', 1)
    expect(await sum()).toBe(start - 20_000)
    expect(inv.id).toBeTruthy()
  })

  it('a cashier dashboard stays inside their own invoices', async () => {
    const t = setup()
    const summary = await t.fastDashboard.getSummary({
      merchantId: MERCHANT,
      assignedUserId: DEMO_USER_IDS.cashier,
    })
    expect(summary).toMatchObject({
      verifiedIncomingTotal: 172_000,
      unappliedConfirmedTotal: 0,
      requiresReviewCount: 0,
    })
  })
})

describe('notification routing', () => {
  const recipientsOf = (t: ReturnType<typeof setup>, kind: string) =>
    t.ledger.notifications
      .load()
      .filter((n) => n.kind === kind)
      .map((n) => n.recipientUserId)
      .sort()

  it('notifies the responsible cashier and managers about a partial payment, once each', async () => {
    const t = setup()
    t.addInvoice('T-NOTE', 10_000)
    t.send('POSTED', 4_000, 'T-NOTE', 1, { eventId: 'n1', transactionId: 'n-tx' })
    const expected = [DEMO_USER_IDS.cashier, DEMO_USER_IDS.manager, DEMO_USER_IDS.owner].sort()
    expect(recipientsOf(t, 'INVOICE_PARTIALLY_SETTLED')).toEqual(expected)
    // A replayed event produces no new notification.
    t.send('POSTED', 4_000, 'T-NOTE', 1, { eventId: 'n1', transactionId: 'n-tx' })
    expect(recipientsOf(t, 'INVOICE_PARTIALLY_SETTLED')).toEqual(expected)
    t.send('POSTED', 6_000, 'T-NOTE', 2)
    expect(recipientsOf(t, 'INVOICE_SETTLED')).toEqual(expected)
  })

  it('sends unmatched and needs-review alerts to managers only', () => {
    const t = setup()
    t.send('POSTED', 1_500, null, 1)
    t.send('POSTED', 1_600, 'NOPE-123', 2)
    const managers = [DEMO_USER_IDS.manager, DEMO_USER_IDS.owner].sort()
    expect(recipientsOf(t, 'PAYMENT_UNMATCHED')).toEqual([...managers, ...managers].sort())
    expect(new Set(recipientsOf(t, 'NEEDS_REVIEW'))).toEqual(new Set(managers))
    expect(
      t.ledger.notifications.load().some((n) => n.recipientUserId === DEMO_USER_IDS.cashier),
    ).toBe(false)
  })

  it('notifies about a reversal, and each person reads and marks only their own', async () => {
    const t = setup()
    t.addInvoice('T-REV', 5_000)
    t.send('POSTED', 5_000, 'T-REV', 1, { transactionId: 'rv' })
    t.send('REVERSED', 5_000, 'T-REV', 2, { transactionId: 'rv' })
    expect(recipientsOf(t, 'PAYMENT_REVERSED').length).toBe(3)

    t.as('cashier')
    const mine = await t.fastNotifications.listNotifications(MERCHANT)
    expect(mine.length).toBeGreaterThan(0)
    expect(mine.every((n) => n.recipientUserId === DEMO_USER_IDS.cashier)).toBe(true)
    const owners = t.ledger.notifications
      .load()
      .find((n) => n.recipientUserId === DEMO_USER_IDS.owner)!
    await expect(t.fastNotifications.markAsRead(MERCHANT, owners.id)).rejects.toMatchObject({
      code: 'not_found',
    })
    await t.fastNotifications.markAsRead(MERCHANT, mine[0]!.id)
    expect(
      (await t.fastNotifications.listNotifications(MERCHANT)).filter((n) => !n.readAt).length,
    ).toBe(mine.length - 1)
    await t.fastNotifications.markAllAsRead(MERCHANT)
    expect((await t.fastNotifications.listNotifications(MERCHANT)).every((n) => n.readAt)).toBe(
      true,
    )
    // The owner's are untouched.
    expect(t.ledger.notifications.load().find((n) => n.id === owners.id)?.readAt).toBeNull()
  })

  it('does not notify a suspended cashier about their old invoices', () => {
    const t = setup()
    t.addInvoice('T-SUSP', 5_000)
    t.store.saveMemberships(
      t.store
        .loadMemberships()
        .map((m) =>
          m.userId === DEMO_USER_IDS.cashier ? { ...m, status: 'SUSPENDED' as const } : m,
        ),
    )
    t.send('POSTED', 5_000, 'T-SUSP', 1)
    expect(
      t.ledger.notifications.load().some((n) => n.recipientUserId === DEMO_USER_IDS.cashier),
    ).toBe(false)
  })
})
