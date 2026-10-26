import { hasPermission } from '@/features/auth/permissions/permissions'
import type { Permission } from '@/features/auth/permissions/permissionDefinitions'
import {
  CATALOG_CODE_PATTERN,
  CATALOG_MAX_CODE,
  CATALOG_MAX_DESCRIPTION,
  CATALOG_MAX_NAME,
  CATALOG_MAX_PACKAGE_LABEL,
  CATALOG_MAX_PRICE_RWF,
} from '@/constants/catalog'
import {
  formatExactDecimal,
  integralDigits,
  parseExactDecimal,
  shiftDecimalPoint,
} from '@/lib/exactDecimal'
import { CatalogServiceError, type CatalogService } from '@/services/catalogService'
import { OrganizationServiceError } from '@/services/organizationService'
import type {
  CatalogItem,
  CatalogItemType,
  CatalogPackage,
  CreateCatalogPackageInput,
  MeasurementDimension,
  MeasurementUnitCode,
  MeasurementUnitOption,
} from '@/types/catalog'
import type { MockAuthStore } from './mockAuthStore'
import {
  loadStoredMerchants,
  resolveDefaultStorage,
  type MerchantStorage,
} from './mockMerchantService'
import { createOperationRunner, requireActor } from './mockOrganizationAccess'
import { newId } from './ledger/mockLedgerStore'
import {
  CANONICAL_UNIT,
  CATALOG_UNITS,
  SAMPLE_CATALOG_ITEMS,
  SAMPLE_CATALOG_PRICES,
  type StoredCatalogItem,
  type StoredCatalogPackage,
  type StoredPriceVersion,
} from './sampleCatalog'
import { MOCK_STORAGE_KEYS } from './mockStorageKeys'

interface MockCatalogServiceOptions {
  authStore: MockAuthStore
  merchantStorage?: MerchantStorage
  delayInMilliseconds?: number
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const MAX_REASON = 200
const MAX_CANONICAL_INTEGRAL_DIGITS = 14
const MAX_CANONICAL_SCALE = 6

const fail = (code: ConstructorParameters<typeof CatalogServiceError>[0], message: string) =>
  new CatalogServiceError(code, message)
const invalid = (message: string) => fail('validation', message)

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

const isUnitCode = (value: unknown): value is MeasurementUnitCode =>
  typeof value === 'string' && Object.hasOwn(CATALOG_UNITS, value)

const unitsOf = (dimension: MeasurementDimension) =>
  (Object.keys(CATALOG_UNITS) as MeasurementUnitCode[]).filter(
    (code) => CATALOG_UNITS[code].dimension === dimension,
  )

/**
 * DEMO ONLY: an in-browser stand-in for the server's catalog. It makes the decisions the server makes (BUSINESS mode only,
 * `catalog:view` / `catalog:manage`, units that belong to the item's dimension, immutable type and dimension, one code
 * per business ignoring case, optimistic versions, an immutable price version for every price or sale-unit change, exact
 * package quantities) with exact decimal arithmetic, never floating point. It proves nothing about the real server.
 */
export function createMockCatalogService(options: MockCatalogServiceOptions): CatalogService {
  const { authStore: store } = options
  const merchantStorage = options.merchantStorage ?? resolveDefaultStorage()
  const run = createOperationRunner(options.delayInMilliseconds ?? 350)

  const items = () =>
    store.loadRecords<StoredCatalogItem>(MOCK_STORAGE_KEYS.catalogItems, SAMPLE_CATALOG_ITEMS)
  const saveItems = (all: StoredCatalogItem[]) =>
    store.saveRecords(MOCK_STORAGE_KEYS.catalogItems, all)
  const prices = () =>
    store.loadRecords<StoredPriceVersion>(MOCK_STORAGE_KEYS.catalogPrices, SAMPLE_CATALOG_PRICES)
  const savePrices = (all: StoredPriceVersion[]) =>
    store.saveRecords(MOCK_STORAGE_KEYS.catalogPrices, all)

  /** Authorisation, then mode: a business that is not in BUSINESS mode has no catalog at all. */
  const authorize = (merchantId: string, permission: Permission) => {
    let actor
    try {
      actor = requireActor(store, merchantId)
    } catch (error) {
      if (error instanceof OrganizationServiceError) {
        throw fail(
          error.code === 'unauthenticated' ? 'unauthenticated' : 'not_found',
          error.message,
        )
      }
      throw error
    }
    if (!hasPermission(actor.membership.role, permission)) {
      throw fail('forbidden', 'You do not have permission to do that.')
    }
    const mode =
      loadStoredMerchants(merchantStorage).find((m) => m.id === merchantId)?.operatingMode ??
      'BUSINESS'
    if (mode !== 'BUSINESS') {
      throw fail(
        'catalog_unavailable',
        'The catalog is only available to businesses in business mode.',
      )
    }
    return actor
  }

  const findItem = (merchantId: string, itemId: string): StoredCatalogItem => {
    const item = items().find((c) => c.merchantId === merchantId && c.id === itemId)
    if (!item) throw fail('not_found', 'This catalog item could not be found.')
    return item
  }

  const toPackage = (item: StoredCatalogItem, pkg: StoredCatalogPackage): CatalogPackage => {
    const canonical = parseExactDecimal(pkg.quantityPerPackage)!
    const inSaleUnit = shiftDecimalPoint(canonical, -CATALOG_UNITS[item.saleUnit].exponent)
    return { ...pkg, quantityInSaleUnit: formatExactDecimal(inSaleUnit) }
  }

  const toItem = (item: StoredCatalogItem): CatalogItem => ({
    ...item,
    packages: item.packages.map((pkg) => toPackage(item, pkg)),
  })

  const replaceItem = (updated: StoredCatalogItem) =>
    saveItems(items().map((c) => (c.id === updated.id ? updated : c)))

  // ---- validation ---------------------------------------------------------------------------------------------

  const cleanName = (name: unknown) => {
    const trimmed = typeof name === 'string' ? name.trim() : ''
    if (!trimmed || trimmed.length > CATALOG_MAX_NAME || CONTROL_CHARACTERS.test(trimmed)) {
      throw invalid(`Enter a name of 1 to ${CATALOG_MAX_NAME} characters, on one line.`)
    }
    return trimmed
  }

  const cleanDescription = (description: unknown) => {
    if (description === undefined || description === null) return null
    const trimmed = typeof description === 'string' ? description.trim() : ''
    if (trimmed.length > CATALOG_MAX_DESCRIPTION) {
      throw invalid(`The description can be at most ${CATALOG_MAX_DESCRIPTION} characters.`)
    }
    return trimmed || null
  }

  const cleanCode = (code: unknown) => {
    if (code === undefined || code === null) return null
    const trimmed = typeof code === 'string' ? code.trim() : ''
    if (!trimmed) return null
    if (trimmed.length > CATALOG_MAX_CODE || !CATALOG_CODE_PATTERN.test(trimmed)) {
      throw invalid(
        `Use up to ${CATALOG_MAX_CODE} letters, numbers, dots, hyphens or underscores, starting with a letter or number.`,
      )
    }
    return trimmed.toUpperCase()
  }

  const cleanPrice = (price: unknown) => {
    if (
      typeof price !== 'number' ||
      !Number.isInteger(price) ||
      price < 0 ||
      price > CATALOG_MAX_PRICE_RWF
    ) {
      throw invalid(`Enter a whole price in RWF between 0 and ${CATALOG_MAX_PRICE_RWF}.`)
    }
    return price
  }

  const assertCodeIsFree = (merchantId: string, code: string | null, exceptId?: string) => {
    if (!code) return
    const taken = items().some(
      (c) => c.merchantId === merchantId && c.id !== exceptId && c.code?.toUpperCase() === code,
    )
    if (taken) {
      throw fail('duplicate_code', 'Another item in this business already uses this code.')
    }
  }

  const assertVersion = (current: number, expected: number) => {
    if (current !== expected) {
      throw fail(
        'version_conflict',
        'This record was changed by someone else. Reload it and try again.',
      )
    }
  }

  const assertSaleUnit = (dimension: MeasurementDimension, unit: unknown) => {
    if (!isUnitCode(unit) || CATALOG_UNITS[unit].dimension !== dimension) {
      throw fail(
        'invalid_unit_configuration',
        'Choose a selling unit that measures the same thing as the item.',
      )
    }
  }

  /** The exact canonical quantity of a package, or the reason it is not valid. */
  const canonicalPackageQuantity = (
    item: StoredCatalogItem,
    input: CreateCatalogPackageInput,
  ): string => {
    if (!isUnitCode(input.contentsUnit)) {
      throw fail('unsupported_unit', 'That unit is not supported.')
    }
    if (CATALOG_UNITS[input.contentsUnit].dimension !== item.measurementDimension) {
      throw fail('dimension_mismatch', 'These units measure different things.')
    }
    const amount =
      typeof input.contentsAmount === 'string' ? parseExactDecimal(input.contentsAmount) : null
    if (!amount) throw fail('invalid_quantity', 'That is not a valid quantity.')
    const badPackage = () =>
      fail('invalid_package_conversion', 'That package definition is not valid.')
    if (amount.unscaled <= 0n) throw badPackage()
    const canonical = shiftDecimalPoint(amount, CATALOG_UNITS[input.contentsUnit].exponent)
    if (
      integralDigits(canonical) > MAX_CANONICAL_INTEGRAL_DIGITS ||
      canonical.scale > MAX_CANONICAL_SCALE ||
      (item.measurementDimension === 'COUNT' && canonical.scale > 0)
    ) {
      throw badPackage()
    }
    return formatExactDecimal(canonical)
  }

  const cleanLabel = (item: StoredCatalogItem, label: unknown, exceptId?: string) => {
    const trimmed = typeof label === 'string' ? label.trim() : ''
    if (
      !trimmed ||
      trimmed.length > CATALOG_MAX_PACKAGE_LABEL ||
      CONTROL_CHARACTERS.test(trimmed)
    ) {
      throw invalid(`Enter a package label of 1 to ${CATALOG_MAX_PACKAGE_LABEL} characters.`)
    }
    const taken = item.packages.some(
      (p) => p.id !== exceptId && p.label.toLowerCase() === trimmed.toLowerCase(),
    )
    if (taken) throw fail('duplicate_label', 'This item already has a package with that name.')
    return trimmed
  }

  const requireGoods = (item: StoredCatalogItem) => {
    if (item.itemType !== 'GOODS') {
      throw fail('invalid_unit_configuration', 'Services do not have packages.')
    }
  }

  return {
    listMeasurementUnits: (merchantId) =>
      run<MeasurementUnitOption[]>(() => {
        authorize(merchantId, 'catalog:view')
        return (Object.keys(CANONICAL_UNIT) as MeasurementDimension[]).map((dimension) => ({
          dimension,
          canonicalUnit: CANONICAL_UNIT[dimension],
          wholeUnitsOnly: dimension === 'COUNT',
          units: unitsOf(dimension).map((code) => ({ code, name: CATALOG_UNITS[code].name })),
        }))
      }),

    listItems: (merchantId, query = {}) =>
      run(() => {
        authorize(merchantId, 'catalog:view')
        const term = (query.q ?? '').trim().toLowerCase()
        const matching = items()
          .filter((c) => c.merchantId === merchantId)
          .filter((c) => !query.type || c.itemType === query.type)
          .filter((c) => query.active === undefined || c.active === query.active)
          .filter(
            (c) =>
              !term ||
              c.name.toLowerCase().includes(term) ||
              (c.code ?? '').toLowerCase().includes(term),
          )
          // Newest first, with the id as a tie-breaker, exactly like the server's keyset order.
          .sort((a, b) =>
            a.createdAt === b.createdAt
              ? b.id.localeCompare(a.id)
              : b.createdAt.localeCompare(a.createdAt),
          )
        const limit = Math.min(
          query.limit && query.limit > 0 ? query.limit : DEFAULT_LIMIT,
          MAX_LIMIT,
        )
        const offset = query.cursor ? Number(query.cursor) : 0
        if (!Number.isInteger(offset) || offset < 0) {
          throw invalid('The page cursor is not valid.')
        }
        const page = matching.slice(offset, offset + limit)
        return {
          items: page.map(toItem),
          nextCursor: offset + limit < matching.length ? String(offset + limit) : null,
          totalCount: null,
        }
      }),

    getItem: (merchantId, itemId) =>
      run(() => {
        authorize(merchantId, 'catalog:view')
        return toItem(findItem(merchantId, itemId))
      }),

    createItem: (merchantId, input) =>
      run(() => {
        authorize(merchantId, 'catalog:manage')
        const itemType: CatalogItemType = input.itemType
        if (itemType !== 'GOODS' && itemType !== 'SERVICE')
          throw invalid('Choose goods or service.')
        const name = cleanName(input.name)
        const description = cleanDescription(input.description)
        const code = cleanCode(input.code)
        const price = cleanPrice(input.pricePerSaleUnitRwf)

        let dimension: MeasurementDimension = 'COUNT'
        let saleUnit: MeasurementUnitCode = 'pc'
        if (itemType === 'GOODS') {
          if (!input.measurementDimension || !input.saleUnit) {
            throw fail(
              'invalid_unit_configuration',
              'Goods need a measurement type and a selling unit.',
            )
          }
          dimension = input.measurementDimension
          if (!Object.hasOwn(CANONICAL_UNIT, dimension)) {
            throw fail('invalid_unit_configuration', 'Choose a supported measurement type.')
          }
          assertSaleUnit(dimension, input.saleUnit)
          saleUnit = input.saleUnit
        } else if (input.measurementDimension || input.saleUnit) {
          throw fail(
            'invalid_unit_configuration',
            'A service is priced per service unit and takes no measurement type or selling unit.',
          )
        }
        assertCodeIsFree(merchantId, code)

        const now = new Date().toISOString()
        const stored: StoredCatalogItem = {
          id: newId('cat'),
          merchantId,
          itemType,
          name,
          description,
          code,
          active: input.active ?? true,
          measurementDimension: dimension,
          stockUnit: itemType === 'GOODS' ? CANONICAL_UNIT[dimension] : null,
          saleUnit,
          pricePerSaleUnitRwf: price,
          priceVersion: 1,
          packages: [],
          createdAt: now,
          updatedAt: now,
          version: 0,
        }
        saveItems([...items(), stored])
        savePrices([
          ...prices(),
          {
            merchantId,
            itemId: stored.id,
            version: 1,
            pricePerSaleUnitRwf: price,
            saleUnit,
            effectiveAt: now,
            reason: null,
          },
        ])
        return toItem(stored)
      }),

    updateItem: (merchantId, itemId, input) =>
      run(() => {
        authorize(merchantId, 'catalog:manage')
        const current = findItem(merchantId, itemId)
        assertVersion(current.version, input.expectedVersion)
        const name = cleanName(input.name)
        const description = cleanDescription(input.description)
        const code = cleanCode(input.code)
        const price = cleanPrice(input.pricePerSaleUnitRwf)
        let saleUnit = current.saleUnit
        if (current.itemType === 'GOODS') {
          assertSaleUnit(current.measurementDimension, input.saleUnit)
          saleUnit = input.saleUnit as MeasurementUnitCode
        } else if (input.saleUnit && input.saleUnit !== current.saleUnit) {
          throw fail('invalid_unit_configuration', 'A service has no selling unit to change.')
        }
        const reason = (input.priceChangeReason ?? '').trim()
        if (reason.length > MAX_REASON || CONTROL_CHARACTERS.test(reason)) {
          throw invalid(`The reason can be at most ${MAX_REASON} characters, on one line.`)
        }
        assertCodeIsFree(merchantId, code, itemId)

        const now = new Date().toISOString()
        const priceChanged = price !== current.pricePerSaleUnitRwf || saleUnit !== current.saleUnit
        const updated: StoredCatalogItem = {
          ...current,
          name,
          description,
          code,
          saleUnit,
          pricePerSaleUnitRwf: price,
          priceVersion: priceChanged ? current.priceVersion + 1 : current.priceVersion,
          updatedAt: now,
          version: current.version + 1,
        }
        replaceItem(updated)
        if (priceChanged) {
          savePrices([
            ...prices(),
            {
              merchantId,
              itemId,
              version: updated.priceVersion,
              pricePerSaleUnitRwf: price,
              saleUnit,
              effectiveAt: now,
              reason: reason || null,
            },
          ])
        }
        return toItem(updated)
      }),

    changeItemStatus: (merchantId, itemId, input) =>
      run(() => {
        authorize(merchantId, 'catalog:manage')
        const current = findItem(merchantId, itemId)
        assertVersion(current.version, input.expectedVersion)
        if (current.active === input.active) return toItem(current)
        const updated = {
          ...current,
          active: input.active,
          updatedAt: new Date().toISOString(),
          version: current.version + 1,
        }
        replaceItem(updated)
        return toItem(updated)
      }),

    listPriceHistory: (merchantId, itemId) =>
      run(() => {
        authorize(merchantId, 'catalog:view')
        findItem(merchantId, itemId)
        return prices()
          .filter((p) => p.merchantId === merchantId && p.itemId === itemId)
          .sort((a, b) => b.version - a.version)
          .map(({ version, pricePerSaleUnitRwf, saleUnit, effectiveAt, reason }) => ({
            version,
            pricePerSaleUnitRwf,
            saleUnit,
            effectiveAt,
            reason,
          }))
      }),

    createPackage: (merchantId, itemId, input) =>
      run(() => {
        authorize(merchantId, 'catalog:manage')
        const item = findItem(merchantId, itemId)
        requireGoods(item)
        const label = cleanLabel(item, input.label)
        const quantity = canonicalPackageQuantity(item, input)
        const now = new Date().toISOString()
        const pkg: StoredCatalogPackage = {
          id: newId('pkg'),
          itemId,
          label,
          quantityPerPackage: quantity,
          canonicalUnit: CANONICAL_UNIT[item.measurementDimension],
          active: true,
          createdAt: now,
          updatedAt: now,
          version: 0,
        }
        replaceItem({ ...item, packages: [...item.packages, pkg] })
        return toPackage(item, pkg)
      }),

    updatePackage: (merchantId, itemId, packageId, input) =>
      run(() => {
        authorize(merchantId, 'catalog:manage')
        const item = findItem(merchantId, itemId)
        requireGoods(item)
        const current = item.packages.find((p) => p.id === packageId)
        if (!current) throw fail('not_found', 'This package could not be found.')
        assertVersion(current.version, input.expectedVersion)
        const updated: StoredCatalogPackage = {
          ...current,
          label: cleanLabel(item, input.label, packageId),
          quantityPerPackage: canonicalPackageQuantity(item, input),
          active: input.active,
          updatedAt: new Date().toISOString(),
          version: current.version + 1,
        }
        replaceItem({
          ...item,
          packages: item.packages.map((p) => (p.id === packageId ? updated : p)),
        })
        return toPackage(item, updated)
      }),
  }
}
