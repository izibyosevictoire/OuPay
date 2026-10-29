import { createHttpClient } from '@/services/http/httpClient'
import { createHttpReconciliationService } from '@/services/http/httpServices'
import { createTestBackend } from '@/test/merchantTestDouble'
import type { BankAttribution } from '@/types/bankAttribution'
import { SAMPLE_MERCHANT_ID } from './sampleMerchants'
import { SAMPLE_BRANCH_IDS } from './sampleOrganization'

const M = SAMPLE_MERCHANT_ID
type Backend = ReturnType<typeof createTestBackend>

/** A demonstration code sale billed by the cashier (Aline), then a simulated bank payment that names it. */
async function saleAndPayment(t: Backend) {
  t.signInAs('owner')
  const profile = t.ledger.paymentProfiles
    .load()
    .find((p) => p.merchantId === M && p.status === 'ACTIVE' && p.assignedCashierId === null)
  const destination = t.ledger.paymentDestinations
    .load()
    .find((d) => d.id === profile?.paymentDestinationId)
  const requested = await t.fastCollectionCodes.requestCode(M, {
    clientOperationId: crypto.randomUUID(),
    settlementDestinationId: destination?.id ?? '',
    displayLabel: 'Demo counter',
    branchId: SAMPLE_BRANCH_IDS.remera,
  })
  await t.fastCollectionCodes.assign(M, requested.code.id, { membershipId: 'mem-004' })
  t.signInAs('cashier')
  const sale = await t.fastCodeCheckout.codeCheckoutService.billCodeSale(M, {
    amountRwf: 5_000,
    collectionCodeId: requested.code.id,
    clientRequestId: crypto.randomUUID(),
    idempotencyKey: `idem-${crypto.randomUUID()}`,
  })
  await t.fastSimulator.simulateRequestPayment(sale.saleReference, 'success')
  return sale
}

describe('mock bank attribution read model (the demo stand-in for the server)', () => {
  it('names a sale a payment carries without ever confirming a code, an agent, a match or an allocation', async () => {
    const t = createTestBackend()
    const sale = await saleAndPayment(t)
    t.signInAs('owner')
    const all = await t.fastReconciliation.listBankAttributions(M)
    const named = all.find((a) => a.saleReference === sale.saleReference)!
    expect(named).toMatchObject({
      saleReferenceNamed: true,
      saleInvoiceId: sale.invoiceId,
      // The demo provider reports no code, so nothing is resolved and the agent is NOT confirmed.
      attributionStatus: 'NOT_REPORTED',
      attributionBasis: 'ACCOUNT_ONLY',
      codeResolved: false,
      reportedCode: null,
      collectionCode: null,
      agentAttribution: 'SALE_NAMED_UNCONFIRMED',
      agentName: null,
      // A mock code sale is a demonstration: it never receives money.
      saleReferenceMatched: false,
      allocatedToSaleRwf: 0,
      allocationOrigin: null,
      saleFullyPaid: false,
      stage: 'AWAITING_MATCHING',
    })
    // The sale is still unpaid in the ledger: the simulated money was not applied to it.
    const invoice = await t.fastInvoices.getInvoice(M, sale.invoiceId)
    expect(invoice.paymentStatus).toBe('UNPAID')
    // Every other incoming transaction is evaluated too, with no code and no agent.
    const others = all.filter((a) => a.saleReference !== sale.saleReference)
    expect(others.length).toBeGreaterThan(0)
    expect(others.every((a) => a.agentAttribution === 'UNRESOLVED' && !a.saleReferenceNamed)).toBe(
      true,
    )
  })

  it('follows the server’s scope: owners see everything, managers attributed activity of their own branches, cashiers nothing the demo can confirm', async () => {
    const t = createTestBackend()
    const sale = await saleAndPayment(t)
    t.signInAs('owner')
    const owner = await t.fastReconciliation.listBankAttributions(M)
    t.signInAs('manager')
    const manager = await t.fastReconciliation.listBankAttributions(M)
    t.signInAs('cashier')
    const cashier = await t.fastReconciliation.listBankAttributions(M)
    expect(owner.length).toBeGreaterThan(manager.length)
    // The manager sees only the transactions that are attributed to a sale of a branch they work at.
    expect(manager.every((a) => a.saleReferenceNamed)).toBe(true)
    expect(manager.map((a) => a.saleReference)).toContain(sale.saleReference)
    expect(cashier).toEqual([])
    // A direct lookup follows the same scope.
    const id = owner.find((a) => a.saleReference === sale.saleReference)!.transactionId
    t.signInAs('owner')
    expect((await t.fastReconciliation.getBankAttribution(M, id)).transactionId).toBe(id)
    t.signInAs('cashier')
    await expect(t.fastReconciliation.getBankAttribution(M, id)).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(t.fastReconciliation.getBankAttribution('mrc-other', id)).rejects.toMatchObject({
      code: expect.stringMatching(/not_found|forbidden/),
    })
  })
})

describe('HTTP and mock keep the same contract', () => {
  /** What the server sends: it omits null fields. */
  const wire = {
    merchantId: M,
    transactionId: 'tx-1',
    providerTransactionId: 'prov-1',
    transactionStatus: 'CONFIRMED',
    amountRwf: 12_000,
    occurredAt: '2026-10-28T10:00:00Z',
    reportedCodeMasked: false,
    attributionStatus: 'NOT_REPORTED',
    attributionBasis: 'ACCOUNT_ONLY',
    agentAttribution: 'UNRESOLVED',
    stage: 'AWAITING_MATCHING',
    codeResolved: false,
    saleReferenceNamed: false,
    saleReferenceMatched: false,
    allocatedToSaleRwf: 0,
    saleFullyPaid: false,
    reviewState: 'NONE',
    createdAt: '2026-10-28T10:00:01Z',
  }

  function http(...pages: unknown[]) {
    const calls: string[] = []
    const queue = [...pages]
    const fetchImpl = vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url))
      return new Response(JSON.stringify(queue.shift() ?? {}), { status: 200 })
    }) as unknown as typeof fetch
    const client = createHttpClient({ baseUrl: '/api/v1', fetchImpl, readCookie: () => 'csrf' })
    return { service: createHttpReconciliationService(client), calls }
  }

  it('reads the attribution endpoints and turns every omitted null into null', async () => {
    const { service, calls } = http({ items: [wire] }, wire)
    const list = await service.listBankAttributions(M)
    expect(calls[0]).toContain(`/api/v1/merchants/${M}/bank-attributions`)
    expect(list[0]).toMatchObject({
      reportedCode: null,
      collectionCode: null,
      agentName: null,
      saleReference: null,
      saleInvoiceId: null,
      allocationOrigin: null,
    })
    const one = await service.getBankAttribution(M, 'tx-1')
    expect(calls[1]).toBe(`/api/v1/merchants/${M}/bank-attributions/tx-1`)
    expect(one.agentName).toBeNull()
  })

  it('has exactly the fields the mock produces', async () => {
    const t = createTestBackend()
    t.signInAs('owner')
    const mock = (await t.fastReconciliation.listBankAttributions(M))[0]!
    const { service } = http({ items: [wire] })
    const real = (await service.listBankAttributions(M))[0]!
    expect(Object.keys(real).sort()).toEqual(Object.keys(mock).sort())
    // And the types agree on the nullable ones.
    const sample: BankAttribution = real
    expect(sample.collectionCode).toBeNull()
  })

  it('keeps the server’s collection code and masked value, normalising its branch', async () => {
    const { service } = http({
      items: [
        {
          ...wire,
          attributionStatus: 'RESOLVED',
          reportedCode: '••••A1',
          reportedCodeMasked: true,
          collectionCode: { id: 'cc-1', label: 'Counter' },
          codeResolved: true,
        },
      ],
    })
    const [a] = await service.listBankAttributions(M)
    expect(a).toMatchObject({
      reportedCode: '••••A1',
      reportedCodeMasked: true,
      collectionCode: { id: 'cc-1', label: 'Counter', branchId: null },
    })
  })

  it('maps a refusal to the payment error contract', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'not_found', message: 'not here' }), { status: 404 }),
    ) as unknown as typeof fetch
    const service = createHttpReconciliationService(
      createHttpClient({ baseUrl: '/api/v1', fetchImpl, readCookie: () => 'csrf' }),
    )
    await expect(service.getBankAttribution(M, 'x')).rejects.toMatchObject({
      name: 'PaymentServiceError',
      code: 'not_found',
    })
  })
})
