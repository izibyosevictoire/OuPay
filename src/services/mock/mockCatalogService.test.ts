import { CatalogServiceError, type CatalogServiceErrorCode } from '@/services/catalogService'
import { createTestBackend } from '@/test/merchantTestDouble'
import { SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID } from './sampleMerchants'

const M = SAMPLE_MERCHANT_ID

function setup(
  signedInAs: Parameters<ReturnType<typeof createTestBackend>['signInAs']>[0] = 'owner',
) {
  const backend = createTestBackend()
  backend.signInAs(signedInAs)
  return { ...backend, catalog: backend.fastCatalog }
}

async function codeOf(promise: Promise<unknown>): Promise<CatalogServiceErrorCode> {
  try {
    await promise
  } catch (error) {
    if (error instanceof CatalogServiceError) return error.code
    throw error
  }
  throw new Error('expected the call to be rejected')
}

const rice = async (catalog: ReturnType<typeof setup>['catalog']) =>
  (await catalog.listItems(M, { q: 'rice' })).items[0]!

describe('mock catalog: reading', () => {
  it('lists the sample items newest first, with goods and services together', async () => {
    const { catalog } = setup()
    const page = await catalog.listItems(M)
    expect(page.items.map((i) => i.code)).toEqual([
      'CARWASH',
      'HAIRCUT',
      'PHONE-OLD',
      'PHONE',
      'TILES',
      'FABRIC',
      'CEMENT',
      'OIL',
      'RICE',
    ])
    expect(new Set(page.items.map((i) => i.itemType))).toEqual(new Set(['GOODS', 'SERVICE']))
    expect(page.nextCursor).toBeNull()
  })

  it('searches name or code case-insensitively and filters by type and status', async () => {
    const { catalog } = setup()
    expect((await catalog.listItems(M, { q: 'OIL' })).items.map((i) => i.code)).toEqual(['OIL'])
    expect((await catalog.listItems(M, { q: 'haircut' })).items).toHaveLength(1)
    expect((await catalog.listItems(M, { q: 'phone' })).items).toHaveLength(2)
    expect((await catalog.listItems(M, { type: 'SERVICE' })).items.map((i) => i.itemType)).toEqual([
      'SERVICE',
      'SERVICE',
    ])
    expect((await catalog.listItems(M, { active: false })).items.map((i) => i.code)).toEqual([
      'PHONE-OLD',
    ])
    expect(
      (await catalog.listItems(M, { type: 'GOODS', active: true, q: 'phone' })).items,
    ).toHaveLength(1)
  })

  it('pages with an opaque cursor and no gaps or repeats', async () => {
    const { catalog } = setup()
    const first = await catalog.listItems(M, { limit: 4 })
    expect(first.items).toHaveLength(4)
    expect(first.nextCursor).not.toBeNull()
    const second = await catalog.listItems(M, { limit: 4, cursor: first.nextCursor })
    const third = await catalog.listItems(M, { limit: 4, cursor: second.nextCursor })
    const ids = [...first.items, ...second.items, ...third.items].map((i) => i.id)
    expect(new Set(ids).size).toBe(9)
    expect(third.nextCursor).toBeNull()
  })

  it('lists the units by dimension, with COUNT whole-only', async () => {
    const { catalog } = setup()
    const units = await catalog.listMeasurementUnits(M)
    expect(units.map((u) => u.dimension)).toEqual(['COUNT', 'MASS', 'VOLUME', 'LENGTH', 'AREA'])
    expect(units.find((u) => u.dimension === 'MASS')).toMatchObject({
      canonicalUnit: 'g',
      wholeUnitsOnly: false,
      units: [
        { code: 'g', name: 'Gram' },
        { code: 'kg', name: 'Kilogram' },
      ],
    })
    expect(units.find((u) => u.dimension === 'COUNT')?.wholeUnitsOnly).toBe(true)
    expect(units.find((u) => u.dimension === 'AREA')?.units.map((u) => u.code)).toEqual([
      'mm2',
      'm2',
    ])
  })
})

describe('mock catalog: access', () => {
  it('keeps businesses apart: a stranger gets not found, and items never leak across businesses', async () => {
    const { catalog } = setup('owner')
    expect(await codeOf(catalog.listItems('mrc-unknown'))).toBe('not_found')
    expect((await catalog.listItems(M)).items.some((i) => i.code === 'BEANS')).toBe(false)

    const cafe = setup('cafeOwner')
    expect(await codeOf(cafe.catalog.listItems(M))).toBe('not_found')
    const beans = (await cafe.catalog.listItems(SAMPLE_SECOND_MERCHANT_ID)).items
    expect(beans.map((i) => i.code)).toEqual(['BEANS'])
    // The shop owner is only a cashier at the cafe: the cafe's item is readable there but not changeable.
    expect(
      await codeOf(
        catalog.createItem(SAMPLE_SECOND_MERCHANT_ID, {
          itemType: 'SERVICE',
          name: 'X',
          pricePerSaleUnitRwf: 1,
        }),
      ),
    ).toBe('forbidden')
    // An item id from one business is never found through another.
    expect(await codeOf(catalog.getItem(M, beans[0]!.id))).toBe('not_found')
    expect(await codeOf(cafe.catalog.getItem(SAMPLE_SECOND_MERCHANT_ID, 'cat-rice'))).toBe(
      'not_found',
    )
  })

  it('lets a cashier read but never change, and a manager manage', async () => {
    const cashier = setup('cashier')
    expect((await cashier.catalog.listItems(M)).items.length).toBeGreaterThan(0)
    const item = await rice(cashier.catalog)
    expect(
      await codeOf(
        cashier.catalog.createItem(M, { itemType: 'SERVICE', name: 'X', pricePerSaleUnitRwf: 1 }),
      ),
    ).toBe('forbidden')
    expect(
      await codeOf(
        cashier.catalog.changeItemStatus(M, item.id, {
          expectedVersion: item.version,
          active: false,
        }),
      ),
    ).toBe('forbidden')
    expect(
      await codeOf(
        cashier.catalog.createPackage(M, item.id, {
          label: 'B',
          contentsAmount: '1',
          contentsUnit: 'kg',
        }),
      ),
    ).toBe('forbidden')

    const manager = setup('manager')
    const created = await manager.catalog.createItem(M, {
      itemType: 'SERVICE',
      name: 'Repair',
      pricePerSaleUnitRwf: 2000,
    })
    expect(created.name).toBe('Repair')
  })

  it('requires a signed-in user', async () => {
    const backend = createTestBackend()
    expect(await codeOf(backend.fastCatalog.listItems(M))).toBe('unauthenticated')
  })

  it('has no catalog for a SIMPLIFIED business', async () => {
    const { catalog, fastMerchants } = setup()
    await fastMerchants.updateMerchantSettings(M, {
      operatingMode: 'SIMPLIFIED',
      expectedVersion: 0,
    })
    expect(await codeOf(catalog.listItems(M))).toBe('catalog_unavailable')
    expect(await codeOf(catalog.listMeasurementUnits(M))).toBe('catalog_unavailable')
    expect(
      await codeOf(
        catalog.createItem(M, { itemType: 'SERVICE', name: 'X', pricePerSaleUnitRwf: 1 }),
      ),
    ).toBe('catalog_unavailable')
  })
})

describe('mock catalog: creating and unit rules', () => {
  it('creates goods with a compatible selling unit, a stock unit and price version 1', async () => {
    const { catalog } = setup()
    const item = await catalog.createItem(M, {
      itemType: 'GOODS',
      name: '  Sugar ',
      code: 'sug-1',
      measurementDimension: 'MASS',
      saleUnit: 'kg',
      pricePerSaleUnitRwf: 1500,
    })
    expect(item).toMatchObject({
      name: 'Sugar',
      code: 'SUG-1',
      active: true,
      measurementDimension: 'MASS',
      stockUnit: 'g',
      saleUnit: 'kg',
      priceVersion: 1,
      version: 0,
      packages: [],
    })
    expect((await catalog.listPriceHistory(M, item.id)).map((v) => v.version)).toEqual([1])
  })

  it.each([
    ['MASS', 'g', 'g'],
    ['VOLUME', 'l', 'ml'],
    ['LENGTH', 'm', 'mm'],
    ['AREA', 'm2', 'mm2'],
    ['COUNT', 'pc', 'pc'],
  ] as const)('%s goods are sold in %s and stocked in %s', async (dimension, saleUnit, stock) => {
    const { catalog } = setup()
    const item = await catalog.createItem(M, {
      itemType: 'GOODS',
      name: `Thing ${dimension}`,
      measurementDimension: dimension,
      saleUnit,
      pricePerSaleUnitRwf: 10,
    })
    expect(item.stockUnit).toBe(stock)
  })

  it('creates a service with no stock unit, priced per service', async () => {
    const { catalog } = setup()
    const item = await catalog.createItem(M, {
      itemType: 'SERVICE',
      name: 'Consulting',
      pricePerSaleUnitRwf: 25_000,
    })
    expect(item).toMatchObject({
      itemType: 'SERVICE',
      stockUnit: null,
      measurementDimension: 'COUNT',
      saleUnit: 'pc',
      packages: [],
    })
  })

  it('rejects incompatible unit configurations', async () => {
    const { catalog } = setup()
    const goods = { itemType: 'GOODS' as const, name: 'X', pricePerSaleUnitRwf: 1 }
    expect(
      await codeOf(
        catalog.createItem(M, { ...goods, measurementDimension: 'MASS', saleUnit: 'l' }),
      ),
    ).toBe('invalid_unit_configuration')
    expect(
      await codeOf(
        catalog.createItem(M, { ...goods, measurementDimension: 'AREA', saleUnit: 'm' }),
      ),
    ).toBe('invalid_unit_configuration')
    expect(await codeOf(catalog.createItem(M, { ...goods, measurementDimension: 'MASS' }))).toBe(
      'invalid_unit_configuration',
    )
    expect(await codeOf(catalog.createItem(M, { ...goods, saleUnit: 'kg' }))).toBe(
      'invalid_unit_configuration',
    )
    expect(
      await codeOf(
        catalog.createItem(M, {
          ...goods,
          measurementDimension: 'MASS',
          saleUnit: 'stone' as never,
        }),
      ),
    ).toBe('invalid_unit_configuration')
    expect(
      await codeOf(
        catalog.createItem(M, {
          itemType: 'SERVICE',
          name: 'X',
          pricePerSaleUnitRwf: 1,
          saleUnit: 'kg',
        }),
      ),
    ).toBe('invalid_unit_configuration')
    expect(
      await codeOf(
        catalog.createItem(M, {
          itemType: 'SERVICE',
          name: 'X',
          pricePerSaleUnitRwf: 1,
          measurementDimension: 'COUNT',
        }),
      ),
    ).toBe('invalid_unit_configuration')
  })

  it('validates name, code, description and whole-RWF prices', async () => {
    const { catalog } = setup()
    const base = { itemType: 'SERVICE' as const, name: 'Ok', pricePerSaleUnitRwf: 100 }
    for (const bad of [
      { name: '' },
      { name: '   ' },
      { name: 'x'.repeat(121) },
      { name: 'two\nlines' },
      { code: 'has space' },
      { code: '-leading' },
      { code: 'x'.repeat(41) },
      { description: 'd'.repeat(501) },
      { pricePerSaleUnitRwf: 1.5 },
      { pricePerSaleUnitRwf: -1 },
      { pricePerSaleUnitRwf: 1_000_000_001 },
      { pricePerSaleUnitRwf: Number.NaN },
    ]) {
      expect(await codeOf(catalog.createItem(M, { ...base, ...bad }))).toBe('validation')
    }
    expect(
      (await catalog.createItem(M, { ...base, pricePerSaleUnitRwf: 0 })).pricePerSaleUnitRwf,
    ).toBe(0)
    expect(
      (await catalog.createItem(M, { ...base, name: 'Max', pricePerSaleUnitRwf: 1_000_000_000 }))
        .pricePerSaleUnitRwf,
    ).toBe(1_000_000_000)
  })

  it('keeps item codes unique per business, ignoring case, and lets another business reuse one', async () => {
    const { catalog } = setup()
    const base = { itemType: 'SERVICE' as const, name: 'Dup', pricePerSaleUnitRwf: 1 }
    expect(await codeOf(catalog.createItem(M, { ...base, code: 'rice' }))).toBe('duplicate_code')
    expect(await codeOf(catalog.createItem(M, { ...base, code: 'RiCe' }))).toBe('duplicate_code')
    // Items without a code never collide.
    await catalog.createItem(M, base)
    await catalog.createItem(M, { ...base, code: '' })
    const cafe = setup('cafeOwner')
    expect(
      (await cafe.catalog.createItem(SAMPLE_SECOND_MERCHANT_ID, { ...base, code: 'RICE' })).code,
    ).toBe('RICE')
  })
})

describe('mock catalog: updating, versions and price history', () => {
  it('creates an immutable price version for a price change and none for other edits', async () => {
    const { catalog } = setup()
    const item = await rice(catalog)
    expect(item).toMatchObject({ priceVersion: 2, pricePerSaleUnitRwf: 1200 })

    const renamed = await catalog.updateItem(M, item.id, {
      expectedVersion: item.version,
      name: 'Premium rice',
      saleUnit: 'kg',
      pricePerSaleUnitRwf: 1200,
    })
    expect(renamed).toMatchObject({
      name: 'Premium rice',
      priceVersion: 2,
      version: item.version + 1,
    })

    const repriced = await catalog.updateItem(M, item.id, {
      expectedVersion: renamed.version,
      name: 'Premium rice',
      saleUnit: 'kg',
      pricePerSaleUnitRwf: 1300,
      priceChangeReason: ' New harvest ',
    })
    expect(repriced.priceVersion).toBe(3)
    const history = await catalog.listPriceHistory(M, item.id)
    expect(history.map((v) => [v.version, v.pricePerSaleUnitRwf])).toEqual([
      [3, 1300],
      [2, 1200],
      [1, 1100],
    ])
    expect(history[0]).toMatchObject({ saleUnit: 'kg', reason: 'New harvest' })
    expect(history[2]?.reason).toBeNull()
    // Earlier versions are untouched by later changes.
    expect(history[1]).toMatchObject({
      pricePerSaleUnitRwf: 1200,
      reason: 'Supplier price increase',
    })
  })

  it('treats a sale-unit change as a price change and keeps the unit within the dimension', async () => {
    const { catalog } = setup()
    const item = await rice(catalog)
    const changed = await catalog.updateItem(M, item.id, {
      expectedVersion: item.version,
      name: item.name,
      saleUnit: 'g',
      pricePerSaleUnitRwf: 2,
    })
    expect(changed).toMatchObject({ saleUnit: 'g', priceVersion: 3 })
    // The bag of 25 kg now reads as 25000 g.
    expect(changed.packages[0]).toMatchObject({
      quantityPerPackage: '25000',
      quantityInSaleUnit: '25000',
    })
    expect(
      await codeOf(
        catalog.updateItem(M, item.id, {
          expectedVersion: changed.version,
          name: item.name,
          saleUnit: 'l',
          pricePerSaleUnitRwf: 2,
        }),
      ),
    ).toBe('invalid_unit_configuration')
    expect(
      await codeOf(
        catalog.updateItem(M, item.id, {
          expectedVersion: changed.version,
          name: item.name,
          pricePerSaleUnitRwf: 2,
        }),
      ),
    ).toBe('invalid_unit_configuration')
  })

  it('never changes type, dimension or stock unit', async () => {
    const { catalog } = setup()
    const item = await rice(catalog)
    const updated = await catalog.updateItem(M, item.id, {
      expectedVersion: item.version,
      name: item.name,
      saleUnit: 'kg',
      pricePerSaleUnitRwf: 1200,
      // Not part of the contract, but a hostile client may send them anyway.
      ...({ itemType: 'SERVICE', measurementDimension: 'VOLUME', stockUnit: 'ml' } as object),
    })
    expect(updated).toMatchObject({
      itemType: 'GOODS',
      measurementDimension: 'MASS',
      stockUnit: 'g',
    })
  })

  it('uses optimistic versions: a stale update is a conflict and changes nothing', async () => {
    const { catalog } = setup()
    const item = await rice(catalog)
    const input = { name: item.name, saleUnit: 'kg' as const, pricePerSaleUnitRwf: 1250 }
    await catalog.updateItem(M, item.id, { ...input, expectedVersion: item.version })
    expect(
      await codeOf(
        catalog.updateItem(M, item.id, {
          ...input,
          pricePerSaleUnitRwf: 9999,
          expectedVersion: item.version,
        }),
      ),
    ).toBe('version_conflict')
    expect((await catalog.getItem(M, item.id)).pricePerSaleUnitRwf).toBe(1250)
    expect(
      await codeOf(
        catalog.changeItemStatus(M, item.id, { expectedVersion: item.version, active: false }),
      ),
    ).toBe('version_conflict')
  })

  it('rejects a duplicate code on update but allows keeping its own', async () => {
    const { catalog } = setup()
    const item = await rice(catalog)
    const input = {
      expectedVersion: item.version,
      name: item.name,
      saleUnit: 'kg' as const,
      pricePerSaleUnitRwf: 1200,
    }
    expect(await codeOf(catalog.updateItem(M, item.id, { ...input, code: 'oil' }))).toBe(
      'duplicate_code',
    )
    expect((await catalog.updateItem(M, item.id, { ...input, code: 'rice' })).code).toBe('RICE')
  })

  it('deactivates and reactivates instead of deleting, and keeps history', async () => {
    const { catalog } = setup()
    const item = await rice(catalog)
    const off = await catalog.changeItemStatus(M, item.id, {
      expectedVersion: item.version,
      active: false,
    })
    expect(off).toMatchObject({ active: false, version: item.version + 1 })
    expect((await catalog.listItems(M, { active: true })).items.some((i) => i.id === item.id)).toBe(
      false,
    )
    expect((await catalog.listPriceHistory(M, item.id)).length).toBe(2)
    const on = await catalog.changeItemStatus(M, item.id, {
      expectedVersion: off.version,
      active: true,
    })
    expect(on.active).toBe(true)
    // No-op: asking for the state it already has changes nothing.
    expect(
      (await catalog.changeItemStatus(M, item.id, { expectedVersion: on.version, active: true }))
        .version,
    ).toBe(on.version)
    expect(Object.keys(catalog)).not.toContain('deleteItem')
  })
})

describe('mock catalog: packages', () => {
  it('stores the exact canonical quantity and shows it in the selling unit', async () => {
    const { catalog } = setup()
    const item = await rice(catalog)
    const bag = await catalog.createPackage(M, item.id, {
      label: 'Sack',
      contentsAmount: '0.75',
      contentsUnit: 'kg',
    })
    expect(bag).toMatchObject({
      label: 'Sack',
      quantityPerPackage: '750',
      canonicalUnit: 'g',
      quantityInSaleUnit: '0.75',
      active: true,
      version: 0,
    })
    const oil = (await catalog.listItems(M, { q: 'oil' })).items[0]!
    const bottle = await catalog.createPackage(M, oil.id, {
      label: 'Small bottle',
      contentsAmount: '750',
      contentsUnit: 'ml',
    })
    expect(bottle).toMatchObject({ quantityPerPackage: '750', quantityInSaleUnit: '0.75' })
    const tiles = (await catalog.listItems(M, { q: 'tiles' })).items[0]!
    expect(tiles.packages[0]).toMatchObject({
      label: 'Box',
      quantityPerPackage: '1440000',
      quantityInSaleUnit: '1.44',
    })
  })

  it('never makes a fractional piece and never rounds', async () => {
    const { catalog } = setup()
    const phone = (await catalog.listItems(M, { q: 'smartphone' })).items[0]!
    const code = (amount: string) =>
      codeOf(
        catalog.createPackage(M, phone.id, {
          label: `P${amount}`,
          contentsAmount: amount,
          contentsUnit: 'pc',
        }),
      )
    expect(await code('24.5')).toBe('invalid_package_conversion')
    expect(await code('0.5')).toBe('invalid_package_conversion')
    expect(
      (
        await catalog.createPackage(M, phone.id, {
          label: 'Carton of 24',
          contentsAmount: '24.000',
          contentsUnit: 'pc',
        })
      ).quantityPerPackage,
    ).toBe('24')
    const item = await rice(catalog)
    const grams = (amount: string) =>
      codeOf(
        catalog.createPackage(M, item.id, {
          label: `G${amount}`,
          contentsAmount: amount,
          contentsUnit: 'g',
        }),
      )
    expect(await grams('0.0000001')).toBe('invalid_package_conversion')
    expect(await grams('0')).toBe('invalid_package_conversion')
    expect(await grams('100000000000000')).toBe('invalid_package_conversion')
    // 0.0000001 kg is 0.0001 g: exact, so valid.
    const tiny = await catalog.createPackage(M, item.id, {
      label: 'Pinch',
      contentsAmount: '0.0000001',
      contentsUnit: 'kg',
    })
    expect(tiny.quantityPerPackage).toBe('0.0001')
    expect(tiny.quantityInSaleUnit).toBe('0.0000001')
  })

  it('rejects bad units, other dimensions, non-numbers, duplicate labels and services', async () => {
    const { catalog } = setup()
    const item = await rice(catalog)
    const make = (label: string, amount: string, unit: string) =>
      codeOf(
        catalog.createPackage(M, item.id, {
          label,
          contentsAmount: amount,
          contentsUnit: unit as never,
        }),
      )
    expect(await make('A', '1', 'stone')).toBe('unsupported_unit')
    expect(await make('B', '1', 'l')).toBe('dimension_mismatch')
    expect(await make('C', '1e3', 'kg')).toBe('invalid_quantity')
    expect(await make('D', 'NaN', 'kg')).toBe('invalid_quantity')
    expect(await make('bag', '5', 'kg')).toBe('duplicate_label')
    expect(await make('  ', '5', 'kg')).toBe('validation')
    const service = (await catalog.listItems(M, { type: 'SERVICE' })).items[0]!
    expect(
      await codeOf(
        catalog.createPackage(M, service.id, {
          label: 'X',
          contentsAmount: '1',
          contentsUnit: 'pc',
        }),
      ),
    ).toBe('invalid_unit_configuration')
  })

  it('updates and deactivates a package with its own version', async () => {
    const { catalog } = setup()
    const item = await rice(catalog)
    const bag = item.packages[0]!
    const edited = await catalog.updatePackage(M, item.id, bag.id, {
      expectedVersion: bag.version,
      label: 'Big bag',
      contentsAmount: '50',
      contentsUnit: 'kg',
      active: true,
    })
    expect(edited).toMatchObject({ label: 'Big bag', quantityPerPackage: '50000', version: 1 })
    expect(
      await codeOf(
        catalog.updatePackage(M, item.id, bag.id, {
          expectedVersion: 0,
          label: 'x',
          contentsAmount: '1',
          contentsUnit: 'kg',
          active: true,
        }),
      ),
    ).toBe('version_conflict')
    const off = await catalog.updatePackage(M, item.id, bag.id, {
      expectedVersion: 1,
      label: 'Big bag',
      contentsAmount: '50',
      contentsUnit: 'kg',
      active: false,
    })
    expect(off.active).toBe(false)
    expect((await catalog.getItem(M, item.id)).packages[0]?.active).toBe(false)
    expect(
      await codeOf(
        catalog.updatePackage(M, item.id, 'missing', {
          expectedVersion: 0,
          label: 'x',
          contentsAmount: '1',
          contentsUnit: 'kg',
          active: true,
        }),
      ),
    ).toBe('not_found')
  })
})
