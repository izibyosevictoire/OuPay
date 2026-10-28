import { PosServiceError, type PosServiceErrorCode } from '@/services/posService'
import { createTestBackend } from '@/test/merchantTestDouble'
import type { PosLineInput } from '@/types/pos'
import { MOCK_STORAGE_KEYS } from './mockStorageKeys'
import {
  SAMPLE_CATALOG_ITEMS,
  SAMPLE_CATALOG_PRICES,
  type StoredCatalogItem,
  type StoredPriceVersion,
} from './sampleCatalog'
import { SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID } from './sampleMerchants'
import { SAMPLE_BRANCH_IDS } from './sampleOrganization'

const M = SAMPLE_MERCHANT_ID
const REMERA = SAMPLE_BRANCH_IDS.remera
const CITY = SAMPLE_BRANCH_IDS.cityCentre

function setup(
  signedInAs: Parameters<ReturnType<typeof createTestBackend>['signInAs']>[0] = 'cashier',
) {
  const backend = createTestBackend()
  backend.signInAs(signedInAs)
  return { ...backend, authStore: backend.store, pos: backend.fastPos }
}

async function codeOf(promise: Promise<unknown>): Promise<PosServiceErrorCode> {
  try {
    await promise
  } catch (error) {
    if (error instanceof PosServiceError) return error.code
    throw error
  }
  throw new Error('expected the call to be rejected')
}

const line = (
  itemId: string,
  quantity: string,
  unit: PosLineInput['unit'] = 'kg',
  expectedPriceVersion = itemId === 'cat-rice' ? 2 : 1,
): PosLineInput => ({ itemId, quantity, unit, packageId: null, expectedPriceVersion })

let counter = 0
const ids = () => ({
  clientRequestId: `5f0c1b6e-0c55-4a3e-93c8-${String(++counter).padStart(12, '0')}`,
  idempotencyKey: `retry-key-${String(counter).padStart(8, '0')}`,
})

describe('mock POS: pricing a mixed cart', () => {
  it('prices goods and services from the catalog with exact arithmetic', async () => {
    const { pos } = setup()
    const quote = await pos.quotePosCart(M, {
      branchId: REMERA,
      lines: [
        line('cat-rice', '2.5'),
        line('cat-haircut', '2', 'pc'),
        line('cat-phone', '1', 'pc'),
      ],
    })
    expect(quote.problems).toEqual([])
    expect(quote.lines.map((l) => l.lineTotalRwf)).toEqual([3_000, 6_000, 85_000])
    expect(quote.totalRwf).toBe(94_000)
    expect(quote.lines[0]).toMatchObject({
      saleUnit: 'kg',
      quantityInSaleUnit: '2.5',
      canonicalQuantity: '2500',
      unitPriceRwf: 1_200,
      priceVersion: 2,
    })
    expect(quote.lines[1]?.stock?.state).toBe('NOT_TRACKED')
  })

  it('converts a smaller unit exactly and rounds money once per line, half up', async () => {
    const { pos } = setup()
    const quote = await pos.quotePosCart(M, {
      branchId: REMERA,
      lines: [
        line('cat-rice', '250', 'g'),
        line('cat-rice', '1', 'g'),
        line('cat-rice', '1.5', 'kg'),
      ],
    })
    expect(quote.lines.map((l) => [l.quantityInSaleUnit, l.lineTotalRwf])).toEqual([
      ['0.25', 300],
      ['0.001', 1],
      ['1.5', 1_800],
    ])
  })

  it('refuses a quantity the bill cannot hold exactly, never rounds it', async () => {
    const { pos } = setup()
    const quote = await pos.quotePosCart(M, {
      branchId: REMERA,
      lines: [line('cat-rice', '0.5', 'g'), line('cat-rice', '1.0005', 'kg')],
    })
    expect(quote.lines).toEqual([])
    expect(quote.problems.map((p) => p.code)).toEqual([
      'quantity_not_representable',
      'quantity_not_representable',
    ])
  })

  it('refuses wrong units, fractional counts, bad text and non-positive amounts', async () => {
    const { pos } = setup()
    const codes = async (l: PosLineInput) =>
      (await pos.quotePosCart(M, { branchId: REMERA, lines: [l] })).problems.map((p) => p.code)
    expect(await codes(line('cat-phone', '2.5', 'pc'))).toEqual(['invalid_count'])
    expect(await codes(line('cat-phone', '1', 'kg'))).toEqual(['dimension_mismatch'])
    expect(await codes(line('cat-rice', '1', 'pc'))).toEqual(['dimension_mismatch'])
    expect(await codes(line('cat-rice', '1', 'stone' as never))).toEqual(['unsupported_unit'])
    expect(await codes(line('cat-rice', '0'))).toEqual(['quantity_out_of_range'])
    for (const bad of ['', 'abc', '-1', '1e3', '1,5', '1.', '+2']) {
      expect(await codes(line('cat-rice', bad))).toEqual(['invalid_quantity'])
    }
    expect(await codes({ ...line('cat-rice', '1'), unit: null })).toEqual([
      'unit_or_package_required',
    ])
    expect(await codes({ ...line('cat-rice', '1'), packageId: 'cat-rice-pkg-1' })).toEqual([
      'unit_or_package_required',
    ])
  })

  it('prices packages as whole numbers of the item’s own packages', async () => {
    const { pos } = setup()
    const bag = (count: string, packageId = 'cat-rice-pkg-1'): PosLineInput => ({
      itemId: 'cat-rice',
      quantity: count,
      unit: null,
      packageId,
      expectedPriceVersion: 2,
    })
    const quote = await pos.quotePosCart(M, { branchId: REMERA, lines: [bag('2')] })
    expect(quote.lines[0]).toMatchObject({
      quantityInSaleUnit: '50',
      canonicalQuantity: '50000',
      lineTotalRwf: 60_000,
      packageLabel: 'Bag',
    })
    const bad = await pos.quotePosCart(M, {
      branchId: REMERA,
      lines: [bag('1.5'), bag('1', 'nope')],
    })
    expect(bad.problems.map((p) => p.code)).toEqual(['invalid_package_count', 'package_not_found'])
  })
})

describe('mock POS: price versions', () => {
  it('refuses an old price version with the current price, and a client cannot choose a price', async () => {
    const { pos } = setup()
    const quote = await pos.quotePosCart(M, {
      branchId: REMERA,
      lines: [line('cat-rice', '1', 'kg', 7)],
    })
    expect(quote.problems[0]).toMatchObject({
      code: 'price_changed',
      currentPriceVersion: 2,
      currentPriceRwf: 1_200,
    })
    const tampered = { ...line('cat-rice', '1'), unitPriceRwf: 1 } as PosLineInput
    const ok = await pos.quotePosCart(M, { branchId: REMERA, lines: [tampered] })
    expect(ok.lines[0]?.unitPriceRwf).toBe(1_200)
  })

  it('keeps the price a draft was saved at, and reprices on an explicit update', async () => {
    const { pos, authStore } = setup()
    const draft = await pos.createPosDraft(M, {
      ...ids(),
      branchId: REMERA,
      lines: [line('cat-rice', '2')],
    })
    expect(draft.totalRwf).toBe(2_400)
    // The merchant reprices the rice: a new version (the catalog mock's own representation of it).
    const items = authStore.loadRecords<StoredCatalogItem>(
      MOCK_STORAGE_KEYS.catalogItems,
      SAMPLE_CATALOG_ITEMS,
    )
    authStore.saveRecords(
      MOCK_STORAGE_KEYS.catalogItems,
      items.map((i) =>
        i.id === 'cat-rice' ? { ...i, priceVersion: 3, pricePerSaleUnitRwf: 1_500 } : i,
      ),
    )
    authStore.saveRecords(MOCK_STORAGE_KEYS.catalogPrices, [
      ...authStore.loadRecords<StoredPriceVersion>(
        MOCK_STORAGE_KEYS.catalogPrices,
        SAMPLE_CATALOG_PRICES,
      ),
      {
        merchantId: M,
        itemId: 'cat-rice',
        version: 3,
        pricePerSaleUnitRwf: 1_500,
        saleUnit: 'kg',
        effectiveAt: '2026-10-01T09:00:00+02:00',
        reason: null,
      },
    ])
    const reopened = await pos.getPosDraft(M, draft.id)
    expect(reopened.lines[0]).toMatchObject({ priceVersion: 2, unitPriceRwf: 1_200 })
    expect(reopened.totalRwf).toBe(2_400)
    expect(
      await codeOf(
        pos.updatePosDraft(M, draft.id, { expectedVersion: 0, lines: [line('cat-rice', '2')] }),
      ),
    ).toBe('invalid_cart')
    const updated = await pos.updatePosDraft(M, draft.id, {
      expectedVersion: 0,
      lines: [line('cat-rice', '2', 'kg', 3)],
    })
    expect(updated.lines[0]).toMatchObject({ priceVersion: 3, unitPriceRwf: 1_500 })
    expect(updated.totalRwf).toBe(3_000)
  })

  it('does not sell inactive or unknown items', async () => {
    const { pos } = setup()
    const quote = await pos.quotePosCart(M, {
      branchId: REMERA,
      lines: [line('cat-feature-phone', '1', 'pc'), line('cat-cafe-beans', '1')],
    })
    expect(quote.problems.map((p) => p.code)).toEqual(['item_inactive', 'item_not_found'])
    const found = await pos.searchPosItems(M, REMERA, '')
    expect(found.map((i) => i.name)).not.toContain('Feature phone (discontinued)')
    expect(found.map((i) => i.itemId)).not.toContain('cat-cafe-beans')
  })
})

describe('mock POS: stock is informational', () => {
  it('warns about insufficient stock, sums lines of one good, and holds and deducts nothing', async () => {
    const { pos, authStore } = setup()
    const before = authStore.loadRecords(MOCK_STORAGE_KEYS.inventoryBalances, [])
    const movementsBefore = authStore.loadRecords(MOCK_STORAGE_KEYS.inventoryMovements, [])
    const quote = await pos.quotePosCart(M, {
      branchId: REMERA,
      lines: [line('cat-rice', '500'), line('cat-rice', '300000', 'g')],
    })
    expect(quote.problems).toEqual([])
    expect(quote.lines[0]?.stock).toMatchObject({ state: 'INSUFFICIENT', requested: '800000' })
    expect(quote.lines[1]?.stock?.requested).toBe('800000')
    await pos.createPosDraft(M, { ...ids(), branchId: REMERA, lines: [line('cat-rice', '800')] })
    expect(authStore.loadRecords(MOCK_STORAGE_KEYS.inventoryBalances, [])).toEqual(before)
    expect(authStore.loadRecords(MOCK_STORAGE_KEYS.inventoryMovements, [])).toEqual(movementsBefore)
    const items = await pos.searchPosItems(M, REMERA, 'rice')
    expect(items[0]?.stock).toMatchObject({
      state: 'RECORDED',
      onHand: '746500',
      onHandInSaleUnit: '746.5',
    })
  })
})

describe('mock POS: access', () => {
  it('is for businesses in business mode and people assigned to the branch', async () => {
    const owner = setup('owner')
    expect((await owner.pos.getPosOptions(M)).readiness).toBe('NO_BRANCH')
    expect(
      await codeOf(owner.pos.quotePosCart(M, { branchId: REMERA, lines: [line('cat-rice', '1')] })),
    ).toBe('no_eligible_branch')
    const cashier = setup()
    expect((await cashier.pos.getPosOptions(M)).branches.map((b) => b.id).sort()).toEqual(
      [REMERA, CITY].sort(),
    )
    expect(
      await codeOf(
        cashier.pos.quotePosCart(M, {
          branchId: SAMPLE_BRANCH_IDS.nyamirambo,
          lines: [line('cat-rice', '1')],
        }),
      ),
    ).toBe('branch_not_eligible')
  })

  it('keeps another business out', async () => {
    const cafe = setup('cafeOwner')
    expect(await codeOf(cafe.pos.getPosOptions(M))).toBe('not_found')
    expect(await codeOf(cafe.pos.getPosDraft(SAMPLE_SECOND_MERCHANT_ID, 'nope'))).toBe('not_found')
  })

  it('shows drafts to their creator and the branch manager, and nobody else', async () => {
    const cashier = setup()
    const draft = await cashier.pos.createPosDraft(M, {
      ...ids(),
      branchId: REMERA,
      lines: [line('cat-rice', '1')],
    })
    expect((await cashier.pos.listPosDrafts(M)).items.map((d) => d.id)).toEqual([draft.id])
    cashier.signInAs('manager')
    expect((await cashier.pos.listPosDrafts(M)).items.map((d) => d.id)).toEqual([draft.id])
    expect(
      await codeOf(
        cashier.pos.updatePosDraft(M, draft.id, {
          expectedVersion: 0,
          lines: [line('cat-rice', '2')],
        }),
      ),
    ).toBe('not_found')
  })
})

describe('mock POS: drafts', () => {
  it('replays the same attempt and refuses a different cart under the same identity', async () => {
    const { pos } = setup()
    const attempt = ids()
    const first = await pos.createPosDraft(M, {
      ...attempt,
      branchId: REMERA,
      lines: [line('cat-rice', '1')],
    })
    const again = await pos.createPosDraft(M, {
      ...attempt,
      branchId: REMERA,
      lines: [line('cat-rice', '1')],
    })
    expect(again.id).toBe(first.id)
    const newKey = await pos.createPosDraft(M, {
      clientRequestId: attempt.clientRequestId,
      idempotencyKey: 'a-different-retry-key',
      branchId: REMERA,
      lines: [line('cat-rice', '1')],
    })
    expect(newKey.id).toBe(first.id)
    expect(
      await codeOf(
        pos.createPosDraft(M, {
          clientRequestId: attempt.clientRequestId,
          idempotencyKey: 'yet-another-key-1',
          branchId: REMERA,
          lines: [line('cat-rice', '3')],
        }),
      ),
    ).toBe('client_request_id_reuse')
    expect(
      await codeOf(
        pos.createPosDraft(M, { ...attempt, branchId: REMERA, lines: [line('cat-rice', '9')] }),
      ),
    ).toBe('idempotency_key_reuse')
    expect((await pos.listPosDrafts(M)).items).toHaveLength(1)
  })

  it('is a draft, not a sale: no invoice, no payment request, and it says so', async () => {
    const { pos, authStore } = setup()
    const invoices = authStore.loadRecords(MOCK_STORAGE_KEYS.invoices, [])
    const requests = authStore.loadRecords(MOCK_STORAGE_KEYS.paymentRequests, [])
    const draft = await pos.createPosDraft(M, {
      ...ids(),
      branchId: REMERA,
      lines: [line('cat-rice', '1')],
    })
    expect(draft.notice).toContain('not a sale')
    expect(draft.status).toBe('DRAFT')
    expect(authStore.loadRecords(MOCK_STORAGE_KEYS.invoices, [])).toEqual(invoices)
    expect(authStore.loadRecords(MOCK_STORAGE_KEYS.paymentRequests, [])).toEqual(requests)
  })

  it('replaces the whole cart, conflicts on a stale version, and discards finally', async () => {
    const { pos } = setup()
    const draft = await pos.createPosDraft(M, {
      ...ids(),
      branchId: REMERA,
      note: 'First',
      lines: [line('cat-rice', '1')],
    })
    const updated = await pos.updatePosDraft(M, draft.id, {
      expectedVersion: 0,
      note: 'Second',
      lines: [line('cat-haircut', '1', 'pc')],
    })
    expect(updated).toMatchObject({ version: 1, totalRwf: 3_000, note: 'Second' })
    expect(updated.lines).toHaveLength(1)
    expect(
      await codeOf(
        pos.updatePosDraft(M, draft.id, { expectedVersion: 0, lines: [line('cat-rice', '1')] }),
      ),
    ).toBe('version_conflict')
    const discarded = await pos.discardPosDraft(M, draft.id, 1)
    expect(discarded.status).toBe('DISCARDED')
    expect(
      await codeOf(
        pos.updatePosDraft(M, draft.id, { expectedVersion: 2, lines: [line('cat-rice', '1')] }),
      ),
    ).toBe('draft_not_open')
  })

  it('needs at least one line and at most the limit', async () => {
    const { pos } = setup()
    expect(await codeOf(pos.createPosDraft(M, { ...ids(), branchId: REMERA, lines: [] }))).toBe(
      'validation',
    )
    const many = Array.from({ length: 101 }, () => line('cat-rice', '1'))
    expect(await codeOf(pos.createPosDraft(M, { ...ids(), branchId: REMERA, lines: many }))).toBe(
      'validation',
    )
  })
})

describe('mock POS: review additions', () => {
  it('bills what was entered in any compatible unit, once, and refuses a line rounding to nothing', async () => {
    const { pos } = setup()
    const quote = await pos.quotePosCart(M, {
      branchId: REMERA,
      lines: [
        line('cat-rice', '500', 'g'),
        line('cat-rice', '1.5', 'kg'),
        line('cat-cement', '1', 'g'),
      ],
    })
    expect(quote.lines.map((l) => [l.quantityInSaleUnit, l.lineTotalRwf])).toEqual([
      ['0.5', 600],
      ['1.5', 1_800],
    ])
    // 1 g of RWF 290 per kg is RWF 0.29: refused instead of given away.
    expect(quote.problems.map((p) => [p.lineIndex, p.code])).toEqual([[2, 'line_total_zero']])
    // Both rice lines share one stock check (2 kg together).
    expect(quote.lines[0]?.stock?.requested).toBe('2000')
    expect(quote.lines[1]?.stock?.requested).toBe('2000')
  })

  it('labels every quote and draft total provisional', async () => {
    const { pos } = setup()
    const quote = await pos.quotePosCart(M, { branchId: REMERA, lines: [line('cat-rice', '1')] })
    expect(quote.taxNote).toMatch(/Provisional total: tax is not calculated/)
    const draft = await pos.createPosDraft(M, {
      ...ids(),
      branchId: REMERA,
      lines: [line('cat-rice', '1')],
    })
    expect(draft.taxNote).toMatch(/Provisional total/)
  })

  it('leaves a draft untouched when an update is refused', async () => {
    const { pos } = setup()
    const draft = await pos.createPosDraft(M, {
      ...ids(),
      branchId: REMERA,
      note: 'Keep',
      lines: [line('cat-rice', '2')],
    })
    expect(
      await codeOf(
        pos.updatePosDraft(M, draft.id, {
          expectedVersion: 0,
          note: 'Changed',
          lines: [line('cat-phone', '1.5', 'pc')],
        }),
      ),
    ).toBe('invalid_cart')
    const after = await pos.getPosDraft(M, draft.id)
    expect(after).toMatchObject({ version: 0, note: 'Keep', totalRwf: 2_400 })
    expect(after.lines).toHaveLength(1)
  })
})
