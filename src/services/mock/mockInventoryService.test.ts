import { InventoryServiceError, type InventoryServiceErrorCode } from '@/services/inventoryService'
import { createTestBackend } from '@/test/merchantTestDouble'
import type { MeasurementUnitCode } from '@/types/catalog'
import type { StockMovementType } from '@/types/inventory'
import { SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID } from './sampleMerchants'
import { SAMPLE_BRANCH_IDS } from './sampleOrganization'

const M = SAMPLE_MERCHANT_ID
const REMERA = SAMPLE_BRANCH_IDS.remera
const CITY = SAMPLE_BRANCH_IDS.cityCentre
const CLOSED = SAMPLE_BRANCH_IDS.nyamirambo

function setup(
  signedInAs: Parameters<ReturnType<typeof createTestBackend>['signInAs']>[0] = 'owner',
) {
  const backend = createTestBackend()
  backend.signInAs(signedInAs)
  return { ...backend, inventory: backend.fastInventory }
}

type Setup = ReturnType<typeof setup>

let counter = 0
/** A valid, unique operation id. */
const opId = () => `11111111-2222-4333-8444-${String(++counter).padStart(12, '0')}`

async function codeOf(promise: Promise<unknown>): Promise<InventoryServiceErrorCode> {
  try {
    await promise
  } catch (error) {
    if (error instanceof InventoryServiceError) return error.code
    throw error
  }
  throw new Error('expected the call to be rejected')
}

const receive = (
  s: Setup,
  itemId: string,
  amount: string,
  unit: MeasurementUnitCode,
  branchId: string = REMERA,
  clientOperationId: string = opId(),
) => s.inventory.receiveStock(M, { clientOperationId, branchId, itemId, amount, unit })

const adjustOut = (
  s: Setup,
  itemId: string,
  amount: string,
  unit: MeasurementUnitCode,
  branchId: string = REMERA,
) =>
  s.inventory.adjustStock(M, {
    clientOperationId: opId(),
    branchId,
    itemId,
    amount,
    unit,
    direction: 'OUT',
    reason: 'Counted fewer',
  })

const onHand = async (s: Setup, itemId: string, branchId: string = REMERA) =>
  (await s.inventory.listBalances(M, { itemId, branchId })).items[0]?.quantityOnHand

describe('mock inventory: reading', () => {
  it('lists the sample balances newest first, exact and in both units', async () => {
    const s = setup()
    const page = await s.inventory.listBalances(M)
    expect(page.items.map((b) => `${b.itemName}@${b.branchCode}`)).toEqual([
      'Smartphone@KCC',
      'Smartphone@RM01',
      'Floor tiles@RM01',
      'Kitenge fabric@RM01',
      'Cement@RM01',
      'Cooking oil@RM01',
      'Rice@KCC',
      'Rice@RM01',
    ])
    const rice = page.items.find((b) => b.itemName === 'Rice' && b.branchCode === 'RM01')!
    expect(rice.quantityOnHand).toBe('746500')
    expect(rice.stockUnit).toBe('g')
    expect(rice.saleUnit).toBe('kg')
    expect(rice.quantityInSaleUnit).toBe('746.5')
    expect(rice.itemCode).toBe('RICE')
    const tiles = page.items.find((b) => b.itemName === 'Floor tiles')!
    expect(tiles.quantityOnHand).toBe('25000000')
    expect(tiles.quantityInSaleUnit).toBe('25')
    expect(page.nextCursor).toBeNull()
  })

  it('searches by item name or code and filters by branch and item', async () => {
    const s = setup()
    expect((await s.inventory.listBalances(M, { q: 'rice' })).items).toHaveLength(2)
    expect((await s.inventory.listBalances(M, { q: 'OIL' })).items).toHaveLength(1)
    expect((await s.inventory.listBalances(M, { branchId: CITY })).items).toHaveLength(2)
    expect((await s.inventory.listBalances(M, { itemId: 'cat-phone' })).items).toHaveLength(2)
    expect((await s.inventory.listBalances(M, { q: 'zzz' })).items).toHaveLength(0)
  })

  it('shows stock history newest first with exact signed quantities, and paginates it without gaps', async () => {
    const s = setup()
    const all = (await s.inventory.listMovements(M, { limit: 200 })).items
    expect(all).toHaveLength(12)
    const first = await s.inventory.listMovements(M, { limit: 5 })
    expect(first.items).toHaveLength(5)
    expect(first.nextCursor).not.toBeNull()
    const second = await s.inventory.listMovements(M, { limit: 5, cursor: first.nextCursor })
    const third = await s.inventory.listMovements(M, { limit: 5, cursor: second.nextCursor })
    expect(third.items).toHaveLength(2)
    expect(third.nextCursor).toBeNull()
    const ids = [...first.items, ...second.items, ...third.items].map((m) => m.id)
    expect(ids).toEqual(all.map((m) => m.id))
    expect(new Set(ids).size).toBe(12)
    const spill = all.find((m) => m.quantityDelta === '-3500')!
    expect(spill).toMatchObject({
      movementType: 'ADJUST_OUT',
      balanceAfter: '746500',
      reason: 'Spillage in the store room',
      itemName: 'Rice',
    })
    expect(
      (await s.inventory.listMovements(M, { type: 'RECEIVE' })).items.map((m) => m.reference),
    ).toEqual(['DN-1051', 'DN-1042'])
    expect((await s.inventory.listMovements(M, { branchId: CITY })).items).toHaveLength(2)
    expect((await s.inventory.listMovements(M, { itemId: 'cat-oil' })).items).toHaveLength(2)
    await expect(s.inventory.listMovements(M, { cursor: 'nope' })).rejects.toMatchObject({
      code: 'validation',
    })
  })
})

describe('mock inventory: authorisation and branch eligibility', () => {
  it('shows an owner every branch, and where stock can be recorded', async () => {
    const { branches } = await setup('owner').inventory.getOptions(M)
    expect(branches.map((b) => [b.code, b.writable])).toEqual([
      ['KCC', true],
      ['NYA1', false],
      ['RM01', true],
    ])
  })

  it('lets a manager view every branch but record only where they are assigned', async () => {
    const s = setup('manager')
    const { branches } = await s.inventory.getOptions(M)
    expect(branches).toHaveLength(3)
    expect(branches.filter((b) => b.writable).map((b) => b.code)).toEqual(['RM01'])
    expect((await s.inventory.listBalances(M)).items).toHaveLength(8)
    expect((await receive(s, 'cat-rice', '1', 'kg')).replayed).toBe(false)
    expect(await codeOf(receive(s, 'cat-rice', '1', 'kg', CITY))).toBe('forbidden')
    expect(
      (
        await s.inventory.adjustStock(M, {
          clientOperationId: opId(),
          branchId: REMERA,
          itemId: 'cat-rice',
          amount: '1',
          unit: 'kg',
          direction: 'OUT',
          reason: 'Damaged',
        })
      ).movement.movementType,
    ).toBe('ADJUST_OUT')
  })

  it('lets a cashier read only the branches they are assigned to and never write', async () => {
    const s = setup('cashier')
    const { branches } = await s.inventory.getOptions(M)
    expect(branches.map((b) => [b.code, b.writable])).toEqual([
      ['KCC', false],
      ['RM01', false],
    ])
    expect((await s.inventory.listBalances(M)).items.every((b) => b.branchCode !== 'NYA1')).toBe(
      true,
    )
    expect(await codeOf(receive(s, 'cat-rice', '1', 'kg'))).toBe('forbidden')
    expect(
      await codeOf(
        s.inventory.adjustStock(M, {
          clientOperationId: opId(),
          branchId: REMERA,
          itemId: 'cat-rice',
          amount: '1',
          unit: 'kg',
          direction: 'OUT',
          reason: 'x',
        }),
      ),
    ).toBe('forbidden')
    expect(
      await codeOf(
        s.inventory.recordOpening(M, {
          clientOperationId: opId(),
          branchId: REMERA,
          itemId: 'cat-feature-phone',
          amount: '1',
          unit: 'pc',
        }),
      ),
    ).toBe('forbidden')
  })

  it('shows a cashier only assigned branches that are still active (as the server does)', async () => {
    const s = setup('owner')
    await s.fastBranches.changeBranchStatus(M, REMERA, 'INACTIVE')
    s.signInAs('cashier')
    const { branches } = await s.inventory.getOptions(M)
    expect(branches.map((b) => b.code)).toEqual(['KCC'])
    expect((await s.inventory.listBalances(M)).items.every((b) => b.branchCode === 'KCC')).toBe(
      true,
    )
    expect((await s.inventory.listMovements(M)).items.every((m) => m.branchId === CITY)).toBe(true)
  })

  it('refuses an inactive branch and an unknown one', async () => {
    const s = setup()
    expect(await codeOf(receive(s, 'cat-rice', '1', 'kg', CLOSED))).toBe('branch_inactive')
    expect(await codeOf(receive(s, 'cat-rice', '1', 'kg', 'brn-nope'))).toBe('not_found')
    // A branch of another business is not found either.
    expect(await codeOf(receive(s, 'cat-rice', '1', 'kg', SAMPLE_BRANCH_IDS.cafe))).toBe(
      'not_found',
    )
  })

  it('has no inventory for a business that is not in business mode', async () => {
    const s = setup()
    await s.fastMerchants.updateMerchantSettings(M, {
      operatingMode: 'SIMPLIFIED',
      expectedVersion: 0,
    })
    expect(await codeOf(s.inventory.getOptions(M))).toBe('inventory_unavailable')
    expect(await codeOf(s.inventory.listBalances(M))).toBe('inventory_unavailable')
    expect(await codeOf(receive(s, 'cat-rice', '1', 'kg'))).toBe('inventory_unavailable')
  })

  it('isolates businesses', async () => {
    const owner = setup('owner')
    // The owner is only a cashier of the second business: read-only, and only its own branch.
    const beans = await owner.inventory.listBalances(SAMPLE_SECOND_MERCHANT_ID)
    expect(beans.items.map((b) => b.itemName)).toEqual(['Coffee beans'])
    expect(
      await codeOf(
        owner.inventory.receiveStock(SAMPLE_SECOND_MERCHANT_ID, {
          clientOperationId: opId(),
          branchId: SAMPLE_BRANCH_IDS.cafe,
          itemId: 'cat-cafe-beans',
          amount: '1',
          unit: 'kg',
        }),
      ),
    ).toBe('forbidden')
    // A stranger gets "not found", and cannot name another business's item.
    const cafe = setup('cafeOwner')
    expect(await codeOf(cafe.inventory.listBalances(M))).toBe('not_found')
    expect(
      await codeOf(
        cafe.inventory.receiveStock(SAMPLE_SECOND_MERCHANT_ID, {
          clientOperationId: opId(),
          branchId: SAMPLE_BRANCH_IDS.cafe,
          itemId: 'cat-rice',
          amount: '1',
          unit: 'kg',
        }),
      ),
    ).toBe('not_found')
  })

  it('needs a signed-in user', async () => {
    const backend = createTestBackend()
    expect(await codeOf(backend.fastInventory.getOptions(M))).toBe('unauthenticated')
  })
})

describe('mock inventory: goods only', () => {
  it('refuses services and unknown items', async () => {
    const s = setup()
    expect(await codeOf(receive(s, 'cat-haircut', '1', 'pc'))).toBe('invalid_item')
    expect(await codeOf(receive(s, 'cat-carwash', '1', 'pc'))).toBe('invalid_item')
    expect(await codeOf(receive(s, 'cat-nope', '1', 'pc'))).toBe('not_found')
    expect(await codeOf(receive(s, 'cat-cafe-beans', '1', 'kg'))).toBe('not_found')
    const stock = await s.inventory.listBalances(M, { itemId: 'cat-haircut' })
    expect(stock.items).toHaveLength(0)
  })
})

describe('mock inventory: exact quantities', () => {
  it('converts any unit of the dimension to the canonical unit without rounding', async () => {
    const s = setup()
    const result = await receive(s, 'cat-rice', '2.5', 'kg')
    expect(result.movement).toMatchObject({
      movementType: 'RECEIVE',
      quantityDelta: '2500',
      balanceAfter: '749000',
      enteredAs: '2.5 kg',
      stockUnit: 'g',
    })
    expect(result.balance.quantityOnHand).toBe('749000')
    expect((await receive(s, 'cat-rice', '0.000001', 'g')).balance.quantityOnHand).toBe(
      '749000.000001',
    )
    // 0.0000001 kg is 0.0001 g: exact.
    expect((await receive(s, 'cat-rice', '0.0000001', 'kg')).movement.quantityDelta).toBe('0.0001')
    expect((await receive(s, 'cat-oil', '1.25', 'l')).movement.quantityDelta).toBe('1250')
    expect((await receive(s, 'cat-fabric', '0.5', 'm')).movement.quantityDelta).toBe('500')
    expect((await receive(s, 'cat-tiles', '1.5', 'm2')).movement.quantityDelta).toBe('1500000')
  })

  it('never adds binary floating-point error', async () => {
    const s = setup()
    await receive(s, 'cat-rice', '0.1', 'g')
    const result = await receive(s, 'cat-rice', '0.2', 'g')
    expect(result.balance.quantityOnHand).toBe('746500.3')
  })

  it('rejects what cannot be stored exactly, and changes nothing', async () => {
    const s = setup()
    const before = await onHand(s, 'cat-rice')
    expect(await codeOf(receive(s, 'cat-rice', '0.0000001', 'g'))).toBe('precision_exceeded')
    expect(await codeOf(receive(s, 'cat-rice', '1.1234567', 'g'))).toBe('precision_exceeded')
    expect(await codeOf(receive(s, 'cat-rice', '100000000000000', 'g'))).toBe(
      'quantity_out_of_range',
    )
    expect(await codeOf(receive(s, 'cat-rice', '100000000000', 'kg'))).toBe('quantity_out_of_range')
    expect(await codeOf(receive(s, 'cat-rice', '0', 'g'))).toBe('quantity_out_of_range')
    expect(await codeOf(receive(s, 'cat-rice', '-5', 'g'))).toBe('quantity_out_of_range')
    expect(await codeOf(receive(s, 'cat-rice', 'abc', 'g'))).toBe('invalid_quantity')
    expect(await codeOf(receive(s, 'cat-rice', '1e3', 'g'))).toBe('invalid_quantity')
    expect(await codeOf(receive(s, 'cat-rice', '1,5', 'g'))).toBe('invalid_quantity')
    expect(await codeOf(receive(s, 'cat-rice', '1', 'l'))).toBe('dimension_mismatch')
    expect(await codeOf(receive(s, 'cat-rice', '1', 'stone' as MeasurementUnitCode))).toBe(
      'unsupported_unit',
    )
    expect(await onHand(s, 'cat-rice')).toBe(before)
    expect((await s.inventory.listMovements(M)).items).toHaveLength(12)
  })

  it('counts discrete goods in whole pieces only', async () => {
    const s = setup()
    expect(await codeOf(receive(s, 'cat-phone', '1.5', 'pc'))).toBe('invalid_count')
    expect(await codeOf(receive(s, 'cat-phone', '0.000001', 'pc'))).toBe('invalid_count')
    expect((await receive(s, 'cat-phone', '3.000', 'pc')).balance.quantityOnHand).toBe('44')
  })

  it('never lets the stock exceed what can be recorded', async () => {
    const s = setup()
    await receive(s, 'cat-rice', '99999999000000', 'g')
    expect(await codeOf(receive(s, 'cat-rice', '99999999000000', 'g'))).toBe(
      'quantity_out_of_range',
    )
  })

  it('requires exactly one way of entering the quantity', async () => {
    const s = setup()
    const base = { clientOperationId: opId(), branchId: REMERA, itemId: 'cat-rice' }
    expect(await codeOf(s.inventory.receiveStock(M, base as never))).toBe('validation')
    expect(
      await codeOf(
        s.inventory.receiveStock(M, {
          ...base,
          amount: '1',
          unit: 'kg',
          packageId: 'cat-rice-pkg-1',
          packageCount: '1',
        } as never),
      ),
    ).toBe('validation')
  })
})

describe('mock inventory: packages', () => {
  const byPackage = (s: Setup, itemId: string, packageId: string, packageCount: string) =>
    s.inventory.receiveStock(M, {
      clientOperationId: opId(),
      branchId: REMERA,
      itemId,
      packageId,
      packageCount,
    })

  it('converts a package count to the exact canonical quantity', async () => {
    const s = setup()
    const bags = await byPackage(s, 'cat-rice', 'cat-rice-pkg-1', '2')
    expect(bags.movement).toMatchObject({ quantityDelta: '50000', enteredAs: '2 x Bag' })
    expect((await byPackage(s, 'cat-rice', 'cat-rice-pkg-1', '1.5')).movement.quantityDelta).toBe(
      '37500',
    )
    expect((await byPackage(s, 'cat-oil', 'cat-oil-pkg-1', '6')).movement.quantityDelta).toBe(
      '4500',
    )
    expect((await byPackage(s, 'cat-phone', 'cat-phone-pkg-1', '1.5')).movement.quantityDelta).toBe(
      '15',
    )
  })

  it('never creates a fraction of a piece from a package', async () => {
    const s = setup()
    expect(await codeOf(byPackage(s, 'cat-phone', 'cat-phone-pkg-1', '0.05'))).toBe('invalid_count')
    expect(await onHand(s, 'cat-phone')).toBe('41')
  })

  it('refuses a package of another item, an inactive package and a bad count', async () => {
    const s = setup()
    expect(await codeOf(byPackage(s, 'cat-rice', 'cat-oil-pkg-1', '1'))).toBe('not_found')
    expect(await codeOf(byPackage(s, 'cat-rice', 'cat-rice-pkg-1', 'two'))).toBe('invalid_quantity')
    expect(await codeOf(byPackage(s, 'cat-rice', 'cat-rice-pkg-1', '0'))).toBe(
      'quantity_out_of_range',
    )
    await s.fastCatalog.updatePackage(M, 'cat-rice', 'cat-rice-pkg-1', {
      expectedVersion: 0,
      label: 'Bag',
      contentsAmount: '25',
      contentsUnit: 'kg',
      active: false,
    })
    expect(await codeOf(byPackage(s, 'cat-rice', 'cat-rice-pkg-1', '1'))).toBe('package_inactive')
  })
})

describe('mock inventory: no negative stock', () => {
  it('refuses to take out more than is held, and leaves the stock as it was', async () => {
    const s = setup()
    expect(await codeOf(adjustOut(s, 'cat-phone', '42', 'pc'))).toBe('insufficient_stock')
    expect(await onHand(s, 'cat-phone')).toBe('41')
    expect(await codeOf(adjustOut(s, 'cat-rice', '747', 'kg'))).toBe('insufficient_stock')
    expect(await onHand(s, 'cat-rice')).toBe('746500')
    expect((await s.inventory.listMovements(M)).items).toHaveLength(12)
  })

  it('allows taking out exactly everything, but nothing more', async () => {
    const s = setup()
    const result = await adjustOut(s, 'cat-phone', '41', 'pc')
    expect(result.balance.quantityOnHand).toBe('0')
    expect(result.movement).toMatchObject({ quantityDelta: '-41', balanceAfter: '0' })
    expect(await codeOf(adjustOut(s, 'cat-phone', '1', 'pc'))).toBe('insufficient_stock')
    // Out of an item with no stock row at all.
    expect(await codeOf(adjustOut(s, 'cat-feature-phone', '1', 'pc'))).toBe('insufficient_stock')
  })

  it('is exact to the last decimal', async () => {
    const s = setup()
    await receive(s, 'cat-rice', '0.000001', 'g')
    expect(await codeOf(adjustOut(s, 'cat-rice', '746500.000002', 'g'))).toBe('insufficient_stock')
    expect((await adjustOut(s, 'cat-rice', '746500.000001', 'g')).balance.quantityOnHand).toBe('0')
  })
})

describe('mock inventory: adjustments', () => {
  it('needs a direction and a reason', async () => {
    const s = setup()
    const base = {
      clientOperationId: opId(),
      branchId: REMERA,
      itemId: 'cat-rice',
      amount: '1',
      unit: 'kg' as const,
    }
    expect(await codeOf(s.inventory.adjustStock(M, { ...base, direction: 'IN' } as never))).toBe(
      'validation',
    )
    expect(
      await codeOf(s.inventory.adjustStock(M, { ...base, direction: 'IN', reason: '   ' })),
    ).toBe('validation')
    expect(
      await codeOf(s.inventory.adjustStock(M, { ...base, direction: 'UP', reason: 'x' } as never)),
    ).toBe('validation')
    expect(
      await codeOf(
        s.inventory.adjustStock(M, { ...base, direction: 'IN', reason: 'x'.repeat(201) }),
      ),
    ).toBe('validation')
  })

  it('records the direction and the reason in an immutable movement', async () => {
    const s = setup()
    const added = await s.inventory.adjustStock(M, {
      clientOperationId: opId(),
      branchId: REMERA,
      itemId: 'cat-rice',
      amount: '2',
      unit: 'kg',
      direction: 'IN',
      reason: 'Found in the back room',
      reference: 'COUNT-7',
    })
    expect(added.movement).toMatchObject({
      movementType: 'ADJUST_IN' satisfies StockMovementType,
      quantityDelta: '2000',
      reason: 'Found in the back room',
      reference: 'COUNT-7',
      actorName: 'Sample Owner',
    })
    const removed = await adjustOut(s, 'cat-rice', '500', 'g')
    expect(removed.movement.quantityDelta).toBe('-500')
    expect(removed.balance.quantityOnHand).toBe('748000')
  })
})

describe('mock inventory: opening stock', () => {
  it('is recorded once, for an item with no history at that branch', async () => {
    const s = setup()
    const input = {
      clientOperationId: opId(),
      branchId: CITY,
      itemId: 'cat-fabric',
      amount: '40',
      unit: 'm' as const,
    }
    const opened = await s.inventory.recordOpening(M, input)
    expect(opened.movement).toMatchObject({ movementType: 'OPENING', quantityDelta: '40000' })
    expect(opened.balance).toMatchObject({ quantityOnHand: '40000', branchCode: 'KCC' })
    expect(
      await codeOf(s.inventory.recordOpening(M, { ...input, clientOperationId: opId() })),
    ).toBe('opening_already_recorded')
    expect(await onHand(s, 'cat-fabric', CITY)).toBe('40000')
  })

  it('is refused once any other movement exists', async () => {
    const s = setup()
    expect(
      await codeOf(
        s.inventory.recordOpening(M, {
          clientOperationId: opId(),
          branchId: REMERA,
          itemId: 'cat-rice',
          amount: '1',
          unit: 'kg',
        }),
      ),
    ).toBe('opening_already_recorded')
    // Even after a receipt creates the history, an opening cannot follow it.
    await receive(s, 'cat-feature-phone', '5', 'pc')
    expect(
      await codeOf(
        s.inventory.recordOpening(M, {
          clientOperationId: opId(),
          branchId: REMERA,
          itemId: 'cat-feature-phone',
          amount: '5',
          unit: 'pc',
        }),
      ),
    ).toBe('opening_already_recorded')
  })
})

describe('mock inventory: replay and conflict by operation id', () => {
  it('adds stock exactly once however often the same operation is sent', async () => {
    const s = setup()
    const id = opId()
    const first = await receive(s, 'cat-rice', '10', 'kg', REMERA, id)
    expect(first.replayed).toBe(false)
    const again = await receive(s, 'cat-rice', '10', 'kg', REMERA, id)
    const third = await receive(s, 'cat-rice', '10', 'kg', REMERA, id)
    expect(again.replayed).toBe(true)
    expect(third.replayed).toBe(true)
    expect(again.movement.id).toBe(first.movement.id)
    expect(await onHand(s, 'cat-rice')).toBe('756500')
    expect((await s.inventory.listMovements(M)).items).toHaveLength(13)
  })

  it('treats the same quantity in another unit as the same request', async () => {
    const s = setup()
    const id = opId()
    await receive(s, 'cat-rice', '1', 'kg', REMERA, id)
    expect((await receive(s, 'cat-rice', '1000', 'g', REMERA, id)).replayed).toBe(true)
    expect(await onHand(s, 'cat-rice')).toBe('747500')
  })

  it('refuses a different request under the same operation id', async () => {
    const s = setup()
    const id = opId()
    await receive(s, 'cat-rice', '10', 'kg', REMERA, id)
    expect(await codeOf(receive(s, 'cat-rice', '11', 'kg', REMERA, id))).toBe('operation_id_reuse')
    expect(await codeOf(receive(s, 'cat-oil', '10', 'l', REMERA, id))).toBe('operation_id_reuse')
    expect(await codeOf(receive(s, 'cat-rice', '10', 'kg', CITY, id))).toBe('operation_id_reuse')
    expect(
      await codeOf(
        s.inventory.adjustStock(M, {
          clientOperationId: id,
          branchId: REMERA,
          itemId: 'cat-rice',
          amount: '10',
          unit: 'kg',
          direction: 'IN',
          reason: 'same numbers, different meaning',
        }),
      ),
    ).toBe('operation_id_reuse')
    expect(await onHand(s, 'cat-rice')).toBe('756500')
  })

  it('rejects an operation id that is not a UUID', async () => {
    const s = setup()
    expect(await codeOf(receive(s, 'cat-rice', '1', 'kg', REMERA, 'not-a-uuid'))).toBe('validation')
    expect(await codeOf(receive(s, 'cat-rice', '1', 'kg', REMERA, ''))).toBe('validation')
  })
})

describe('mock inventory: history is append-only and always adds up', () => {
  it('keeps every earlier movement untouched and each balance equal to the sum of its movements', async () => {
    const s = setup()
    const before = (await s.inventory.listMovements(M, { limit: 200 })).items
    // A deterministic pseudo-random mix of receipts and adjustments, some of which are refused.
    let seed = 20260910
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % n
    }
    const items = [
      ['cat-rice', 'g'],
      ['cat-oil', 'ml'],
      ['cat-phone', 'pc'],
      ['cat-tiles', 'mm2'],
    ] as const
    for (let step = 0; step < 60; step += 1) {
      const [itemId, unit] = items[next(items.length)]!
      const amount = String(1 + next(3000))
      try {
        if (next(2) === 0) await receive(s, itemId, amount, unit)
        else await adjustOut(s, itemId, amount, unit)
      } catch (error) {
        expect(error).toBeInstanceOf(InventoryServiceError)
      }
    }
    const after = (await s.inventory.listMovements(M, { limit: 200 })).items
    // The first rows (the oldest) are exactly what they were.
    expect(after.slice(after.length - before.length)).toEqual(before)
    for (const balance of (await s.inventory.listBalances(M, { limit: 200 })).items) {
      const own = after
        .filter((m) => m.branchId === balance.branchId && m.itemId === balance.itemId)
        .reverse()
      let running = 0n
      for (const movement of own) {
        running += BigInt(movement.quantityDelta)
        expect(movement.balanceAfter).toBe(running.toString())
        expect(running >= 0n).toBe(true)
      }
      expect(balance.quantityOnHand).toBe(running.toString())
    }
  })

  it('returns copies: changing a result never changes the stored history', async () => {
    const s = setup()
    const page = await s.inventory.listMovements(M, { limit: 1 })
    page.items[0]!.quantityDelta = '999999'
    expect((await s.inventory.listMovements(M, { limit: 1 })).items[0]!.quantityDelta).not.toBe(
      '999999',
    )
  })

  it('offers no way to edit or delete a movement or a balance', () => {
    const { inventory } = setup()
    expect(Object.keys(inventory).sort()).toEqual([
      'adjustStock',
      'getOptions',
      'listBalances',
      'listMovements',
      'receiveStock',
      'recordOpening',
    ])
  })
})
