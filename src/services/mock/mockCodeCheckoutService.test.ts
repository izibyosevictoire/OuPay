import { CodeCheckoutServiceError } from '@/services/codeCheckoutService'
import { summarizeInvoices } from '@/features/invoices/invoiceSummary'
import { createTestBackend } from '@/test/merchantTestDouble'
import type { CodeSaleInput } from '@/types/codeCheckout'
import { DEMO_USER_IDS } from './sampleAccounts'
import { SAMPLE_MERCHANT_ID } from './sampleMerchants'
import { SAMPLE_BRANCH_IDS } from './sampleOrganization'

const M = SAMPLE_MERCHANT_ID

type Backend = ReturnType<typeof createTestBackend>

let counter = 0
const input = (overrides: Partial<CodeSaleInput> = {}): CodeSaleInput => {
  counter += 1
  return {
    amountRwf: 5_000,
    clientRequestId: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    idempotencyKey: `idem-key-${counter}-${'x'.repeat(8)}`,
    ...overrides,
  }
}

const errorCode = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: unknown) => (error instanceof CodeCheckoutServiceError ? error.code : String(error)),
  )

/** A simulated code the cashier (Aline) holds at Remera, on the account a payment link of the sample ledger collects to. */
async function withDemoCode(t: Backend) {
  t.signInAs('owner')
  const profile = t.ledger.paymentProfiles
    .load()
    .find((p) => p.merchantId === M && p.status === 'ACTIVE' && p.assignedCashierId === null)
  const destination = t.ledger.paymentDestinations
    .load()
    .find((d) => d.id === profile?.paymentDestinationId)
  if (!destination) throw new Error('the sample ledger has no destination to settle to')
  const requested = await t.fastCollectionCodes.requestCode(M, {
    clientOperationId: crypto.randomUUID(),
    settlementDestinationId: destination.id,
    displayLabel: 'Demo counter',
    branchId: SAMPLE_BRANCH_IDS.remera,
  })
  await t.fastCollectionCodes.assign(M, requested.code.id, { membershipId: 'mem-004' })
  t.signInAs('cashier')
  return requested.code
}

describe('mock code checkout (the demo stand-in for the server)', () => {
  it('bills a demonstration sale on the ordinary invoice and a fixed 30-minute request, unpaid until a bank event says so', async () => {
    const t = createTestBackend()
    const code = await withDemoCode(t)
    const sale = await t.fastCodeCheckout.codeCheckoutService.billCodeSale(
      M,
      input({ amountRwf: 12_500, description: ' Two coffees ', collectionCodeId: code.id }),
    )
    expect(sale).toMatchObject({
      amountRwf: 12_500,
      currency: 'RWF',
      description: 'Two coffees',
      status: 'AWAITING_PAYMENT',
      confirmedAmount: 0,
      agentName: 'Aline Uwase',
    })
    expect(sale.code).toMatchObject({
      mode: 'DEMONSTRATION',
      bankCode: null,
      label: 'Demo counter',
    })
    expect(sale.code.notice).toContain('DEMONSTRATION ONLY')
    expect(sale.saleReference).toMatch(/^OP-/)
    expect(Date.parse(sale.expiresAt) - Date.parse(sale.createdAt)).toBe(30 * 60_000)
    const invoice = t.store.loadInvoices().find((i) => i.id === sale.invoiceId)
    expect(invoice).toMatchObject({ status: 'ISSUED', saleChannel: 'CODE', grandTotal: 12_500 })
  })

  it('shows the customer only what they need, with no agent, account or internal id', async () => {
    const t = createTestBackend()
    const code = await withDemoCode(t)
    const sale = await t.fastCodeCheckout.codeCheckoutService.billCodeSale(
      M,
      input({ collectionCodeId: code.id }),
    )
    const page = await t.fastCodeCheckout.publicCodeSaleService.getPublicCodeSale(
      sale.saleReference,
    )
    expect(page).toMatchObject({
      saleReference: sale.saleReference,
      amountRwf: 5_000,
      status: 'AWAITING_PAYMENT',
      instructions: [],
    })
    expect(JSON.stringify(page)).not.toContain('Aline')
    expect(JSON.stringify(page)).not.toContain(sale.saleId)
    await expect(
      t.fastCodeCheckout.publicCodeSaleService.getPublicCodeSale('OP-UNKNOWN1'),
    ).rejects.toMatchObject({ code: 'not_found' })
  })

  it('lists only the caller’s own codes, and refuses a bank-approved code while live collection is off', async () => {
    const t = createTestBackend()
    t.signInAs('cashier')
    const options = await t.fastCodeCheckout.codeCheckoutService.getCodeCheckoutOptions(M)
    // Aline holds the sample bank-approved code on a real account: live collection is not enabled, so it cannot bill.
    expect(options.liveCollectionEnabled).toBe(false)
    expect(options.readiness).toBe('CODE_NOT_AVAILABLE')
    expect(options.codes).toHaveLength(1)
    expect(options.codes[0]).toMatchObject({ mode: 'UNAVAILABLE' })
    expect(JSON.stringify(options)).not.toContain('DEMO-ILLUSTRATIVE-001')
    const requestsBefore = t.ledger.paymentRequests.load().length
    expect(
      await errorCode(
        t.fastCodeCheckout.codeCheckoutService.billCodeSale(M, input({ amountRwf: 1_000 })),
      ),
    ).toBe('live_collection_unavailable')
    expect(t.ledger.paymentRequests.load()).toHaveLength(requestsBefore)
  })

  it('refuses people who hold no code, and codes that are not theirs, creating nothing', async () => {
    const t = createTestBackend()
    const code = await withDemoCode(t)
    const requestsBefore = t.ledger.paymentRequests.load().length
    const invoicesBefore = t.store.loadInvoices().length
    t.signInAs('manager')
    expect(await errorCode(t.fastCodeCheckout.codeCheckoutService.billCodeSale(M, input()))).toBe(
      'no_assigned_code',
    )
    t.signInAs('cashier')
    expect(
      await errorCode(
        t.fastCodeCheckout.codeCheckoutService.billCodeSale(
          M,
          input({ collectionCodeId: 'cc-sample-002' }),
        ),
      ),
    ).toBe('code_not_assigned')
    // Two codes held and none chosen.
    expect(await errorCode(t.fastCodeCheckout.codeCheckoutService.billCodeSale(M, input()))).toBe(
      'code_required',
    )
    expect(code.id).toBeTruthy()
    expect(t.ledger.paymentRequests.load()).toHaveLength(requestsBefore)
    expect(t.store.loadInvoices()).toHaveLength(invoicesBefore)
  })

  it('validates the amount and the description before anything else', async () => {
    const t = createTestBackend()
    const code = await withDemoCode(t)
    const bill = (overrides: Partial<CodeSaleInput>) =>
      errorCode(
        t.fastCodeCheckout.codeCheckoutService.billCodeSale(
          M,
          input({ collectionCodeId: code.id, ...overrides }),
        ),
      )
    expect(await bill({ amountRwf: 0 })).toBe('validation')
    expect(await bill({ amountRwf: 99 })).toBe('validation')
    expect(await bill({ amountRwf: 10_000_001 })).toBe('validation')
    expect(await bill({ amountRwf: 100.5 })).toBe('validation')
    expect(await bill({ description: 'x'.repeat(121) })).toBe('validation')
    expect(await bill({ description: 'two\nlines' })).toBe('validation')
    expect(await bill({ idempotencyKey: 'short' })).toBe('validation')
    expect(await bill({ amountRwf: 100 })).toBe('ok')
  })

  it('returns the original sale for an identical retry and refuses a conflicting one', async () => {
    const t = createTestBackend()
    const code = await withDemoCode(t)
    const service = t.fastCodeCheckout.codeCheckoutService
    const first = input({ amountRwf: 7_000, collectionCodeId: code.id })
    const created = await service.billCodeSale(M, first)
    const retry = await service.billCodeSale(M, first)
    expect(retry.saleId).toBe(created.saleId)
    expect(t.ledger.paymentRequests.load().filter((r) => r.id === created.saleId)).toHaveLength(1)
    // Same key, other sale.
    expect(await errorCode(service.billCodeSale(M, { ...first, amountRwf: 8_000 }))).toBe(
      'idempotency_key_reuse',
    )
    // Same sale identifier under another key and a different amount.
    expect(
      await errorCode(
        service.billCodeSale(M, {
          ...first,
          amountRwf: 8_000,
          idempotencyKey: 'another-key-0000001',
        }),
      ),
    ).toBe('client_request_id_reuse')
    // Same sale content under another key: still the original.
    const again = await service.billCodeSale(M, { ...first, idempotencyKey: 'another-key-0000002' })
    expect(again.saleId).toBe(created.saleId)
  })

  it('refuses a sale when no payment link collects to the code’s own account, leaving nothing behind', async () => {
    const t = createTestBackend()
    const code = await withDemoCode(t)
    t.ledger.paymentProfiles.save(
      t.ledger.paymentProfiles.load().map((p) => ({ ...p, status: 'PAUSED' as never })),
    )
    const invoicesBefore = t.store.loadInvoices().length
    expect(
      await errorCode(
        t.fastCodeCheckout.codeCheckoutService.billCodeSale(
          M,
          input({ collectionCodeId: code.id }),
        ),
      ),
    ).toBe('no_active_profile')
    expect(t.store.loadInvoices()).toHaveLength(invoicesBefore)
  })

  it('keeps the sale attributed to the agent who billed it after the code is reassigned', async () => {
    const t = createTestBackend()
    const code = await withDemoCode(t)
    const service = t.fastCodeCheckout.codeCheckoutService
    const first = input({ collectionCodeId: code.id })
    const sale = await service.billCodeSale(M, first)
    t.signInAs('owner')
    const open = (await t.fastCollectionCodes.listAssignments(M, code.id)).items.find(
      (a) => a.validTo === null,
    )
    await t.fastCollectionCodes.reassign(M, code.id, {
      expectedAssignmentId: open?.id ?? '',
      membershipId: 'mem-003',
      reason: 'Shift change',
    })
    t.signInAs('cashier')
    const again = await service.getCodeSale(M, sale.saleId)
    expect(again.agentName).toBe('Aline Uwase')
    expect(DEMO_USER_IDS.cashier).toBeTruthy()
    // The first agent can no longer bill with it.
    expect(await errorCode(service.billCodeSale(M, input({ collectionCodeId: code.id })))).toBe(
      'code_not_assigned',
    )
    // A replay of the original request still returns the original sale.
    const replay = await service.billCodeSale(M, first)
    expect(replay.saleId).toBe(sale.saleId)
  })

  it('never applies bank money to a demonstration sale: not by reference, not by invoice number, not manually', async () => {
    const t = createTestBackend()
    const code = await withDemoCode(t)
    const service = t.fastCodeCheckout.codeCheckoutService
    const sale = await service.billCodeSale(M, input({ collectionCodeId: code.id }))
    expect(['CREATED', 'AWAITING_PAYMENT']).toContain(
      (await service.getCodeSale(M, sale.saleId)).status,
    )
    const allocationsBefore = t.ledger.allocations.load().length
    // The simulated bank reports the payment against the sale's reference.
    await t.fastSimulator.simulateRequestPayment(sale.saleReference, 'success')
    const after = await service.getCodeSale(M, sale.saleId)
    expect(after).toMatchObject({
      status: 'AWAITING_PAYMENT',
      confirmedAmount: 0,
      amountDue: 5_000,
    })
    const page = await t.fastCodeCheckout.publicCodeSaleService.getPublicCodeSale(
      sale.saleReference,
    )
    expect(page).toMatchObject({ status: 'AWAITING_PAYMENT', confirmedAmount: 0 })
    expect(t.ledger.allocations.load()).toHaveLength(allocationsBefore)
    const transaction = t.ledger.bankTransactions.load().at(-1)!
    expect(transaction.paymentRequestId ?? null).toBeNull()

    // Not by hand either, and the picker never offers it.
    t.signInAs('owner')
    expect(
      (await t.fastReconciliation.listPayableInvoices(M)).map((i) => i.invoiceId),
    ).not.toContain(sale.invoiceId)
    await expect(
      t.fastReconciliation.allocateManually(M, {
        bankTransactionId: transaction.id,
        expectedTransactionVersion: transaction.version,
        allocations: [
          { invoiceId: sale.invoiceId, amount: 5_000, expectedRemainingBalance: 5_000 },
        ],
      }),
    ).rejects.toMatchObject({ code: 'code_sale_not_payable' })
    expect(t.ledger.allocations.load()).toHaveLength(allocationsBefore)
  })

  it('shows the customer no internal code reference', async () => {
    const t = createTestBackend()
    const code = await withDemoCode(t)
    const sale = await t.fastCodeCheckout.codeCheckoutService.billCodeSale(
      M,
      input({ collectionCodeId: code.id }),
    )
    expect(sale.code.demoReference).toMatch(/^CC-/)
    const page = await t.fastCodeCheckout.publicCodeSaleService.getPublicCodeSale(
      sale.saleReference,
    )
    expect(page.code.demoReference).toBeNull()
  })

  it('hides another agent’s sale from people who may not see it, and an unknown sale is not found', async () => {
    const t = createTestBackend()
    const code = await withDemoCode(t)
    const service = t.fastCodeCheckout.codeCheckoutService
    const sale = await service.billCodeSale(M, input({ collectionCodeId: code.id }))
    t.signInAs('manager')
    expect(await errorCode(service.getCodeSale(M, 'pr-unknown'))).toBe('not_found')
    // A manager may see the business's sales; the owner too.
    expect((await service.getCodeSale(M, sale.saleId)).saleId).toBe(sale.saleId)
  })

  it('keeps a demonstration out of every business invoice list and figure, and out of the real number series', async () => {
    const t = createTestBackend()
    const code = await withDemoCode(t)
    t.signInAs('owner')
    const before = await t.fastInvoices.listInvoices(M)
    const summaryBefore = summarizeInvoices(before.items)
    t.signInAs('cashier')
    const sale = await t.fastCodeCheckout.codeCheckoutService.billCodeSale(
      M,
      input({ amountRwf: 90_000, collectionCodeId: code.id }),
    )
    expect(sale.invoiceNumber).toMatch(/^DEMO-0001$/)
    t.signInAs('owner')
    const after = await t.fastInvoices.listInvoices(M)
    // Not listed, not counted: receivables, issued totals and overdue figures are exactly what they were.
    expect(after.items.map((i) => i.id)).not.toContain(sale.invoiceId)
    expect(after.items).toHaveLength(before.items.length)
    expect(summarizeInvoices(after.items, '2099-01-01')).toEqual(
      summarizeInvoices(before.items, '2099-01-01'),
    )
    expect(summarizeInvoices(after.items)).toEqual(summaryBefore)
    // Still reachable by its id, and clearly identified as a demonstration.
    const opened = await t.fastInvoices.getInvoice(M, sale.invoiceId)
    expect(opened).toMatchObject({ demonstration: true, saleChannel: 'CODE', status: 'ISSUED' })
    // A real invoice created afterwards takes the next REAL number.
    const real = await t.fastInvoices.createDraft(M, {
      branchId: SAMPLE_BRANCH_IDS.remera,
      assignedToUserId: DEMO_USER_IDS.cashier,
      customer: { name: 'Real customer' },
      items: [
        {
          description: 'Real',
          quantity: 1,
          unitPrice: 10_000,
          discount: 0,
          taxRate: { category: 'NOT_APPLICABLE', rateBp: 0 },
        },
      ],
      taxMode: 'EXCLUSIVE',
      dueAt: '2099-01-01',
    })
    const highestReal = Math.max(
      ...before.items.map((i) => Number(/(\d+)$/.exec(i.invoiceNumber)?.[1] ?? 0)),
    )
    expect(real.invoiceNumber).toBe(`INV-${String(highestReal + 1).padStart(4, '0')}`)
  })
})
