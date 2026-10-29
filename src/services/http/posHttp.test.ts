import { PosServiceError } from '@/services/posService'
import { createHttpClient } from './httpClient'
import { createHttpPosService } from './httpServices'

interface Call {
  method: string
  url: string
  headers: Record<string, string>
  body: unknown
}

function setup(...responses: { status?: number; body?: unknown }[]) {
  const calls: Call[] = []
  const queue = [...responses]
  const fetchImpl = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      method: init?.method ?? 'GET',
      url: String(url),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    })
    const next = queue.shift() ?? { status: 204 }
    return new Response(JSON.stringify(next.body ?? {}), { status: next.status ?? 200 })
  }) as unknown as typeof fetch
  const http = createHttpClient({ baseUrl: '/api/v1', fetchImpl, readCookie: () => 'csrf-token' })
  return { pos: createHttpPosService(http), calls }
}

const M = 'mrc-1'
const line = {
  itemId: 'item-1',
  quantity: '2.5',
  unit: 'kg' as const,
  packageId: null,
  expectedPriceVersion: 3,
}

describe('HTTP POS keeps the contract with the backend', () => {
  it('reads the options and treats omitted lists as empty', async () => {
    const { pos, calls } = setup({
      body: { readiness: 'NO_BRANCH', maxLines: 100, stockNote: 'n' },
    })
    await expect(pos.getPosOptions(M)).resolves.toMatchObject({
      readiness: 'NO_BRANCH',
      branches: [],
    })
    expect(calls[0]).toMatchObject({ method: 'GET', url: `/api/v1/merchants/${M}/pos/options` })
  })

  it('searches with the branch and text, and fills fields the server omits', async () => {
    const { pos, calls } = setup({
      body: [
        {
          itemId: 'item-1',
          itemType: 'SERVICE',
          name: 'Repair',
          measurementDimension: 'COUNT',
          saleUnit: 'pc',
          units: ['pc'],
          pricePerSaleUnitRwf: 5000,
          priceVersion: 1,
          stock: { state: 'NOT_TRACKED', canonicalUnit: 'pc' },
        },
      ],
    })
    const [item] = await pos.searchPosItems(M, 'brn-1', ' rice ')
    expect(item).toMatchObject({
      code: null,
      packages: [],
      stock: { onHand: null, onHandInSaleUnit: null },
    })
    expect(calls[0]?.url).toBe(`/api/v1/merchants/${M}/pos/items?branchId=brn-1&q=rice&limit=50`)
  })

  it('quotes with decimal STRING quantities and never a price, and normalises a quote', async () => {
    const { pos, calls } = setup({
      body: {
        branchId: 'brn-1',
        branchName: 'Main',
        totalRwf: 0,
        currency: 'RWF',
        stockNote: 'n',
        taxNote: 't',
        problems: [
          {
            lineIndex: 0,
            code: 'price_changed',
            message: 'm',
            currentPriceVersion: 4,
            currentPriceRwf: 1800,
          },
        ],
      },
    })
    const quote = await pos.quotePosCart(M, { branchId: 'brn-1', lines: [line] })
    expect(quote.lines).toEqual([])
    expect(quote.problems[0]).toMatchObject({ code: 'price_changed', currentPriceVersion: 4 })
    expect(calls[0]).toMatchObject({ method: 'POST', url: `/api/v1/merchants/${M}/pos/quote` })
    expect(calls[0]?.body).toEqual({ branchId: 'brn-1', lines: [line] })
    expect(JSON.stringify(calls[0]?.body)).not.toMatch(/unitPrice|lineTotal|totalRwf/)
  })

  it('saves with the retry key in the header, the identifier in the body and the CSRF token', async () => {
    const draft = {
      id: 'd-1',
      merchantId: M,
      branchId: 'brn-1',
      branchName: 'Main',
      status: 'DRAFT',
      lines: [
        {
          lineNo: 1,
          itemId: 'item-1',
          itemType: 'GOODS',
          name: 'Rice',
          measurementDimension: 'MASS',
          enteredQuantity: '2',
          enteredUnit: 'kg',
          saleUnit: 'kg',
          quantityInSaleUnit: '2',
          canonicalQuantity: '2000',
          canonicalUnit: 'g',
          priceVersion: 1,
          unitPriceRwf: 1500,
          lineTotalRwf: 3000,
          stock: { state: 'SUFFICIENT', onHand: '9000', requested: '2000', canonicalUnit: 'g' },
        },
      ],
      totalRwf: 3000,
      currency: 'RWF',
      createdByName: 'A',
      createdAt: 't',
      updatedAt: 't',
      version: 0,
      notice: 'not a sale',
      stockNote: 'n',
    }
    const { pos, calls } = setup({ status: 201, body: draft })
    const saved = await pos.createPosDraft(M, {
      clientRequestId: '5f0c1b6e-0c55-4a3e-93c8-6a2d3b9e8f10',
      idempotencyKey: 'a-stable-retry-key-0001',
      branchId: 'brn-1',
      note: 'Counter',
      lines: [line],
    })
    expect(saved).toMatchObject({ id: 'd-1', note: null })
    expect(saved.lines[0]).toMatchObject({ code: null, packageId: null, packageLabel: null })
    expect(calls[0]).toMatchObject({ method: 'POST', url: `/api/v1/merchants/${M}/pos/drafts` })
    expect(calls[0]?.headers).toMatchObject({
      'Idempotency-Key': 'a-stable-retry-key-0001',
      'X-XSRF-TOKEN': 'csrf-token',
    })
    expect(calls[0]?.body).toEqual({
      clientRequestId: '5f0c1b6e-0c55-4a3e-93c8-6a2d3b9e8f10',
      branchId: 'brn-1',
      note: 'Counter',
      lines: [line],
    })
  })

  it('lists, reads, updates and discards on the draft paths', async () => {
    const { pos, calls } = setup(
      { body: { items: [] } },
      { body: { id: 'd-1', lines: [] } },
      { body: { id: 'd-1', lines: [] } },
      { body: { id: 'd-1', lines: [], status: 'DISCARDED' } },
    )
    await expect(pos.listPosDrafts(M)).resolves.toEqual({ items: [], nextCursor: null })
    await pos.getPosDraft(M, 'd-1')
    await pos.updatePosDraft(M, 'd-1', { expectedVersion: 2, lines: [line] })
    await pos.discardPosDraft(M, 'd-1', 3)
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['GET', `/api/v1/merchants/${M}/pos/drafts?limit=20`],
      ['GET', `/api/v1/merchants/${M}/pos/drafts/d-1`],
      ['PUT', `/api/v1/merchants/${M}/pos/drafts/d-1`],
      ['DELETE', `/api/v1/merchants/${M}/pos/drafts/d-1?expectedVersion=3`],
    ])
    expect(calls[2]?.body).toEqual({ expectedVersion: 2, lines: [line] })
  })

  it('turns the server’s error codes into POS errors', async () => {
    const { pos } = setup({ status: 409, body: { code: 'pos_unavailable', message: 'nope' } })
    await expect(pos.getPosOptions(M)).rejects.toMatchObject({
      constructor: PosServiceError,
      code: 'pos_unavailable',
    })
  })
})

describe('HTTP POS billing keeps the contract with the backend (R7b)', () => {
  const review = {
    draftId: 'd-1',
    draftVersion: 3,
    branchId: 'brn-1',
    branchName: 'Main',
    problems: [{ lineNo: 1, code: 'tax_not_configured', message: 'no tax' }],
    subtotalRwf: 0,
    taxRwf: 0,
    totalRwf: 0,
    billable: false,
    mode: 'DEMONSTRATION',
    modeNote: 'n',
    stockNote: 's',
    taxNote: 't',
    lines: [
      {
        lineNo: 1,
        itemId: 'i-1',
        name: 'Beans',
        enteredQuantity: '2',
        enteredUnit: 'kg',
        saleUnit: 'kg',
        quantityInSaleUnit: '2',
        canonicalQuantity: '2000',
        canonicalUnit: 'g',
        priceVersion: 1,
        unitPriceRwf: 900,
        draftPriceVersion: 1,
        draftUnitPriceRwf: 900,
        priceChangedSinceDraft: false,
        taxApproved: false,
        netRwf: 0,
        taxRwf: 0,
        lineTotalRwf: 0,
        availability: { state: 'NOT_TRACKED', canonicalUnit: 'g' },
      },
    ],
  }

  it('reads the review (with the optional code) and fills what the server omits', async () => {
    const { pos, calls } = setup({ body: review })
    const result = await pos.getBillingReview(M, 'd-1', 'code-1')
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `/api/v1/merchants/${M}/pos/drafts/d-1/billing-review?collectionCodeId=code-1`,
    })
    expect(result.codeLabel).toBeNull()
    expect(result.approvedTaxTreatments).toEqual([])
    expect(result.lines[0]).toMatchObject({
      code: null,
      packageLabel: null,
      taxCategory: null,
      taxRateBp: null,
      availability: { physical: null, reserved: null, available: null, requested: null },
    })
    expect(result.problems[0]?.code).toBe('tax_not_configured')
  })

  it('bills with only the reviewed version and total, the retry key in the header and no price, tax or stock figure', async () => {
    const sale = {
      sale: {
        saleId: 'sale-1',
        invoiceId: 'inv-1',
        invoiceNumber: 'DEMO-0001',
        saleReference: 'OP-ABC12345',
        amountRwf: 5400,
        currency: 'RWF',
        description: 'POS sale (2 lines)',
        status: 'CREATED',
        stage: 'AWAITING_PAYMENT',
        confirmedAmount: 0,
        amountDue: 5400,
        expiresAt: 't',
        createdAt: 't',
        merchantDisplayName: 'Shop',
        branchName: 'Main',
        agentName: 'A',
        code: { mode: 'DEMONSTRATION', label: 'Counter', demoReference: 'SIM-1' },
      },
      draftId: 'd-1',
      mode: 'DEMONSTRATION',
      subtotalRwf: 5400,
      taxRwf: 0,
      totalRwf: 5400,
      taxNote: 't',
      lines: [
        {
          lineNo: 1,
          name: 'Rice',
          itemType: 'GOODS',
          saleUnit: 'kg',
          taxCategory: 'EXEMPT',
          taxRateBp: 0,
        },
      ],
      reservation: { state: 'NOT_RESERVED', note: 'DEMONSTRATION', lines: [] },
      fulfilment: {
        paymentState: 'NOT_APPLICABLE',
        appliedRwf: 0,
        totalRwf: 5400,
        inventoryState: 'NOT_APPLICABLE',
        attempts: 0,
        handover: 'NOT_TRACKED',
        note: 'DEMONSTRATION',
      },
    }
    const { pos, calls } = setup({ status: 201, body: sale })
    const billed = await pos.billPosDraft(M, 'd-1', {
      expectedDraftVersion: 3,
      reviewedTotalRwf: 5400,
      collectionCodeId: 'code-1',
      idempotencyKey: 'a-stable-bill-key-0001',
    })
    expect(calls[0]).toMatchObject({
      method: 'POST',
      url: `/api/v1/merchants/${M}/pos/drafts/d-1/bill`,
    })
    expect(calls[0]?.headers).toMatchObject({
      'Idempotency-Key': 'a-stable-bill-key-0001',
      'X-XSRF-TOKEN': 'csrf-token',
    })
    expect(calls[0]?.body).toEqual({
      expectedDraftVersion: 3,
      reviewedTotalRwf: 5400,
      collectionCodeId: 'code-1',
    })
    expect(billed.sale.code).toMatchObject({ bankCode: null, notice: null })
    expect(billed.lines[0]).toMatchObject({ code: null, enteredUnit: null, packageLabel: null })
    expect(billed.fulfilment).toMatchObject({
      postedAt: null,
      nextAttemptAt: null,
      lastError: null,
      lines: [],
      exceptions: [],
      events: [],
      handover: 'NOT_TRACKED',
    })
    expect(billed.reservation).toMatchObject({
      expiryReviewAt: null,
      releasedAt: null,
      releaseReason: null,
    })
  })

  it('reads a sale and turns the billing error codes into POS errors', async () => {
    const { pos, calls } = setup(
      { status: 404, body: { code: 'not_found', message: 'gone' } },
      { status: 409, body: { code: 'review_changed', message: 'changed' } },
      { status: 422, body: { code: 'tax_not_configured', message: 'no tax' } },
      { status: 409, body: { code: 'insufficient_stock', message: 'short' } },
    )
    await expect(pos.getPosSale(M, 'sale-1')).rejects.toMatchObject({ code: 'not_found' })
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `/api/v1/merchants/${M}/pos/sales/sale-1`,
    })
    const input = { expectedDraftVersion: 0, reviewedTotalRwf: 1, idempotencyKey: 'k-0000000001' }
    await expect(pos.billPosDraft(M, 'd-1', input)).rejects.toMatchObject({
      code: 'review_changed',
    })
    await expect(pos.billPosDraft(M, 'd-1', input)).rejects.toMatchObject({
      code: 'tax_not_configured',
    })
    await expect(pos.billPosDraft(M, 'd-1', input)).rejects.toMatchObject({
      code: 'insufficient_stock',
    })
  })
})

describe('HTTP POS fulfilment keeps the contract with the backend (R7c)', () => {
  it('reads the open fulfilment exceptions of the business and fills what the server omits', async () => {
    const { pos, calls } = setup({
      body: [
        {
          id: 'e-1',
          saleId: 'sale-1',
          saleReference: 'OP-ABC12345',
          invoiceNumber: 'INV-0007',
          kind: 'RESERVATION_RELEASED',
          status: 'OPEN',
          detail: 'Paid after release.',
          openedAt: 't',
        },
      ],
    })
    const [first] = await pos.listFulfilmentExceptions(M)
    expect(calls[0]).toMatchObject({
      method: 'GET',
      url: `/api/v1/merchants/${M}/pos/fulfilment/exceptions`,
    })
    expect(first).toMatchObject({ kind: 'RESERVATION_RELEASED', history: [] })
  })

  it('maps a refusal for someone who is not an owner', async () => {
    const { pos } = setup({ status: 403, body: { code: 'forbidden', message: 'no' } })
    await expect(pos.listFulfilmentExceptions(M)).rejects.toMatchObject({ code: 'forbidden' })
  })
})
