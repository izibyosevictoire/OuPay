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
import { CodeCheckoutServiceError, type CodeCheckoutService } from '@/services/codeCheckoutService'
import { calculateLine } from '@/lib/invoiceCalculations'
import type { InvoiceItemInput } from '@/types/invoice'
import type { MockCartBilling } from './mockCodeCheckoutService'
import { PosServiceError, type PosService, type PosServiceErrorCode } from '@/services/posService'
import {
  CODE_CHECKOUT_MAX_AMOUNT_RWF,
  CODE_CHECKOUT_MIN_AMOUNT_RWF,
} from '@/constants/codeCheckout'
import type { CodeSale } from '@/types/codeCheckout'
import {
  MOCK_APPROVED_TAX_TREATMENTS,
  SAMPLE_CATALOG_TAX,
  approvedLabelsOf,
  type StoredCatalogTax,
} from './sampleCatalogTax'
import type { MeasurementUnitCode } from '@/types/catalog'
import type {
  PosAvailability,
  PosBillMode,
  PosBilledSale,
  PosBillingProblem,
  PosBillingReview,
  PosReviewLine,
  PosSaleLine,
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
  /** The mock code checkout a POS bill goes through (the same demonstration ledger as every other screen). */
  codeCheckout?: CodeCheckoutService
  /** Bills the whole cart as a multi-line invoice through that same code checkout. */
  billCart?: MockCartBilling
  merchantStorage?: MerchantStorage
  delayInMilliseconds?: number
}

const MAX_LINES = 50
const STOCK_NOTE =
  'Stock shown is informational (physical stock minus what is already reserved). Nothing is reserved for this cart and nothing is deducted. Availability is checked again when you bill.'
const DEMO_RESERVATION_NOTE =
  'DEMONSTRATION: no stock is reserved and nothing can be paid or fulfilled.'
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

/** What the mock remembers of a billed draft: the immutable snapshot, like the server's pos_sales and pos_sale_lines. */
interface StoredPosSale {
  merchantId: string
  saleId: string
  draftId: string
  createdByUserId: string
  mode: 'DEMONSTRATION'
  lines: PosSaleLine[]
  subtotalRwf: number
  taxRwf: number
  totalRwf: number
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

/**
 * DEMO ONLY: an in-browser stand-in for the server's business POS. It makes the decisions the server makes: BUSINESS mode only,
 * `invoices:create`, branch eligibility, prices from the catalog's CURRENT price version (the client names only the version it saw),
 * exact BigInt arithmetic with no floating point, quantities refused (never rounded) when the bill can not hold them, informational
 * stock that reserves and deducts nothing, and drafts that are not sales: no invoice, no payment request, no stock movement. It
 * proves nothing about the real server.
 */
export function createMockPosService(options: MockPosServiceOptions): PosService {
  const { authStore: store, codeCheckout, billCart: billCartOption } = options
  const billCart: MockCartBilling = (merchantId, input) => {
    if (!billCartOption) {
      throw new PosServiceError('service_unavailable', 'Billing is not available here.')
    }
    return billCartOption(merchantId, input)
  }
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

  /** A draft line's money: the invoice calculation itself (no tax yet, so it is the net amount). */
  const lineTotalOf = (inSaleUnit: ExactDecimal, unitPrice: number): number | null => {
    const milli = shiftDecimalPoint(inSaleUnit, 3).unscaled
    // Money that does not fit an exact integer is refused here: the calculation below works on numbers.
    if ((milli * BigInt(unitPrice)) / 1000n > BigInt(Number.MAX_SAFE_INTEGER)) return null
    return calculateLine(
      {
        description: '',
        quantity: Number(formatExactDecimal(inSaleUnit)),
        unitPrice,
        discount: 0,
        taxRate: { category: 'NOT_APPLICABLE', rateBp: 0 },
      },
      'EXCLUSIVE',
    ).lineTotal
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

  // ---- billing (R7b) ----------------------------------------------------------------------------------------------------------------

  const taxRecords = () =>
    store.loadRecords<StoredCatalogTax>(MOCK_STORAGE_KEYS.catalogTax, SAMPLE_CATALOG_TAX)
  const posSales = () => store.loadRecords<StoredPosSale>(MOCK_STORAGE_KEYS.posSales, [])

  const toPosError = (error: unknown): never => {
    if (error instanceof PosServiceError) throw error
    if (error instanceof CodeCheckoutServiceError) {
      const known: PosServiceErrorCode[] = [
        'unauthenticated',
        'not_found',
        'forbidden',
        'validation',
        'no_assigned_code',
        'code_not_assigned',
        'code_required',
        'code_not_available',
        'live_collection_unavailable',
        'no_eligible_branch',
        'branch_not_eligible',
        'client_request_id_reuse',
        'idempotency_key_reuse',
        'request_in_progress',
      ]
      const code = known.find((k) => k === error.code)
      throw new PosServiceError(code ?? 'service_unavailable', error.message)
    }
    throw error
  }

  /** The code the sale would go through, from the caller's own codes (the mock bills demonstrations only). */
  const codeFor = async (merchantId: string, codeId: string | null | undefined) => {
    if (!codeCheckout) {
      throw new PosServiceError('service_unavailable', 'Billing is not available here.')
    }
    try {
      const options = await codeCheckout.getCodeCheckoutOptions(merchantId)
      if (options.codes.length === 0) {
        return {
          problem: { code: 'no_assigned_code', message: 'You are not assigned a collection code.' },
        }
      }
      const choice = codeId
        ? options.codes.find((c) => c.id === codeId)
        : options.codes.length === 1
          ? options.codes[0]
          : undefined
      if (!choice) {
        return codeId
          ? {
              problem: {
                code: 'code_not_assigned',
                message: 'Choose one of the codes assigned to you.',
              },
            }
          : {
              problem: {
                code: 'code_required',
                message: 'Choose which of your codes you are billing through.',
              },
            }
      }
      if (choice.mode === 'UNAVAILABLE') {
        return {
          problem: {
            code: 'code_not_available',
            message: choice.reason ?? 'This code cannot be used right now.',
          },
        }
      }
      return { choice }
    } catch (error) {
      return toPosError(error)
    }
  }

  const requireCreator = (merchantId: string, draftId: string, actor: Actor) => {
    const draft = findVisible(merchantId, draftId, actor)
    if (draft.createdByUserId !== actor.user.id) throw draftNotFound()
    return draft
  }

  interface ReviewBuilt {
    draft: StoredPosDraft
    review: PosBillingReview
    lines: PosSaleLine[]
    /** The invoice lines the sale is billed with: one per cart line, with the tax treatment, exactly as reviewed. */
    invoiceLines: InvoiceItemInput[]
  }

  /** One invoice line of a priced cart line: the same description rule as the server (goods say their selling unit). */
  const invoiceLineOf = (line: PosPricedLine, configured: StoredCatalogTax): InvoiceItemInput => ({
    description: line.itemType === 'GOODS' ? `${line.name} (per ${line.saleUnit})` : line.name,
    quantity: Number(line.quantityInSaleUnit),
    unitPrice: line.unitPriceRwf,
    discount: 0,
    taxRate: { category: configured.category, rateBp: configured.rateBp },
  })

  const buildReview = (
    merchantId: string,
    actor: Actor,
    draft: StoredPosDraft,
    code: Awaited<ReturnType<typeof codeFor>>,
  ): ReviewBuilt => {
    const branch = chooseBranch(merchantId, actor, draft.branchId)
    const inputs: PosLineInput[] = draft.lines.map((l) => {
      const item = catalog().find((c) => c.merchantId === merchantId && c.id === l.itemId)
      return {
        itemId: l.itemId,
        quantity: l.enteredQuantity,
        unit: l.enteredUnit,
        packageId: l.packageId,
        expectedPriceVersion: item?.priceVersion ?? l.priceVersion,
      }
    })
    const priced = price(merchantId, branch.id, inputs)
    const problems: PosBillingProblem[] = priced.problems.map((p) => ({
      lineNo: p.lineIndex + 1,
      code: p.code,
      message: p.message,
    }))
    const failed = new Set(priced.problems.map((p) => p.lineIndex))
    const reviewLines: PosReviewLine[] = []
    const saleLines: PosSaleLine[] = []
    const invoiceLines: InvoiceItemInput[] = []
    let subtotal = 0
    let taxTotal = 0
    let total = 0
    let pricedIndex = 0
    draft.lines.forEach((was, index) => {
      if (failed.has(index)) return
      const line = priced.lines[pricedIndex++]!
      const configured = taxRecords().find(
        (t) => t.merchantId === merchantId && t.itemId === line.itemId,
      )
      const approved =
        configured !== undefined &&
        MOCK_APPROVED_TAX_TREATMENTS.some(
          (t) => t.category === configured.category && t.rateBp === configured.rateBp,
        )
      const lineNo = index + 1
      if (!configured) {
        problems.push({
          lineNo,
          code: 'tax_not_configured',
          message: `${line.name} has no tax treatment set. Set it in the catalog before billing.`,
        })
      } else if (!approved) {
        problems.push({
          lineNo,
          code: 'tax_not_approved',
          message: `${line.name} has a tax treatment that has not been approved for billing.`,
        })
      }
      if (line.unitPriceRwf <= 0) {
        problems.push({
          lineNo,
          code: 'price_zero_not_billable',
          message: `${line.name} has a price of zero, which an invoice cannot bill.`,
        })
      }
      let net = 0
      let tax = 0
      if (configured) {
        // The invoice service's own calculation prices the invoice too, so the reviewed money and the invoice's money are one.
        const calculated = calculateLine(invoiceLineOf(line, configured), 'EXCLUSIVE')
        net = calculated.netAmount
        tax = calculated.taxAmount
        subtotal += net
        taxTotal += tax
        total += net + tax
      }
      const stock = line.stock
      const availability: PosAvailability = {
        state: stock?.state ?? 'NOT_TRACKED',
        physical: stock?.onHand ?? null,
        reserved: stock ? '0' : null,
        available: stock?.onHand ?? null,
        requested: stock?.requested ?? null,
        canonicalUnit: line.canonicalUnit,
      }
      if (availability.state === 'INSUFFICIENT' || availability.state === 'NO_STOCK_RECORD') {
        if (
          !problems.some((p) => p.code === 'insufficient_stock' && p.message.includes(line.name))
        ) {
          problems.push({
            lineNo,
            code: 'insufficient_stock',
            message: `Not enough available stock of ${line.name} at this branch.`,
          })
        }
      }
      reviewLines.push({
        lineNo,
        itemId: line.itemId,
        name: line.name,
        code: line.code,
        enteredQuantity: line.enteredQuantity,
        enteredUnit: line.enteredUnit,
        packageLabel: line.packageLabel,
        saleUnit: line.saleUnit,
        quantityInSaleUnit: line.quantityInSaleUnit,
        canonicalQuantity: line.canonicalQuantity,
        canonicalUnit: line.canonicalUnit,
        priceVersion: line.priceVersion,
        unitPriceRwf: line.unitPriceRwf,
        draftPriceVersion: was.priceVersion,
        draftUnitPriceRwf: was.unitPriceRwf,
        priceChangedSinceDraft:
          was.priceVersion !== line.priceVersion || was.unitPriceRwf !== line.unitPriceRwf,
        taxCategory: configured?.category ?? null,
        taxRateBp: configured?.rateBp ?? null,
        taxApproved: approved,
        netRwf: net,
        taxRwf: tax,
        lineTotalRwf: net + tax,
        availability,
      })
      if (configured) {
        invoiceLines.push(invoiceLineOf(line, configured))
        saleLines.push({
          lineNo,
          itemId: line.itemId,
          itemType: line.itemType,
          name: line.name,
          code: line.code,
          enteredQuantity: line.enteredQuantity,
          enteredUnit: line.enteredUnit,
          packageLabel: line.packageLabel,
          saleUnit: line.saleUnit,
          quantityInSaleUnit: line.quantityInSaleUnit,
          canonicalQuantity: line.canonicalQuantity,
          canonicalUnit: line.canonicalUnit,
          priceVersion: line.priceVersion,
          unitPriceRwf: line.unitPriceRwf,
          taxCategory: configured.category,
          taxRateBp: configured.rateBp,
          netRwf: net,
          taxRwf: tax,
          lineTotalRwf: net + tax,
        })
      }
    })
    if ('problem' in code && code.problem) {
      problems.unshift({ lineNo: 0, code: code.problem.code, message: code.problem.message })
    }
    const choice = 'choice' in code ? code.choice : undefined
    const mode: PosBillMode = choice ? 'DEMONSTRATION' : 'UNAVAILABLE'
    const review: PosBillingReview = {
      draftId: draft.id,
      draftVersion: draft.version,
      branchId: branch.id,
      branchName: branch.name,
      lines: reviewLines,
      problems,
      subtotalRwf: subtotal,
      taxRwf: taxTotal,
      totalRwf: total,
      billable: problems.length === 0 && choice !== undefined,
      mode,
      codeLabel: choice?.label ?? null,
      modeNote: choice
        ? DEMO_RESERVATION_NOTE
        : ('problem' in code && code.problem?.message) || 'No code is available.',
      stockNote: STOCK_NOTE,
      taxNote: TAX_NOTE,
      approvedTaxTreatments: approvedLabelsOf(),
    }
    return { draft, review, lines: saleLines, invoiceLines }
  }

  const billedSaleOf = (stored: StoredPosSale, sale: CodeSale): PosBilledSale => ({
    sale,
    draftId: stored.draftId,
    mode: stored.mode,
    lines: stored.lines,
    subtotalRwf: stored.subtotalRwf,
    taxRwf: stored.taxRwf,
    totalRwf: stored.totalRwf,
    reservation: {
      state: 'NOT_RESERVED',
      note: DEMO_RESERVATION_NOTE,
      expiryReviewAt: null,
      releasedAt: null,
      releaseReason: null,
      lines: [],
    },
    taxNote: TAX_NOTE,
    // A demonstration has no real payment, reservation, deduction or fulfilment: it says so rather than showing a stage.
    fulfilment: {
      paymentState: 'NOT_APPLICABLE',
      appliedRwf: 0,
      totalRwf: stored.totalRwf,
      inventoryState: 'NOT_APPLICABLE',
      postedAt: null,
      attempts: 0,
      nextAttemptAt: null,
      lastError: null,
      lines: [],
      exceptions: [],
      events: [],
      handover: 'NOT_TRACKED',
      note: 'DEMONSTRATION: no real payment, stock reservation, stock deduction or fulfilment exists for this bill.',
    },
  })

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

    getBillingReview: async (merchantId, draftId, collectionCodeId) => {
      const code = await codeFor(merchantId, collectionCodeId)
      return run(() => {
        const actor = requirePos(merchantId)
        const draft = requireCreator(merchantId, draftId, actor)
        if (draft.status !== 'DRAFT') {
          throw new PosServiceError('draft_not_open', 'This draft is no longer open.')
        }
        return buildReview(merchantId, actor, draft, code).review
      })
    },

    billPosDraft: async (merchantId, draftId, input) => {
      if (!codeCheckout) {
        throw new PosServiceError('service_unavailable', 'Billing is not available here.')
      }
      const code = await codeFor(merchantId, input.collectionCodeId)
      const decision = await run(() => {
        const actor = requirePos(merchantId)
        const draft = requireCreator(merchantId, draftId, actor)
        // A repeat is answered from the draft's own sale, before anything about today is looked at.
        const existing = posSales().find(
          (s) => s.merchantId === merchantId && s.draftId === draftId,
        )
        if (existing) {
          if (existing.totalRwf !== input.reviewedTotalRwf) {
            throw new PosServiceError(
              'bill_conflict',
              'This draft was already billed, for a different total or through a different code.',
            )
          }
          return { kind: 'repeat' as const, existing }
        }
        if (draft.status !== 'DRAFT') {
          throw new PosServiceError('draft_not_open', 'This draft is no longer open.')
        }
        if (draft.version !== input.expectedDraftVersion) {
          throw new PosServiceError(
            'version_conflict',
            'This draft was changed since you opened it. Reload it and try again.',
          )
        }
        const built = buildReview(merchantId, actor, draft, code)
        const blocking =
          built.review.problems.find((p) => p.lineNo === 0) ?? built.review.problems[0]
        if (blocking) {
          const known = blocking.code as PosServiceErrorCode
          throw new PosServiceError(
            known,
            (blocking.lineNo > 0 ? `Line ${blocking.lineNo}: ` : '') + blocking.message,
          )
        }
        if (built.review.totalRwf !== input.reviewedTotalRwf) {
          throw new PosServiceError(
            'review_changed',
            `The price, tax or total changed since you reviewed it (now RWF ${built.review.totalRwf}). Review the bill again before you continue.`,
          )
        }
        if (
          built.review.totalRwf < CODE_CHECKOUT_MIN_AMOUNT_RWF ||
          built.review.totalRwf > CODE_CHECKOUT_MAX_AMOUNT_RWF
        ) {
          throw new PosServiceError(
            'amount_out_of_range',
            `A bill must be between RWF ${CODE_CHECKOUT_MIN_AMOUNT_RWF} and RWF ${CODE_CHECKOUT_MAX_AMOUNT_RWF}.`,
          )
        }
        return { kind: 'new' as const, built, actor, draft }
      })
      if (decision.kind === 'repeat') {
        const sale = await codeCheckout.getCodeSale(merchantId, decision.existing.saleId)
        return billedSaleOf(decision.existing, sale)
      }
      const { built, actor, draft } = decision
      let sale: CodeSale
      try {
        sale = await billCart(merchantId, {
          // Every cart line becomes an invoice line: the bill is NOT an amount-only invoice.
          lines: built.invoiceLines,
          amountRwf: built.review.totalRwf,
          description: `POS sale (${built.lines.length} ${built.lines.length === 1 ? 'line' : 'lines'})`,
          collectionCodeId: 'choice' in code ? code.choice?.id : undefined,
          branchId: draft.branchId,
          // The draft's own identity: the same draft can never become two sales.
          clientRequestId: draft.clientRequestId,
          idempotencyKey: input.idempotencyKey,
        })
      } catch (error) {
        return toPosError(error)
      }
      return run(() => {
        const stored: StoredPosSale = {
          merchantId,
          saleId: sale.saleId,
          draftId,
          createdByUserId: actor.user.id,
          mode: 'DEMONSTRATION',
          lines: built.lines,
          subtotalRwf: built.review.subtotalRwf,
          taxRwf: built.review.taxRwf,
          totalRwf: built.review.totalRwf,
        }
        store.saveRecords(MOCK_STORAGE_KEYS.posSales, [...posSales(), stored])
        replace({
          ...draft,
          status: 'BILLED',
          updatedAt: new Date().toISOString(),
          version: draft.version + 1,
        })
        return billedSaleOf(stored, sale)
      })
    },

    // The mock only ever bills demonstrations, which have no fulfilment: there is never an exception to show.
    listFulfilmentExceptions: (merchantId) =>
      run(() => {
        const actor = authorize(merchantId)
        if (actor.membership.role !== 'OWNER') {
          throw new PosServiceError('forbidden', 'Only an owner can see fulfilment exceptions.')
        }
        return []
      }),

    getPosSale: async (merchantId, saleId) => {
      if (!codeCheckout) {
        throw new PosServiceError('service_unavailable', 'Billing is not available here.')
      }
      const stored = await run(() => {
        const actor = requirePos(merchantId)
        const found = posSales().find((s) => s.merchantId === merchantId && s.saleId === saleId)
        if (!found || found.createdByUserId !== actor.user.id) {
          throw new PosServiceError('not_found', 'This sale could not be found.')
        }
        return found
      })
      try {
        return billedSaleOf(stored, await codeCheckout.getCodeSale(merchantId, saleId))
      } catch (error) {
        return toPosError(error)
      }
    },
  }
}
