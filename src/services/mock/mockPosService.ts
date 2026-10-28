import { hasPermission } from '@/features/auth/permissions/permissions'
import {
  addExactDecimals,
  compareExactDecimals,
  formatExactDecimal,
  integralDigits,
  multiplyExactDecimals,
  parseExactDecimal,
  shiftDecimalPoint,
  type ExactDecimal,
} from '@/lib/exactDecimal'
import { OrganizationServiceError } from '@/services/organizationService'
import { PosServiceError, type PosService } from '@/services/posService'
import type { MeasurementUnitCode } from '@/types/catalog'
import type {
  PosBranchChoice,
  PosCatalogItem,
  PosDraft,
  PosDraftStatus,
  PosDraftSummary,
  PosLineInput,
  PosPricedLine,
  PosProblem,
  PosStockCheck,
  PosStockInfo,
} from '@/types/pos'
import { newId } from './ledger/mockLedgerStore'
import type { MockAuthStore } from './mockAuthStore'
import {
  loadStoredMerchants,
  resolveDefaultStorage,
  type MerchantStorage,
} from './mockMerchantService'
import { createOperationRunner, requireActor, type Actor } from './mockOrganizationAccess'
import {
  CANONICAL_UNIT,
  CATALOG_UNITS,
  SAMPLE_CATALOG_ITEMS,
  SAMPLE_CATALOG_PRICES,
  type StoredCatalogItem,
  type StoredPriceVersion,
} from './sampleCatalog'
import { SAMPLE_INVENTORY_BALANCES, type StoredBalance } from './sampleInventory'
import { MOCK_STORAGE_KEYS } from './mockStorageKeys'

interface MockPosServiceOptions {
  authStore: MockAuthStore
  merchantStorage?: MerchantStorage
  delayInMilliseconds?: number
}

const MAX_LINES = 100
const STOCK_NOTE =
  'Stock shown is informational. Nothing is reserved or deducted, and it is checked again when you bill.'
const TAX_NOTE =
  'Provisional total: tax is not calculated or included, and prices are rechecked when you bill. Tax treatment is applied only when an invoice is issued.'
const DRAFT_NOTICE =
  'A POS draft is not a sale: it is not an invoice, nothing is payable and no stock is reserved or deducted.'
/** The invoice model holds quantities in thousandths of the selling unit. */
const MAX_SALE_DECIMALS = 3
const MAX_INTEGRAL_DIGITS = 14
const MAX_CANONICAL_DECIMALS = 6

interface StoredPosDraft {
  id: string
  merchantId: string
  branchId: string
  branchName: string
  status: PosDraftStatus
  note: string | null
  lines: PosPricedLine[]
  totalRwf: number
  createdByUserId: string
  createdByName: string
  createdAt: string
  updatedAt: string
  version: number
  clientRequestId: string
  /** What the cart meant when first saved (branch, note, lines): the same id with another cart is a conflict. */
  fingerprint: string
  idempotencyKeys: { key: string; fingerprint: string }[]
}

class LineProblem extends Error {
  readonly code: string

  constructor(code: string, message: string) {
    super(message)
    this.code = code
  }
}

const invalid = (message: string) => new PosServiceError('validation', message)
const draftNotFound = () => new PosServiceError('not_found', 'This draft could not be found.')

const PLAIN_QUANTITY = /^[0-9]+(\.[0-9]+)?$/

const isUnitCode = (value: string): value is MeasurementUnitCode => value in CATALOG_UNITS

/** Half-up rounding of a non-negative ratio, exactly (BigInt): the invoice calculator's single rounding rule. */
const roundedHalfUp = (numerator: bigint, denominator: bigint) =>
  (numerator * 2n + denominator) / (denominator * 2n)

/**
 * DEMO ONLY: an in-browser stand-in for the server's business POS. It makes the decisions the server makes: BUSINESS mode only,
 * `invoices:create`, branch eligibility, prices from the catalog's CURRENT price version (the client names only the version it saw),
 * exact BigInt arithmetic with no floating point, quantities refused (never rounded) when the bill can not hold them, informational
 * stock that reserves and deducts nothing, and drafts that are not sales: no invoice, no payment request, no stock movement. It
 * proves nothing about the real server.
 */
export function createMockPosService(options: MockPosServiceOptions): PosService {
  const { authStore: store } = options
  const merchantStorage = options.merchantStorage ?? resolveDefaultStorage()
  const run = createOperationRunner(options.delayInMilliseconds ?? 300)

  const catalog = () =>
    store.loadRecords<StoredCatalogItem>(MOCK_STORAGE_KEYS.catalogItems, SAMPLE_CATALOG_ITEMS)
  const priceVersions = () =>
    store.loadRecords<StoredPriceVersion>(MOCK_STORAGE_KEYS.catalogPrices, SAMPLE_CATALOG_PRICES)
  const balances = () =>
    store.loadRecords<StoredBalance>(MOCK_STORAGE_KEYS.inventoryBalances, SAMPLE_INVENTORY_BALANCES)
  const drafts = () => store.loadRecords<StoredPosDraft>(MOCK_STORAGE_KEYS.posDrafts, [])
  const saveDrafts = (all: StoredPosDraft[]) => store.saveRecords(MOCK_STORAGE_KEYS.posDrafts, all)

  const authorize = (merchantId: string): Actor => {
    let actor: Actor
    try {
      actor = requireActor(store, merchantId)
    } catch (error) {
      if (error instanceof OrganizationServiceError) {
        throw new PosServiceError(
          error.code === 'unauthenticated' ? 'unauthenticated' : 'not_found',
          error.message,
        )
      }
      throw error
    }
    if (!hasPermission(actor.membership.role, 'invoices:create')) {
      throw new PosServiceError('forbidden', 'You do not have permission to prepare sales.')
    }
    return actor
  }

  const isBusiness = (merchantId: string) =>
    (loadStoredMerchants(merchantStorage).find((m) => m.id === merchantId)?.operatingMode ??
      'BUSINESS') === 'BUSINESS'

  const requirePos = (merchantId: string): Actor => {
    const actor = authorize(merchantId)
    if (!isBusiness(merchantId)) {
      throw new PosServiceError(
        'pos_unavailable',
        'Business POS is available to businesses in business mode.',
      )
    }
    return actor
  }

  /** Active branches this person is actively assigned to (the same policy as every checkout). */
  const eligibleBranches = (merchantId: string, actor: Actor): PosBranchChoice[] => {
    const assigned = new Set(
      store
        .loadBranchAssignments()
        .filter(
          (a) =>
            a.merchantId === merchantId &&
            a.membershipId === actor.membership.id &&
            a.status === 'ACTIVE',
        )
        .map((a) => a.branchId),
    )
    return store
      .loadBranches()
      .filter((b) => b.merchantId === merchantId && b.status === 'ACTIVE' && assigned.has(b.id))
      .map((b) => ({ id: b.id, name: b.name, code: b.code }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  const chooseBranch = (merchantId: string, actor: Actor, branchId: string): PosBranchChoice => {
    const eligible = eligibleBranches(merchantId, actor)
    if (eligible.length === 0) {
      throw new PosServiceError(
        'no_eligible_branch',
        actor.membership.role === 'CASHIER'
          ? 'You are not assigned to an active branch yet. Ask your manager to assign you to one.'
          : 'You are not assigned to an active branch. Assign yourself to one before preparing a sale.',
      )
    }
    const branch = eligible.find((b) => b.id === branchId)
    if (!branch) {
      throw new PosServiceError(
        'branch_not_eligible',
        'Choose one of the branches you are assigned to.',
      )
    }
    return branch
  }

  const stockInfo = (
    merchantId: string,
    branchId: string,
    item: StoredCatalogItem,
  ): PosStockInfo => {
    const canonicalUnit = CANONICAL_UNIT[item.measurementDimension]
    if (item.itemType !== 'GOODS') {
      return { state: 'NOT_TRACKED', onHand: null, canonicalUnit, onHandInSaleUnit: null }
    }
    const balance = balances().find(
      (b) => b.merchantId === merchantId && b.branchId === branchId && b.itemId === item.id,
    )
    if (!balance) return { state: 'NO_RECORD', onHand: '0', canonicalUnit, onHandInSaleUnit: '0' }
    const onHand = parseExactDecimal(balance.quantityOnHand) ?? { unscaled: 0n, scale: 0 }
    return {
      state: 'RECORDED',
      onHand: formatExactDecimal(onHand),
      canonicalUnit,
      onHandInSaleUnit: formatExactDecimal(
        shiftDecimalPoint(onHand, -CATALOG_UNITS[item.saleUnit].exponent),
      ),
    }
  }

  const unitsOf = (item: StoredCatalogItem) =>
    (Object.keys(CATALOG_UNITS) as MeasurementUnitCode[]).filter(
      (code) => CATALOG_UNITS[code].dimension === item.measurementDimension,
    )

  interface Resolved {
    item: StoredCatalogItem
    price: StoredPriceVersion
    canonical: ExactDecimal
    inSaleUnit: ExactDecimal
    packageLabel: string | null
    packageId: string | null
  }

  /** Prices one line, or explains why it can not be: the same decisions in the same order as the server. */
  const resolve = (merchantId: string, line: PosLineInput): Resolved => {
    const item = catalog().find((c) => c.merchantId === merchantId && c.id === line.itemId)
    if (!item) throw new LineProblem('item_not_found', 'That item could not be found.')
    if (!item.active) {
      throw new LineProblem('item_inactive', `${item.name} is inactive and can not be sold.`)
    }
    if (line.expectedPriceVersion !== item.priceVersion) {
      throw new LineProblem(
        'price_changed',
        `The price of ${item.name} changed. Review the new price before you continue.`,
      )
    }
    const price = priceVersions().find(
      (p) => p.itemId === item.id && p.merchantId === merchantId && p.version === item.priceVersion,
    )
    if (!price) throw new LineProblem('price_unavailable', 'This item has no current price.')
    const text = (line.quantity ?? '').trim()
    if (!PLAIN_QUANTITY.test(text)) {
      throw new LineProblem(
        'invalid_quantity',
        'Enter the quantity as a positive number, for example 2 or 1.5.',
      )
    }
    const entered = parseExactDecimal(text)
    if (!entered)
      throw new LineProblem('invalid_quantity', 'Enter the quantity as a positive number.')
    const hasUnit = Boolean(line.unit)
    const hasPackage = Boolean(line.packageId)
    if (hasUnit === hasPackage) {
      throw new LineProblem(
        'unit_or_package_required',
        'Choose either a unit or a package for the quantity.',
      )
    }
    let canonical: ExactDecimal
    let packageLabel: string | null = null
    let packageId: string | null = null
    if (hasPackage) {
      const pack = item.packages.find((p) => p.id === line.packageId && p.active)
      if (!pack)
        throw new LineProblem('package_not_found', 'That package is not available for this item.')
      if (entered.scale > 0)
        throw new LineProblem('invalid_package_count', 'Enter a whole number of packages.')
      const perPackage = parseExactDecimal(pack.quantityPerPackage) ?? { unscaled: 0n, scale: 0 }
      canonical = multiplyExactDecimals(entered, perPackage)
      packageLabel = pack.label
      packageId = pack.id
    } else {
      const unit = (line.unit ?? '').trim().toLowerCase()
      if (!isUnitCode(unit))
        throw new LineProblem('unsupported_unit', 'That unit is not supported.')
      if (CATALOG_UNITS[unit].dimension !== item.measurementDimension) {
        throw new LineProblem(
          'dimension_mismatch',
          `That unit does not measure ${item.name}. Choose a ${item.measurementDimension.toLowerCase()} unit.`,
        )
      }
      canonical = shiftDecimalPoint(entered, CATALOG_UNITS[unit].exponent)
    }
    if (compareExactDecimals(canonical, { unscaled: 0n, scale: 0 }) <= 0) {
      throw new LineProblem('quantity_out_of_range', 'The quantity must be more than zero.')
    }
    if (item.measurementDimension === 'COUNT' && canonical.scale > 0) {
      throw new LineProblem('invalid_count', 'Items sold by the piece must be whole numbers.')
    }
    if (canonical.scale > MAX_CANONICAL_DECIMALS) {
      throw new LineProblem('precision_exceeded', 'That quantity has too many decimal places.')
    }
    if (integralDigits(canonical) > MAX_INTEGRAL_DIGITS) {
      throw new LineProblem('quantity_out_of_range', 'That quantity is too large.')
    }
    const inSaleUnit = shiftDecimalPoint(canonical, -CATALOG_UNITS[price.saleUnit].exponent)
    if (inSaleUnit.scale > MAX_SALE_DECIMALS) {
      throw new LineProblem(
        'quantity_not_representable',
        `A bill can not hold that quantity exactly: it must be a whole number of thousandths of one ${price.saleUnit}. Choose a different quantity or unit.`,
      )
    }
    return { item, price, canonical, inSaleUnit, packageLabel, packageId }
  }

  const lineTotalOf = (inSaleUnit: ExactDecimal, unitPrice: number): number | null => {
    const milli = shiftDecimalPoint(inSaleUnit, 3).unscaled
    const total = roundedHalfUp(milli * BigInt(unitPrice), 1000n)
    return total > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(total)
  }

  const stockCheck = (
    merchantId: string,
    branchId: string,
    line: PosPricedLine,
    requested: ExactDecimal,
  ): PosStockCheck => {
    if (line.itemType !== 'GOODS') {
      return {
        state: 'NOT_TRACKED',
        onHand: null,
        requested: null,
        canonicalUnit: line.canonicalUnit,
      }
    }
    const balance = balances().find(
      (b) => b.merchantId === merchantId && b.branchId === branchId && b.itemId === line.itemId,
    )
    if (!balance) {
      return {
        state: 'NO_STOCK_RECORD',
        onHand: '0',
        requested: formatExactDecimal(requested),
        canonicalUnit: line.canonicalUnit,
      }
    }
    const onHand = parseExactDecimal(balance.quantityOnHand) ?? { unscaled: 0n, scale: 0 }
    return {
      state: compareExactDecimals(onHand, requested) >= 0 ? 'SUFFICIENT' : 'INSUFFICIENT',
      onHand: formatExactDecimal(onHand),
      requested: formatExactDecimal(requested),
      canonicalUnit: line.canonicalUnit,
    }
  }

  /** Sums the canonical quantity per goods item across lines, so two lines of one good draw on the same stock. */
  const withStock = (merchantId: string, branchId: string, lines: PosPricedLine[]) => {
    const perItem = new Map<string, ExactDecimal>()
    for (const line of lines) {
      if (line.itemType !== 'GOODS') continue
      const quantity = parseExactDecimal(line.canonicalQuantity) ?? { unscaled: 0n, scale: 0 }
      const before = perItem.get(line.itemId)
      perItem.set(line.itemId, before ? addExactDecimals(before, quantity) : quantity)
    }
    return lines.map((line) => ({
      ...line,
      stock: stockCheck(
        merchantId,
        branchId,
        line,
        perItem.get(line.itemId) ??
          parseExactDecimal(line.canonicalQuantity) ?? { unscaled: 0n, scale: 0 },
      ),
    }))
  }

  interface Priced {
    lines: PosPricedLine[]
    problems: PosProblem[]
    total: number
  }

  const price = (merchantId: string, branchId: string, inputs: PosLineInput[]): Priced => {
    if (inputs.length === 0) throw invalid('Add at least one line to the cart.')
    if (inputs.length > MAX_LINES) throw invalid(`A cart can hold at most ${MAX_LINES} lines.`)
    const lines: PosPricedLine[] = []
    const problems: PosProblem[] = []
    inputs.forEach((input, index) => {
      try {
        const r = resolve(merchantId, input)
        const total = lineTotalOf(r.inSaleUnit, r.price.pricePerSaleUnitRwf)
        if (total === null) {
          throw new LineProblem(
            'line_total_too_large',
            'That line is worth more than a bill can hold.',
          )
        }
        if (total === 0 && r.price.pricePerSaleUnitRwf > 0) {
          // A priced good must not be given away by rounding.
          throw new LineProblem(
            'line_total_zero',
            'That quantity is worth less than RWF 1 at this price. Choose a larger quantity.',
          )
        }
        lines.push({
          lineNo: lines.length + 1,
          itemId: r.item.id,
          itemType: r.item.itemType,
          name: r.item.name,
          code: r.item.code,
          measurementDimension: r.item.measurementDimension,
          enteredQuantity: input.quantity.trim(),
          enteredUnit: r.packageId
            ? null
            : (input.unit?.trim().toLowerCase() as MeasurementUnitCode),
          packageId: r.packageId,
          packageLabel: r.packageLabel,
          saleUnit: r.price.saleUnit,
          quantityInSaleUnit: formatExactDecimal(r.inSaleUnit),
          canonicalQuantity: formatExactDecimal(r.canonical),
          canonicalUnit: CANONICAL_UNIT[r.item.measurementDimension],
          priceVersion: r.price.version,
          unitPriceRwf: r.price.pricePerSaleUnitRwf,
          lineTotalRwf: total,
          stock: null,
        })
      } catch (error) {
        if (!(error instanceof LineProblem)) throw error
        const item = catalog().find((c) => c.merchantId === merchantId && c.id === input.itemId)
        problems.push({
          lineIndex: index,
          code: error.code,
          message: error.message,
          currentPriceVersion: error.code === 'price_changed' ? (item?.priceVersion ?? null) : null,
          currentPriceRwf:
            error.code === 'price_changed' ? (item?.pricePerSaleUnitRwf ?? null) : null,
        })
      }
    })
    const total = lines.reduce((sum, l) => sum + l.lineTotalRwf, 0)
    return { lines: withStock(merchantId, branchId, lines), problems, total }
  }

  const requireValid = (priced: Priced) => {
    if (priced.problems.length > 0) {
      throw new PosServiceError(
        'invalid_cart',
        priced.problems[0]?.message ?? 'The cart has a line that can not be priced.',
      )
    }
  }

  const fingerprintOf = (branchId: string, note: string | null, lines: PosLineInput[]) =>
    JSON.stringify([
      branchId,
      note,
      lines.map((l) => [
        l.itemId,
        l.quantity.trim(),
        l.unit?.trim().toLowerCase() ?? null,
        l.packageId ?? null,
        l.expectedPriceVersion,
      ]),
    ])

  const noteOf = (note: string | undefined | null) => {
    const trimmed = note?.trim() ?? ''
    if (trimmed.length > 200) throw invalid('A note can be at most 200 characters.')
    return trimmed === '' ? null : trimmed
  }

  const assignedBranchIds = (merchantId: string, actor: Actor) =>
    new Set(
      store
        .loadBranchAssignments()
        .filter(
          (a) =>
            a.merchantId === merchantId &&
            a.membershipId === actor.membership.id &&
            a.status === 'ACTIVE',
        )
        .map((a) => a.branchId),
    )

  const visibleTo = (draft: StoredPosDraft, actor: Actor) => {
    switch (actor.membership.role) {
      case 'OWNER':
        return true
      case 'MANAGER':
        return assignedBranchIds(draft.merchantId, actor).has(draft.branchId)
      default:
        return draft.createdByUserId === actor.user.id
    }
  }

  const findVisible = (merchantId: string, draftId: string, actor: Actor) => {
    const draft = drafts().find((d) => d.merchantId === merchantId && d.id === draftId)
    if (!draft || !visibleTo(draft, actor)) throw draftNotFound()
    return draft
  }

  const viewOf = (draft: StoredPosDraft): PosDraft => ({
    id: draft.id,
    merchantId: draft.merchantId,
    branchId: draft.branchId,
    branchName: draft.branchName,
    status: draft.status,
    note: draft.note,
    lines:
      draft.status === 'DRAFT'
        ? withStock(draft.merchantId, draft.branchId, draft.lines)
        : draft.lines.map((l) => ({ ...l, stock: null })),
    totalRwf: draft.totalRwf,
    currency: 'RWF',
    createdByName: draft.createdByName,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    version: draft.version,
    notice: DRAFT_NOTICE,
    stockNote: STOCK_NOTE,
    taxNote: TAX_NOTE,
  })

  const summaryOf = (draft: StoredPosDraft): PosDraftSummary => ({
    id: draft.id,
    branchId: draft.branchId,
    branchName: draft.branchName,
    status: draft.status,
    lineCount: draft.lines.length,
    totalRwf: draft.totalRwf,
    createdByName: draft.createdByName,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    version: draft.version,
  })

  const replace = (draft: StoredPosDraft) =>
    saveDrafts(drafts().map((d) => (d.id === draft.id ? draft : d)))

  return {
    getPosOptions: (merchantId) =>
      run(() => {
        const actor = authorize(merchantId)
        if (!isBusiness(merchantId)) {
          return {
            readiness: 'NOT_BUSINESS',
            branches: [],
            maxLines: MAX_LINES,
            stockNote: STOCK_NOTE,
          }
        }
        const branches = eligibleBranches(merchantId, actor)
        return {
          readiness: branches.length === 0 ? 'NO_BRANCH' : 'READY',
          branches,
          maxLines: MAX_LINES,
          stockNote: STOCK_NOTE,
        }
      }),

    searchPosItems: (merchantId, branchId, query) =>
      run(() => {
        const actor = requirePos(merchantId)
        chooseBranch(merchantId, actor, branchId)
        const text = (query ?? '').trim().toLowerCase()
        return catalog()
          .filter(
            (c) =>
              c.merchantId === merchantId &&
              c.active &&
              (text === '' ||
                c.name.toLowerCase().includes(text) ||
                (c.code ?? '').toLowerCase().includes(text)),
          )
          .sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
          .slice(0, 50)
          .map((item): PosCatalogItem => ({
            itemId: item.id,
            itemType: item.itemType,
            name: item.name,
            code: item.code,
            measurementDimension: item.measurementDimension,
            saleUnit: item.saleUnit,
            units: unitsOf(item),
            pricePerSaleUnitRwf: item.pricePerSaleUnitRwf,
            priceVersion: item.priceVersion,
            packages: item.packages
              .filter((p) => p.active)
              .map((p) => ({
                id: p.id,
                label: p.label,
                quantityPerPackage: p.quantityPerPackage,
                canonicalUnit: p.canonicalUnit,
                quantityInSaleUnit: formatExactDecimal(
                  shiftDecimalPoint(
                    parseExactDecimal(p.quantityPerPackage) ?? { unscaled: 0n, scale: 0 },
                    -CATALOG_UNITS[item.saleUnit].exponent,
                  ),
                ),
              })),
            stock: stockInfo(merchantId, branchId, item),
          }))
      }),

    quotePosCart: (merchantId, input) =>
      run(() => {
        const actor = requirePos(merchantId)
        const branch = chooseBranch(merchantId, actor, input.branchId)
        const priced = price(merchantId, branch.id, input.lines)
        return {
          branchId: branch.id,
          branchName: branch.name,
          lines: priced.lines,
          problems: priced.problems,
          totalRwf: priced.total,
          currency: 'RWF' as const,
          stockNote: STOCK_NOTE,
          taxNote: TAX_NOTE,
        }
      }),

    createPosDraft: (merchantId, input) =>
      run(() => {
        const actor = requirePos(merchantId)
        const branch = chooseBranch(merchantId, actor, input.branchId)
        const note = noteOf(input.note)
        const fingerprint = fingerprintOf(branch.id, note, input.lines)
        const sameKey = drafts().find(
          (d) =>
            d.merchantId === merchantId &&
            d.idempotencyKeys.some((k) => k.key === input.idempotencyKey),
        )
        if (sameKey) {
          const seen = sameKey.idempotencyKeys.find((k) => k.key === input.idempotencyKey)
          if (
            seen?.fingerprint !== fingerprint ||
            sameKey.clientRequestId !== input.clientRequestId
          ) {
            throw new PosServiceError(
              'idempotency_key_reuse',
              'That retry key was used for a different cart.',
            )
          }
          return viewOf(sameKey)
        }
        const existing = drafts().find(
          (d) => d.merchantId === merchantId && d.clientRequestId === input.clientRequestId,
        )
        if (existing) {
          if (existing.createdByUserId !== actor.user.id || existing.fingerprint !== fingerprint) {
            throw new PosServiceError(
              'client_request_id_reuse',
              'That cart identifier was already used for a different cart.',
            )
          }
          replace({
            ...existing,
            idempotencyKeys: [
              ...existing.idempotencyKeys,
              { key: input.idempotencyKey, fingerprint },
            ],
          })
          return viewOf(existing)
        }
        const priced = price(merchantId, branch.id, input.lines)
        requireValid(priced)
        const now = new Date().toISOString()
        const draft: StoredPosDraft = {
          id: newId('posd'),
          merchantId,
          branchId: branch.id,
          branchName: branch.name,
          status: 'DRAFT',
          note,
          lines: priced.lines.map((l) => ({ ...l, stock: null })),
          totalRwf: priced.total,
          createdByUserId: actor.user.id,
          createdByName: actor.user.fullName,
          createdAt: now,
          updatedAt: now,
          version: 0,
          clientRequestId: input.clientRequestId,
          fingerprint,
          idempotencyKeys: [{ key: input.idempotencyKey, fingerprint }],
        }
        saveDrafts([...drafts(), draft])
        return viewOf(draft)
      }),

    listPosDrafts: (merchantId) =>
      run(() => {
        const actor = requirePos(merchantId)
        const items = drafts()
          .filter((d) => d.merchantId === merchantId && visibleTo(d, actor))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
          .map(summaryOf)
        return { items, nextCursor: null }
      }),

    getPosDraft: (merchantId, draftId) =>
      run(() => {
        const actor = requirePos(merchantId)
        return viewOf(findVisible(merchantId, draftId, actor))
      }),

    updatePosDraft: (merchantId, draftId, input) =>
      run(() => {
        const actor = requirePos(merchantId)
        const draft = findVisible(merchantId, draftId, actor)
        if (draft.createdByUserId !== actor.user.id) throw draftNotFound()
        if (draft.status !== 'DRAFT') {
          throw new PosServiceError(
            'draft_not_open',
            'This draft was discarded and can not be changed.',
          )
        }
        if (draft.version !== input.expectedVersion) {
          throw new PosServiceError(
            'version_conflict',
            'This draft was changed since you opened it. Reload it and try again.',
          )
        }
        chooseBranch(merchantId, actor, draft.branchId)
        const priced = price(merchantId, draft.branchId, input.lines)
        requireValid(priced)
        const updated: StoredPosDraft = {
          ...draft,
          note: noteOf(input.note),
          lines: priced.lines.map((l) => ({ ...l, stock: null })),
          totalRwf: priced.total,
          updatedAt: new Date().toISOString(),
          version: draft.version + 1,
        }
        replace(updated)
        return viewOf(updated)
      }),

    discardPosDraft: (merchantId, draftId, expectedVersion) =>
      run(() => {
        const actor = requirePos(merchantId)
        const draft = findVisible(merchantId, draftId, actor)
        if (draft.createdByUserId !== actor.user.id) throw draftNotFound()
        if (draft.status !== 'DRAFT') {
          throw new PosServiceError('draft_not_open', 'This draft was already discarded.')
        }
        if (draft.version !== expectedVersion) {
          throw new PosServiceError(
            'version_conflict',
            'This draft was changed since you opened it. Reload it and try again.',
          )
        }
        const discarded: StoredPosDraft = {
          ...draft,
          status: 'DISCARDED',
          updatedAt: new Date().toISOString(),
          version: draft.version + 1,
        }
        replace(discarded)
        return viewOf(discarded)
      }),
  }
}
