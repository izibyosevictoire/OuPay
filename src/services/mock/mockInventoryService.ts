import { getPermissionScope, hasPermission } from '@/features/auth/permissions/permissions'
import type { Permission } from '@/features/auth/permissions/permissionDefinitions'
import { INVENTORY_MAX_REASON, INVENTORY_MAX_REFERENCE, UUID_PATTERN } from '@/constants/inventory'
import {
  addExactDecimals,
  compareExactDecimals,
  formatExactDecimal,
  integralDigits,
  multiplyExactDecimals,
  negateExactDecimal,
  parseExactDecimal,
  shiftDecimalPoint,
  type ExactDecimal,
} from '@/lib/exactDecimal'
import { InventoryServiceError, type InventoryService } from '@/services/inventoryService'
import { OrganizationServiceError } from '@/services/organizationService'
import type { MeasurementUnitCode } from '@/types/catalog'
import type {
  InventoryBalance,
  InventoryBranchOption,
  MovementResult,
  StockMovement,
  StockMovementType,
} from '@/types/inventory'
import type { MockAuthStore } from './mockAuthStore'
import {
  loadStoredMerchants,
  resolveDefaultStorage,
  type MerchantStorage,
} from './mockMerchantService'
import { createOperationRunner, requireActor, type Actor } from './mockOrganizationAccess'
import { newId } from './ledger/mockLedgerStore'
import {
  CANONICAL_UNIT,
  CATALOG_UNITS,
  SAMPLE_CATALOG_ITEMS,
  type StoredCatalogItem,
} from './sampleCatalog'
import {
  SAMPLE_INVENTORY_BALANCES,
  SAMPLE_STOCK_MOVEMENTS,
  type StoredBalance,
  type StoredMovement,
} from './sampleInventory'
import { MOCK_STORAGE_KEYS } from './mockStorageKeys'

interface MockInventoryServiceOptions {
  authStore: MockAuthStore
  merchantStorage?: MerchantStorage
  delayInMilliseconds?: number
}

const DEFAULT_LIMIT = 50
const MAX_LIMIT = 200
const MAX_INTEGRAL_DIGITS = 14
const MAX_SCALE = 6

const fail = (code: ConstructorParameters<typeof InventoryServiceError>[0], message: string) =>
  new InventoryServiceError(code, message)
const invalid = (message: string) => fail('validation', message)

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

const isUnitCode = (value: unknown): value is MeasurementUnitCode =>
  typeof value === 'string' && Object.hasOwn(CATALOG_UNITS, value)

interface WriteInput {
  amount?: string
  unit?: MeasurementUnitCode
  packageId?: string
  packageCount?: string
  clientOperationId: string
  branchId: string
  itemId: string
  reference?: string
  reason?: string
  direction?: 'IN' | 'OUT'
}

/**
 * DEMO ONLY: an in-browser stand-in for the server's inventory. It makes the decisions the server makes: BUSINESS mode only,
 * `inventory:view` / `inventory:receive` / `inventory:adjust`, branch eligibility, goods only, exact canonical quantities
 * (14 integral and 6 fractional digits, whole pieces for COUNT) with exact decimal arithmetic and never floating point, no
 * negative stock, opening stock once and only first, append-only movements, and replay by client operation id. It proves
 * nothing about the real server.
 */
export function createMockInventoryService(options: MockInventoryServiceOptions): InventoryService {
  const { authStore: store } = options
  const merchantStorage = options.merchantStorage ?? resolveDefaultStorage()
  const run = createOperationRunner(options.delayInMilliseconds ?? 350)

  const balances = () =>
    store.loadRecords<StoredBalance>(MOCK_STORAGE_KEYS.inventoryBalances, SAMPLE_INVENTORY_BALANCES)
  const saveBalances = (all: StoredBalance[]) =>
    store.saveRecords(MOCK_STORAGE_KEYS.inventoryBalances, all)
  const movements = () =>
    store.loadRecords<StoredMovement>(MOCK_STORAGE_KEYS.inventoryMovements, SAMPLE_STOCK_MOVEMENTS)
  const saveMovements = (all: StoredMovement[]) =>
    store.saveRecords(MOCK_STORAGE_KEYS.inventoryMovements, all)
  const catalogItems = () =>
    store.loadRecords<StoredCatalogItem>(MOCK_STORAGE_KEYS.catalogItems, SAMPLE_CATALOG_ITEMS)

  const nextSeq = () =>
    Math.max(0, ...balances().map((b) => b.seq), ...movements().map((m) => m.seq)) + 1

  /** Authorisation, then mode: a business that is not in BUSINESS mode has no inventory at all. */
  const authorize = (merchantId: string, permission: Permission): Actor => {
    let actor: Actor
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
        'inventory_unavailable',
        'Inventory is only available to businesses in business mode.',
      )
    }
    return actor
  }

  const merchantBranches = (merchantId: string) =>
    store.loadBranches().filter((b) => b.merchantId === merchantId)

  /** Branches the person is actively assigned to AND that are active themselves (the server applies the same rule). */
  const assignedBranchIds = (merchantId: string, actor: Actor) => {
    const active = new Set(
      merchantBranches(merchantId)
        .filter((b) => b.status === 'ACTIVE')
        .map((b) => b.id),
    )
    return new Set(
      store
        .loadBranchAssignments()
        .filter(
          (a) =>
            a.merchantId === merchantId &&
            a.membershipId === actor.membership.id &&
            a.status === 'ACTIVE' &&
            active.has(a.branchId),
        )
        .map((a) => a.branchId),
    )
  }

  /** Owners (scope all) are eligible everywhere; anyone else only where they are assigned. */
  const mayWriteAt = (
    merchantId: string,
    actor: Actor,
    permission: Permission,
    branchId: string,
    status: 'ACTIVE' | 'INACTIVE',
  ) => {
    const scope = getPermissionScope(actor.membership.role, permission)
    if (!scope || status !== 'ACTIVE') return false
    return scope === 'all' || assignedBranchIds(merchantId, actor).has(branchId)
  }

  /** The branches the caller may view stock for. */
  const viewableBranchIds = (merchantId: string, actor: Actor): Set<string> => {
    const all = merchantBranches(merchantId)
    if (getPermissionScope(actor.membership.role, 'inventory:view') === 'all') {
      return new Set(all.map((b) => b.id))
    }
    const mine = assignedBranchIds(merchantId, actor)
    return new Set(all.filter((b) => mine.has(b.id)).map((b) => b.id))
  }

  const findItem = (merchantId: string, itemId: string): StoredCatalogItem => {
    const item = catalogItems().find((c) => c.merchantId === merchantId && c.id === itemId)
    if (!item) throw fail('not_found', 'This item could not be found.')
    return item
  }

  const toBalance = (b: StoredBalance): InventoryBalance => {
    const branch = merchantBranches(b.merchantId).find((x) => x.id === b.branchId)
    const item = findItem(b.merchantId, b.itemId)
    const onHand = parseExactDecimal(b.quantityOnHand)!
    return {
      id: b.id,
      branchId: b.branchId,
      branchName: branch?.name ?? 'Branch',
      branchCode: branch?.code ?? '',
      itemId: b.itemId,
      itemName: item.name,
      itemCode: item.code,
      measurementDimension: item.measurementDimension,
      stockUnit: CANONICAL_UNIT[item.measurementDimension],
      quantityOnHand: b.quantityOnHand,
      saleUnit: item.saleUnit,
      quantityInSaleUnit: formatExactDecimal(
        shiftDecimalPoint(onHand, -CATALOG_UNITS[item.saleUnit].exponent),
      ),
      updatedAt: b.updatedAt,
      version: b.version,
    }
  }

  const toMovement = (m: StoredMovement): StockMovement => {
    const branch = merchantBranches(m.merchantId).find((x) => x.id === m.branchId)
    const item = findItem(m.merchantId, m.itemId)
    return {
      id: m.id,
      branchId: m.branchId,
      branchName: branch?.name ?? 'Branch',
      itemId: m.itemId,
      itemName: item.name,
      movementType: m.movementType,
      quantityDelta: m.quantityDelta,
      balanceAfter: m.balanceAfter,
      stockUnit: CANONICAL_UNIT[item.measurementDimension],
      enteredAs: m.enteredAs,
      reason: m.reason,
      reference: m.reference,
      operationId: m.operationId,
      actorName: m.actorName,
      createdAt: m.createdAt,
    }
  }

  const newestFirst = <T extends { seq: number }>(rows: T[]) =>
    [...rows].sort((a, b) => b.seq - a.seq)

  const pageOf = <T>(
    rows: T[],
    limitInput: number | undefined,
    cursor: string | null | undefined,
  ) => {
    const limit = Math.min(limitInput && limitInput > 0 ? limitInput : DEFAULT_LIMIT, MAX_LIMIT)
    const offset = cursor ? Number(cursor) : 0
    if (!Number.isInteger(offset) || offset < 0) throw invalid('The page cursor is not valid.')
    return {
      items: rows.slice(offset, offset + limit),
      nextCursor: offset + limit < rows.length ? String(offset + limit) : null,
      totalCount: null,
    }
  }

  // ---- quantity ------------------------------------------------------------------------------------------------

  /** The exact canonical quantity entered, and how it was entered. Throws the reason it is not valid. */
  const resolveQuantity = (
    item: StoredCatalogItem,
    input: WriteInput,
  ): { canonical: ExactDecimal; enteredAs: string } => {
    const hasAmount = input.amount !== undefined || input.unit !== undefined
    const hasPackage = input.packageId !== undefined || input.packageCount !== undefined
    if (hasAmount === hasPackage) {
      throw invalid('Enter either a quantity and a unit, or a package and how many.')
    }
    let canonical: ExactDecimal
    let enteredAs: string
    if (hasAmount) {
      if (!isUnitCode(input.unit)) throw fail('unsupported_unit', 'That unit is not supported.')
      if (CATALOG_UNITS[input.unit].dimension !== item.measurementDimension) {
        throw fail('dimension_mismatch', 'These units measure different things.')
      }
      const amount = typeof input.amount === 'string' ? parseExactDecimal(input.amount) : null
      if (!amount) throw fail('invalid_quantity', 'That is not a valid quantity.')
      canonical = shiftDecimalPoint(amount, CATALOG_UNITS[input.unit].exponent)
      enteredAs = `${formatExactDecimal(amount)} ${input.unit}`
    } else {
      const pkg = item.packages.find((p) => p.id === input.packageId)
      if (!pkg) throw fail('not_found', 'This package could not be found.')
      if (!pkg.active) throw fail('package_inactive', 'This package is no longer in use.')
      const count =
        typeof input.packageCount === 'string' ? parseExactDecimal(input.packageCount) : null
      if (!count) throw fail('invalid_quantity', 'That is not a valid quantity.')
      canonical = multiplyExactDecimals(parseExactDecimal(pkg.quantityPerPackage)!, count)
      enteredAs = `${formatExactDecimal(count)} x ${pkg.label}`
    }
    if (canonical.unscaled <= 0n) {
      throw fail('quantity_out_of_range', 'The quantity must be greater than zero.')
    }
    if (item.measurementDimension === 'COUNT' && canonical.scale > 0) {
      throw fail('invalid_count', 'A count must be a whole number of pieces.')
    }
    if (integralDigits(canonical) > MAX_INTEGRAL_DIGITS) {
      throw fail('quantity_out_of_range', 'That quantity is too large.')
    }
    if (canonical.scale > MAX_SCALE) {
      throw fail('precision_exceeded', 'That quantity has more decimal places than can be stored.')
    }
    return { canonical, enteredAs }
  }

  const cleanText = (value: unknown, max: number, what: string) => {
    if (value === undefined || value === null) return null
    const trimmed = typeof value === 'string' ? value.trim() : ''
    if (trimmed.length > max || CONTROL_CHARACTERS.test(trimmed)) {
      throw invalid(`The ${what} can be at most ${max} characters, on one line.`)
    }
    return trimmed || null
  }

  // ---- the one write path ----------------------------------------------------------------------------------------

  const record = (
    merchantId: string,
    type: 'OPENING' | 'RECEIVE' | 'ADJUST',
    input: WriteInput,
  ): MovementResult => {
    const permission: Permission = type === 'RECEIVE' ? 'inventory:receive' : 'inventory:adjust'
    const actor = authorize(merchantId, permission)

    if (
      typeof input.clientOperationId !== 'string' ||
      !UUID_PATTERN.test(input.clientOperationId)
    ) {
      throw invalid('The operation identifier is not valid.')
    }
    const reason = cleanText(input.reason, INVENTORY_MAX_REASON, 'reason')
    const reference = cleanText(input.reference, INVENTORY_MAX_REFERENCE, 'reference')
    let movementType: StockMovementType
    if (type === 'ADJUST') {
      if (input.direction !== 'IN' && input.direction !== 'OUT') {
        throw invalid('Choose whether stock is added or removed.')
      }
      if (!reason) throw invalid('Give a reason for the adjustment.')
      movementType = input.direction === 'IN' ? 'ADJUST_IN' : 'ADJUST_OUT'
    } else {
      movementType = type
    }

    const branch = merchantBranches(merchantId).find((b) => b.id === input.branchId)
    if (!branch) throw fail('not_found', 'This branch could not be found.')
    const assigned = assignedBranchIds(merchantId, actor).has(branch.id)
    if (getPermissionScope(actor.membership.role, permission) !== 'all' && !assigned) {
      throw fail('forbidden', 'You are not assigned to that branch.')
    }
    if (!mayWriteAt(merchantId, actor, permission, branch.id, branch.status)) {
      throw fail('branch_inactive', 'That branch is not active, so stock cannot be recorded there.')
    }

    const item = findItem(merchantId, input.itemId)
    if (item.itemType !== 'GOODS') {
      throw fail('invalid_item', 'Services do not have stock.')
    }
    const { canonical, enteredAs } = resolveQuantity(item, input)
    const delta = movementType === 'ADJUST_OUT' ? negateExactDecimal(canonical) : canonical

    const fingerprint = JSON.stringify([
      movementType,
      branch.id,
      item.id,
      formatExactDecimal(delta),
      reason ?? '',
      reference ?? '',
      actor.user.id,
    ])

    const existing = movements().find(
      (m) => m.merchantId === merchantId && m.operationId === input.clientOperationId,
    )
    const currentBalance = () =>
      balances().find(
        (b) => b.merchantId === merchantId && b.branchId === branch.id && b.itemId === item.id,
      )
    if (existing) {
      if (existing.fingerprint !== fingerprint) {
        throw fail(
          'operation_id_reuse',
          'This operation identifier was already used for a different request.',
        )
      }
      return {
        movement: toMovement(existing),
        balance: toBalance(currentBalance()!),
        replayed: true,
      }
    }

    const balance = currentBalance()
    const history = movements().filter(
      (m) => m.merchantId === merchantId && m.branchId === branch.id && m.itemId === item.id,
    )
    if (movementType === 'OPENING' && history.length > 0) {
      throw fail(
        'opening_already_recorded',
        'Opening stock can only be recorded once, before any other stock movement.',
      )
    }
    const before = parseExactDecimal(balance?.quantityOnHand ?? '0')!
    const after = addExactDecimals(before, delta)
    if (compareExactDecimals(after, parseExactDecimal('0')!) < 0) {
      throw fail('insufficient_stock', 'There is not enough stock to take that quantity out.')
    }
    if (integralDigits(after) > MAX_INTEGRAL_DIGITS) {
      throw fail('quantity_out_of_range', 'That would make the stock too large to record.')
    }

    // Everything is valid: append the movement and move the balance together (the server does both in one transaction).
    const now = new Date().toISOString()
    const seq = nextSeq()
    const stored: StoredMovement = {
      id: newId('mov'),
      merchantId,
      branchId: branch.id,
      itemId: item.id,
      movementType,
      quantityDelta: formatExactDecimal(delta),
      balanceAfter: formatExactDecimal(after),
      enteredAs,
      reason,
      reference,
      operationId: input.clientOperationId,
      fingerprint,
      actorUserId: actor.user.id,
      actorName: actor.user.fullName,
      createdAt: now,
      seq,
    }
    const updated: StoredBalance = balance
      ? {
          ...balance,
          quantityOnHand: formatExactDecimal(after),
          updatedAt: now,
          version: balance.version + 1,
        }
      : {
          id: newId('bal'),
          merchantId,
          branchId: branch.id,
          itemId: item.id,
          quantityOnHand: formatExactDecimal(after),
          createdAt: now,
          updatedAt: now,
          seq: seq + 1,
          version: 0,
        }
    saveMovements([...movements(), stored])
    saveBalances(
      balance
        ? balances().map((b) => (b.id === balance.id ? updated : b))
        : [...balances(), updated],
    )
    return { movement: toMovement(stored), balance: toBalance(updated), replayed: false }
  }

  return {
    getOptions: (merchantId) =>
      run(() => {
        const actor = authorize(merchantId, 'inventory:view')
        const visible = viewableBranchIds(merchantId, actor)
        const branches: InventoryBranchOption[] = merchantBranches(merchantId)
          .filter((b) => visible.has(b.id))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((b) => ({
            id: b.id,
            name: b.name,
            code: b.code,
            status: b.status,
            writable:
              mayWriteAt(merchantId, actor, 'inventory:receive', b.id, b.status) ||
              mayWriteAt(merchantId, actor, 'inventory:adjust', b.id, b.status),
          }))
        return { branches }
      }),

    listBalances: (merchantId, query = {}) =>
      run(() => {
        const actor = authorize(merchantId, 'inventory:view')
        const visible = viewableBranchIds(merchantId, actor)
        const term = (query.q ?? '').trim().toLowerCase()
        const rows = newestFirst(
          balances().filter(
            (b) =>
              b.merchantId === merchantId &&
              visible.has(b.branchId) &&
              (!query.branchId || b.branchId === query.branchId) &&
              (!query.itemId || b.itemId === query.itemId),
          ),
        )
          .map(toBalance)
          .filter(
            (b) =>
              !term ||
              b.itemName.toLowerCase().includes(term) ||
              (b.itemCode ?? '').toLowerCase().includes(term),
          )
        return pageOf(rows, query.limit, query.cursor)
      }),

    listMovements: (merchantId, query = {}) =>
      run(() => {
        const actor = authorize(merchantId, 'inventory:view')
        const visible = viewableBranchIds(merchantId, actor)
        const rows = newestFirst(
          movements().filter(
            (m) =>
              m.merchantId === merchantId &&
              visible.has(m.branchId) &&
              (!query.branchId || m.branchId === query.branchId) &&
              (!query.itemId || m.itemId === query.itemId) &&
              (!query.type || m.movementType === query.type),
          ),
        ).map(toMovement)
        return pageOf(rows, query.limit, query.cursor)
      }),

    recordOpening: (merchantId, input) => run(() => record(merchantId, 'OPENING', input)),
    receiveStock: (merchantId, input) => run(() => record(merchantId, 'RECEIVE', input)),
    adjustStock: (merchantId, input) => run(() => record(merchantId, 'ADJUST', input)),
  }
}
