import type { Permission } from '@/features/auth/permissions/permissionDefinitions'
import {
  EntryDeviceServiceError,
  type EntryDeviceService,
  type PublicEntryService,
} from '@/services/entryDeviceService'
import type { PublicCodeSaleService } from '@/services/codeCheckoutService'
import { OrganizationServiceError } from '@/services/organizationService'
import type {
  EligibleEntrySale,
  EntryDevice,
  EntryDeviceBinding,
  EntryDeviceStatus,
  EntryDeviceType,
  PublicEntry,
} from '@/types/entryDevices'
import { ENTRY_DEVICE_TYPES } from '@/types/entryDevices'
import { createLedgerStore } from './ledger/mockLedgerStore'
import type { MockAuthStore } from './mockAuthStore'
import { loadStoredMerchants, resolveDefaultStorage, type MerchantStorage } from './mockMerchantService'
import { createOperationRunner, requireActor, type Actor } from './mockOrganizationAccess'
import type { StoredCodeSale } from './mockCodeCheckoutService'
import { MOCK_STORAGE_KEYS } from './mockStorageKeys'

interface MockEntryDeviceOptions {
  authStore: MockAuthStore
  /** The mock customer page of a sale: the bill a device leads to is an ordinary code sale. */
  publicCodeSaleService: PublicCodeSaleService
  merchantStorage?: MerchantStorage
  delayInMilliseconds?: number
  /** Overridable in tests. */
  now?: () => number
}

interface StoredDevice {
  id: string
  merchantId: string
  deviceType: EntryDeviceType
  token: string
  displayName: string
  branchId: string
  cashierUserId: string | null
  status: EntryDeviceStatus
  statusReason: string | null
  clientRequestId: string
  createdByUserId: string
  createdAt: string
  updatedAt: string
  version: number
}

interface StoredAssignment {
  id: string
  deviceId: string
  branchId: string
  branchName: string
  cashierUserId: string | null
  cashierName: string | null
  validFrom: string
  validTo: string | null
  assignedBy: string
  reason: string | null
}

interface StoredBinding {
  id: string
  deviceId: string
  saleId: string
  saleReference: string
  agentUserId: string
  agentName: string
  boundByName: string
  boundAt: string
  endedAt: string | null
  endReason: string | null
}

interface StoredClaim {
  id: string
  deviceId: string
  bindingId: string
  saleReference: string
  /** The mock keeps the secret itself (it is a browser demo); the server stores only its hash. */
  token: string
  expiresAt: string
  endedAt: string | null
  endReason: string | null
}

const CLAIM_TTL_MS = 5 * 60 * 1000
const TERMINAL = ['PAID', 'EXPIRED', 'CANCELLED']
const BINDABLE = ['AWAITING_PAYMENT', 'PARTIALLY_PAID']

const fail = (code: ConstructorParameters<typeof EntryDeviceServiceError>[0], message: string) =>
  new EntryDeviceServiceError(code, message)

const randomToken = (bytes: number) => {
  const raw = crypto.getRandomValues(new Uint8Array(bytes))
  return btoa(String.fromCharCode(...raw))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

const UNAVAILABLE: PublicEntry = {
  state: 'UNAVAILABLE',
  message: 'This payment point is not available.',
  merchantDisplayName: null,
  sale: null,
  claim: null,
}

/**
 * DEMO ONLY: an in-browser stand-in for the server's payment-entry devices. It makes the decisions the server makes (tenant scoping,
 * `entry_devices:*` permissions, one open bill per device and per sale, a bill must fit the device's branch and cashier, a customer
 * session in progress is never cut off silently, one open claim per device, a read-only resolver, one identical answer for any
 * unusable token) over the SAME mock sales as every other screen. It proves nothing about the real server, creates no bill and
 * confirms no payment: the status of a bill is whatever the mock customer page says.
 */
export function createMockEntryDevices(options: MockEntryDeviceOptions): {
  entryDeviceService: EntryDeviceService
  publicEntryService: PublicEntryService
} {
  const { authStore: store, publicCodeSaleService } = options
  const run = createOperationRunner(options.delayInMilliseconds ?? 300)
  const now = options.now ?? (() => Date.now())
  const iso = (ms = now()) => new Date(ms).toISOString()

  const devices = () => store.loadRecords<StoredDevice>(MOCK_STORAGE_KEYS.entryDevices, [])
  const assignments = () =>
    store.loadRecords<StoredAssignment>(MOCK_STORAGE_KEYS.entryDeviceAssignments, [])
  const bindings = () => store.loadRecords<StoredBinding>(MOCK_STORAGE_KEYS.entryBindings, [])
  const claims = () => store.loadRecords<StoredClaim>(MOCK_STORAGE_KEYS.entryClaims, [])
  const sales = () => store.loadRecords<StoredCodeSale>(MOCK_STORAGE_KEYS.codeSales, [])
  const save = <T>(key: string, records: T[]) => store.saveRecords(key, records)
  const ledger = createLedgerStore(store)
  const merchantStorage = options.merchantStorage ?? resolveDefaultStorage()

  const actorFor = (merchantId: string, permission: Permission): Actor => {
    try {
      return requireActor(store, merchantId, permission)
    } catch (error) {
      if (error instanceof OrganizationServiceError) {
        const code = ['unauthenticated', 'not_found', 'forbidden'].includes(error.code)
          ? (error.code as 'unauthenticated' | 'not_found' | 'forbidden')
          : 'service_unavailable'
        throw fail(code, error.message)
      }
      throw error
    }
  }

  const myBranchIds = (actor: Actor) =>
    store
      .loadBranchAssignments()
      .filter(
        (a) =>
          a.merchantId === actor.membership.merchantId &&
          a.membershipId === actor.membership.id &&
          a.status === 'ACTIVE',
      )
      .map((a) => a.branchId)

  const nameOf = (userId: string | null) =>
    userId ? (store.loadUsers().find((u) => u.id === userId)?.fullName ?? null) : null
  const branchOf = (merchantId: string, branchId: string) =>
    store.loadBranches().find((b) => b.merchantId === merchantId && b.id === branchId)

  const visible = (actor: Actor, device: StoredDevice) => {
    if (actor.membership.role !== 'CASHIER') return true
    return (
      device.cashierUserId === actor.user.id ||
      (device.cashierUserId === null && myBranchIds(actor).includes(device.branchId))
    )
  }
  const requireManageScope = (actor: Actor, branchId: string) => {
    if (actor.membership.role === 'MANAGER' && !myBranchIds(actor).includes(branchId)) {
      throw fail('forbidden', 'You can only manage devices of branches you are assigned to.')
    }
  }
  const requireBindScope = (actor: Actor, device: StoredDevice) => {
    if (actor.membership.role === 'MANAGER') requireManageScope(actor, device.branchId)
    if (actor.membership.role === 'CASHIER') {
      const mine = device.cashierUserId === actor.user.id
      const shared = device.cashierUserId === null && myBranchIds(actor).includes(device.branchId)
      if (!mine && !shared) throw fail('forbidden', 'This device is not yours.')
    }
  }
  const requireEligibleCashier = (merchantId: string, userId: string | null, branchId: string) => {
    if (!userId) return null
    const membership = store
      .loadMemberships()
      .find((m) => m.userId === userId && m.merchantId === merchantId && m.status === 'ACTIVE')
    const assigned =
      membership &&
      store
        .loadBranchAssignments()
        .some(
          (a) =>
            a.merchantId === merchantId &&
            a.membershipId === membership.id &&
            a.branchId === branchId &&
            a.status === 'ACTIVE',
        )
    if (!membership || !assigned) {
      throw fail('cashier_not_eligible', 'The cashier must be an active member assigned to this branch.')
    }
    return nameOf(userId)
  }
  const requireUsableBranch = (merchantId: string, branchId: string) => {
    const branch = branchOf(merchantId, branchId)
    if (!branch || branch.status !== 'ACTIVE') {
      throw fail('branch_not_eligible', 'A device can only belong to an active branch of this business.')
    }
    return branch
  }

  const find = (merchantId: string, deviceId: string) =>
    devices().find((d) => d.id === deviceId && d.merchantId === merchantId)
  const mustFind = (merchantId: string, deviceId: string) => {
    const device = find(merchantId, deviceId)
    if (!device) throw fail('not_found', 'This device could not be found.')
    return device
  }
  const requireVersion = (device: StoredDevice, expected: number) => {
    if (device.version !== expected) {
      throw fail('version_conflict', 'This device was changed by someone else. Reload it and try again.')
    }
  }
  const update = (device: StoredDevice, change: Partial<StoredDevice>) => {
    const next = { ...device, ...change, version: device.version + 1, updatedAt: iso() }
    save(
      MOCK_STORAGE_KEYS.entryDevices,
      devices().map((d) => (d.id === device.id ? next : d)),
    )
    return next
  }

  const saleStatus = async (reference: string): Promise<string> => {
    try {
      return (await publicCodeSaleService.getPublicCodeSale(reference)).status
    } catch {
      return 'UNKNOWN'
    }
  }
  const openBinding = (deviceId: string) =>
    bindings().find((b) => b.deviceId === deviceId && b.endedAt === null)
  const activeClaim = (deviceId: string) =>
    claims().find(
      (c) => c.deviceId === deviceId && c.endedAt === null && new Date(c.expiresAt).getTime() > now(),
    )

  const endClaims = (deviceId: string, reason: string) => {
    save(
      MOCK_STORAGE_KEYS.entryClaims,
      claims().map((c) =>
        c.deviceId === deviceId && c.endedAt === null
          ? { ...c, endedAt: iso(), endReason: reason }
          : c,
      ),
    )
  }
  const closeBinding = (binding: StoredBinding, reason: string) => {
    endClaims(binding.deviceId, 'BINDING_ENDED')
    save(
      MOCK_STORAGE_KEYS.entryBindings,
      bindings().map((b) => (b.id === binding.id ? { ...b, endedAt: iso(), endReason: reason } : b)),
    )
  }
  const requireNoActiveSession = (binding: StoredBinding, confirmed: boolean) => {
    if (!confirmed && activeClaim(binding.deviceId)) {
      throw fail(
        'customer_session_active',
        'A customer is looking at this bill right now. Confirm to close it anyway.',
      )
    }
  }
  const openAssignment = (device: StoredDevice, branchName: string, by: string, reason: string | null) => {
    const closed = assignments().map((a) =>
      a.deviceId === device.id && a.validTo === null ? { ...a, validTo: iso() } : a,
    )
    save(MOCK_STORAGE_KEYS.entryDeviceAssignments, [
      ...closed,
      {
        id: crypto.randomUUID(),
        deviceId: device.id,
        branchId: device.branchId,
        branchName,
        cashierUserId: device.cashierUserId,
        cashierName: nameOf(device.cashierUserId),
        validFrom: iso(),
        validTo: null,
        assignedBy: by,
        reason,
      },
    ])
  }

  const toDevice = async (d: StoredDevice): Promise<EntryDevice> => {
    const binding = openBinding(d.id)
    let bindingDto: EntryDeviceBinding | null = null
    if (binding) {
      const sale = sales().find((s) => s.saleId === binding.saleId)
      const claim = activeClaim(d.id)
      bindingDto = {
        id: binding.id,
        saleId: binding.saleId,
        saleReference: binding.saleReference,
        amountRwf: sale?.amountRwf ?? 0,
        description: sale?.description ?? '',
        presentationMode: 'DEMONSTRATION',
        agentName: binding.agentName,
        boundAt: binding.boundAt,
        saleExpiresAt: iso(),
        saleStatus: await saleStatus(binding.saleReference),
        customerSessionActive: Boolean(claim),
        sessionExpiresAt: claim?.expiresAt ?? null,
      }
    }
    return {
      id: d.id,
      deviceType: d.deviceType,
      displayName: d.displayName,
      entryPath: `/e/${d.token}`,
      branchId: d.branchId,
      branchName: branchOf(d.merchantId, d.branchId)?.name ?? '',
      assignedCashierUserId: d.cashierUserId,
      assignedCashierName: nameOf(d.cashierUserId),
      status: d.status,
      statusReason: d.statusReason,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
      version: d.version,
      binding: bindingDto,
    }
  }

  const changeStatus = (
    merchantId: string,
    deviceId: string,
    input: { expectedVersion: number; reason: string },
    from: EntryDeviceStatus,
    to: EntryDeviceStatus,
    verb: string,
  ) => {
    const actor = actorFor(merchantId, 'entry_devices:manage')
    const device = mustFind(merchantId, deviceId)
    requireManageScope(actor, device.branchId)
    requireVersion(device, input.expectedVersion)
    if (device.status !== from) {
      throw fail('device_status_invalid', `A device that is ${device.status.toLowerCase()} cannot be ${verb}.`)
    }
    return update(device, { status: to, statusReason: input.reason.trim() || null })
  }

  // ---- the merchant side -------------------------------------------------------------------------

  const entryDeviceService: EntryDeviceService = {
    getOptions: (merchantId) =>
      run(() => {
        const actor = actorFor(merchantId, 'entry_devices:view')
        const mine = myBranchIds(actor)
        const branches = store
          .loadBranches()
          .filter((b) => b.merchantId === merchantId && b.status === 'ACTIVE')
          .filter((b) => actor.membership.role === 'OWNER' || mine.includes(b.id))
          .map((b) => ({ id: b.id, name: b.name, code: b.code }))
        const memberships = store
          .loadMemberships()
          .filter((m) => m.merchantId === merchantId && m.status === 'ACTIVE')
        const cashiers = memberships
          .map((m) => ({
            userId: m.userId,
            fullName: nameOf(m.userId) ?? '',
            role: m.role,
            branchIds: store
              .loadBranchAssignments()
              .filter((a) => a.membershipId === m.id && a.status === 'ACTIVE')
              .map((a) => a.branchId),
          }))
          .filter((c) => c.branchIds.length > 0)
          .filter((c) => actor.membership.role !== 'CASHIER' || c.userId === actor.user.id)
          .sort((a, b) => a.fullName.localeCompare(b.fullName))
        return { branches, cashiers }
      }),

    listDevices: (merchantId, filter) =>
      run(() => {
        const actor = actorFor(merchantId, 'entry_devices:view')
        return devices()
          .filter((d) => d.merchantId === merchantId && visible(actor, d))
          .filter((d) => !filter?.status || d.status === filter.status)
          .filter((d) => !filter?.branchId || d.branchId === filter.branchId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      }).then((rows) => Promise.all(rows.map(toDevice))),

    getDevice: (merchantId, deviceId) =>
      run(() => {
        const actor = actorFor(merchantId, 'entry_devices:view')
        const device = find(merchantId, deviceId)
        if (!device || !visible(actor, device)) throw fail('not_found', 'This device could not be found.')
        return device
      }).then(toDevice),

    registerDevice: (merchantId, input) =>
      run(() => {
        const actor = actorFor(merchantId, 'entry_devices:manage')
        if (!ENTRY_DEVICE_TYPES.includes(input.deviceType)) {
          throw fail('validation', 'Choose a static QR code, an NFC tag or an NFC bracelet.')
        }
        const name = input.displayName.trim()
        if (name.length < 1 || name.length > 60) {
          throw fail('validation', 'Give the device a name of 1 to 60 characters.')
        }
        const existing = devices().find(
          (d) => d.merchantId === merchantId && d.clientRequestId === input.clientRequestId,
        )
        if (existing) {
          if (
            existing.deviceType !== input.deviceType ||
            existing.displayName !== name ||
            existing.branchId !== input.branchId ||
            existing.cashierUserId !== input.assignedCashierUserId
          ) {
            throw fail('client_request_id_reuse', 'This request identifier was already used for a different device.')
          }
          return { id: existing.id, created: false }
        }
        const branch = requireUsableBranch(merchantId, input.branchId)
        requireManageScope(actor, input.branchId)
        requireEligibleCashier(merchantId, input.assignedCashierUserId, input.branchId)
        if (input.deviceType === 'NFC_BRACELET' && !input.assignedCashierUserId) {
          throw fail('validation', 'A bracelet is personal: choose the cashier who wears it.')
        }
        if (
          devices().some(
            (d) =>
              d.merchantId === merchantId &&
              d.status !== 'REVOKED' &&
              d.displayName.toLowerCase() === name.toLowerCase(),
          )
        ) {
          throw fail('device_name_taken', 'Another device already has this name. Names identify devices at the counter.')
        }
        const device: StoredDevice = {
          id: crypto.randomUUID(),
          merchantId,
          deviceType: input.deviceType,
          token: randomToken(16),
          displayName: name,
          branchId: input.branchId,
          cashierUserId: input.assignedCashierUserId,
          status: 'ACTIVE',
          statusReason: null,
          clientRequestId: input.clientRequestId,
          createdByUserId: actor.user.id,
          createdAt: iso(),
          updatedAt: iso(),
          version: 0,
        }
        save(MOCK_STORAGE_KEYS.entryDevices, [...devices(), device])
        openAssignment(device, branch.name, actor.user.fullName, 'Registered')
        return { id: device.id, created: true }
      }).then(async ({ id, created }) => ({
        device: await toDevice(devices().find((d) => d.id === id)!),
        replayed: !created,
      })),

    assignDevice: (merchantId, deviceId, input) =>
      run(() => {
        const actor = actorFor(merchantId, 'entry_devices:manage')
        const device = mustFind(merchantId, deviceId)
        requireManageScope(actor, device.branchId)
        requireVersion(device, input.expectedVersion)
        if (device.status === 'REVOKED') throw fail('device_revoked', 'A revoked device is final.')
        if (device.branchId === input.branchId && device.cashierUserId === input.assignedCashierUserId) {
          throw fail('no_change', 'This is already the branch and cashier of the device.')
        }
        const branch = requireUsableBranch(merchantId, input.branchId)
        requireManageScope(actor, input.branchId)
        requireEligibleCashier(merchantId, input.assignedCashierUserId, input.branchId)
        if (device.deviceType === 'NFC_BRACELET' && !input.assignedCashierUserId) {
          throw fail('validation', 'A bracelet is personal: it always keeps a cashier.')
        }
        const open = openBinding(device.id)
        if (
          open &&
          (device.branchId !== input.branchId ||
            (input.assignedCashierUserId && input.assignedCashierUserId !== open.agentUserId))
        ) {
          requireNoActiveSession(open, input.confirmActiveSession)
          closeBinding(open, 'DEVICE_REASSIGNED')
        }
        const next = update(device, {
          branchId: input.branchId,
          cashierUserId: input.assignedCashierUserId,
        })
        openAssignment(next, branch.name, actor.user.fullName, input.reason?.trim() || null)
        return next
      }).then(toDevice),

    suspendDevice: (merchantId, deviceId, input) =>
      run(() => changeStatus(merchantId, deviceId, input, 'ACTIVE', 'SUSPENDED', 'suspended')).then(toDevice),
    reactivateDevice: (merchantId, deviceId, input) =>
      run(() => changeStatus(merchantId, deviceId, input, 'SUSPENDED', 'ACTIVE', 'reactivated')).then(toDevice),

    revokeDevice: (merchantId, deviceId, input) =>
      run(() => {
        const actor = actorFor(merchantId, 'entry_devices:manage')
        const device = mustFind(merchantId, deviceId)
        requireManageScope(actor, device.branchId)
        requireVersion(device, input.expectedVersion)
        if (device.status === 'REVOKED') throw fail('device_revoked', 'This device is already revoked.')
        endClaims(device.id, 'DEVICE_REVOKED')
        const open = openBinding(device.id)
        if (open) {
          save(
            MOCK_STORAGE_KEYS.entryBindings,
            bindings().map((b) => (b.id === open.id ? { ...b, endedAt: iso(), endReason: 'DEVICE_REVOKED' } : b)),
          )
        }
        save(
          MOCK_STORAGE_KEYS.entryDeviceAssignments,
          assignments().map((a) => (a.deviceId === device.id && a.validTo === null ? { ...a, validTo: iso() } : a)),
        )
        return update(device, { status: 'REVOKED', statusReason: input.reason.trim() || null })
      }).then(toDevice),

    listAssignments: (merchantId, deviceId) =>
      run(() => {
        const actor = actorFor(merchantId, 'entry_devices:view')
        const device = find(merchantId, deviceId)
        if (!device || !visible(actor, device)) throw fail('not_found', 'This device could not be found.')
        return assignments()
          .filter((a) => a.deviceId === deviceId)
          .sort((a, b) => b.validFrom.localeCompare(a.validFrom))
          .map((a) => ({
            id: a.id,
            branchId: a.branchId,
            branchName: a.branchName,
            assignedCashierUserId: a.cashierUserId,
            assignedCashierName: a.cashierName,
            validFrom: a.validFrom,
            validTo: a.validTo,
            assignedBy: a.assignedBy,
            reason: a.reason,
          }))
      }),

    listBindings: (merchantId, deviceId) =>
      run(() => {
        const actor = actorFor(merchantId, 'entry_devices:view')
        const device = find(merchantId, deviceId)
        if (!device || !visible(actor, device)) throw fail('not_found', 'This device could not be found.')
        return bindings()
          .filter((b) => b.deviceId === deviceId)
          .sort((a, b) => b.boundAt.localeCompare(a.boundAt))
          .map((b) => ({
            id: b.id,
            saleReference: b.saleReference,
            amountRwf: sales().find((s) => s.saleId === b.saleId)?.amountRwf ?? 0,
            agentName: b.agentName,
            boundBy: b.boundByName,
            boundAt: b.boundAt,
            endedAt: b.endedAt,
            endReason: b.endReason,
          }))
      }),

    listEligibleSales: (merchantId, deviceId) =>
      run(() => {
        const actor = actorFor(merchantId, 'entry_devices:bind')
        const device = find(merchantId, deviceId)
        if (!device || !visible(actor, device)) throw fail('not_found', 'This device could not be found.')
        requireBindScope(actor, device)
        const agent =
          device.cashierUserId ?? (actor.membership.role === 'CASHIER' ? actor.user.id : null)
        return sales()
          .filter((s) => s.merchantId === merchantId && s.branchId === device.branchId)
          .filter((s) => !agent || s.agentUserId === agent)
          .filter((s) => !bindings().some((b) => b.saleId === s.saleId && b.endedAt === null))
          .sort((a, b) => b.saleId.localeCompare(a.saleId))
      }).then(async (candidates) => {
        const rows: EligibleEntrySale[] = []
        for (const s of candidates) {
          const reference = await referenceOf(s)
          const status = reference ? await saleStatus(reference) : 'UNKNOWN'
          if (reference && BINDABLE.includes(status)) {
            rows.push({
              saleId: s.saleId,
              saleReference: reference,
              amountRwf: s.amountRwf,
              description: s.description,
              presentationMode: 'DEMONSTRATION',
              agentName: s.agentName,
              expiresAt: iso(),
              createdAt: iso(),
              status,
            })
          }
        }
        return rows.slice(0, 25)
      }),

    bindSale: async (merchantId, deviceId, input) => {
      const prepared = await run(() => {
        const actor = actorFor(merchantId, 'entry_devices:bind')
        const device = find(merchantId, deviceId)
        if (!device || !visible(actor, device)) throw fail('not_found', 'This device could not be found.')
        requireBindScope(actor, device)
        requireVersion(device, input.expectedVersion)
        if (device.status !== 'ACTIVE') {
          throw fail('device_not_active', `A ${device.status.toLowerCase()} device cannot be given a bill.`)
        }
        const sale = sales().find((s) => s.saleId === input.saleId && s.merchantId === merchantId)
        if (!sale) throw fail('not_found', 'This sale could not be found.')
        if (sale.branchId !== device.branchId) {
          throw fail('sale_branch_mismatch', 'This sale belongs to another branch than the device.')
        }
        if (device.cashierUserId && device.cashierUserId !== sale.agentUserId) {
          throw fail('sale_agent_mismatch', "This device belongs to another cashier: it only leads to that cashier's sales.")
        }
        if (actor.membership.role === 'CASHIER' && actor.user.id !== sale.agentUserId) {
          throw fail('forbidden', 'A cashier can only give a device their own sales.')
        }
        return { actor, device, sale }
      })
      const { actor, device, sale } = prepared
      const reference = await referenceOf(sale)
      const status = reference ? await saleStatus(reference) : 'UNKNOWN'
      return toDevice(
        await run(() => {
          const open = openBinding(device.id)
          if (open?.saleId === sale.saleId) return find(merchantId, deviceId)!
          if (!reference || !BINDABLE.includes(status)) {
            throw fail('sale_not_bindable', `A bill that is ${status.toLowerCase().replace(/_/g, ' ')} cannot be given to a device.`)
          }
          if (open) {
            // Only a bill that has reached an end is closed by the system; any other needs an explicit unbind first.
            throw fail('device_has_open_bill', `This device still leads to bill ${open.saleReference}. Close it first.`)
          }
          if (bindings().some((b) => b.saleId === sale.saleId && b.endedAt === null)) {
            throw fail('sale_already_bound', 'This bill already leads from another device.')
          }
          save(MOCK_STORAGE_KEYS.entryBindings, [
            ...bindings(),
            {
              id: crypto.randomUUID(),
              deviceId: device.id,
              saleId: sale.saleId,
              saleReference: reference,
              agentUserId: sale.agentUserId,
              agentName: sale.agentName,
              boundByName: actor.user.fullName,
              boundAt: iso(),
              endedAt: null,
              endReason: null,
            },
          ])
          return update(device, {})
        }),
      )
    },

    unbindSale: (merchantId, deviceId, input) =>
      run(() => {
        const actor = actorFor(merchantId, 'entry_devices:bind')
        const device = find(merchantId, deviceId)
        if (!device || !visible(actor, device)) throw fail('not_found', 'This device could not be found.')
        requireBindScope(actor, device)
        const open = openBinding(device.id)
        if (!open) throw fail('no_open_bill', 'This device has no bill to close.')
        requireNoActiveSession(open, input.confirmActiveSession)
        closeBinding(open, 'UNBOUND')
        return update(device, {})
      }).then(toDevice),
  }

  /** The sale reference of a stored mock sale: it is the public reference of the sale's payment request. */
  async function referenceOf(sale: StoredCodeSale): Promise<string | null> {
    return ledger.paymentRequests.load().find((r) => r.id === sale.paymentRequestId)?.publicReference ?? null
  }

  // ---- the customer's side -----------------------------------------------------------------------

  /** The device behind a public token, whatever its status: the caller decides what a non-ACTIVE one may show. */
  const deviceByToken = (token: string) => {
    if (!/^[A-Za-z0-9_-]{22}$/.test(token)) return undefined
    return devices().find((d) => d.token === token)
  }
  const holderOf = (device: StoredDevice, claimToken?: string | null) =>
    claimToken && /^[A-Za-z0-9_-]{43}$/.test(claimToken)
      ? claims().find((c) => c.deviceId === device.id && c.token === claimToken)
      : undefined
  const merchantName = (merchantId: string) => {
    const merchant = loadStoredMerchants(merchantStorage).find((m) => m.id === merchantId)
    return merchant?.tradingName?.trim() || merchant?.legalName || 'Business'
  }

  const forHolder = async (
    claim: StoredClaim,
    issued: string | null,
    deviceStatus: EntryDeviceStatus = 'ACTIVE',
  ): Promise<PublicEntry> => {
    let sale
    try {
      sale = await publicCodeSaleService.getPublicCodeSale(claim.saleReference)
    } catch {
      return UNAVAILABLE
    }
    const active =
      deviceStatus === 'ACTIVE' && claim.endedAt === null && new Date(claim.expiresAt).getTime() > now()
    return active
      ? {
          state: 'CLAIMED',
          message: 'This is your bill. Pay it with the code shown; the bank confirms the payment, not this page.',
          merchantDisplayName: sale.merchantDisplayName,
          sale,
          claim: { active: true, expiresAt: claim.expiresAt, endReason: null, claimToken: issued },
        }
      : {
          state: 'SESSION_ENDED',
          message:
            'Your session at this payment point has ended. This is the bill you were looking at, with its current status. If you already paid, nothing is lost.',
          merchantDisplayName: sale.merchantDisplayName,
          sale,
          claim: {
            active: false,
            expiresAt: claim.expiresAt,
            endReason: claim.endReason ?? (deviceStatus === 'ACTIVE' ? 'EXPIRED' : `DEVICE_${deviceStatus}`),
            claimToken: null,
          },
        }
  }

  const forStranger = async (device: StoredDevice): Promise<PublicEntry> => {
    const binding = openBinding(device.id)
    const idle: PublicEntry = {
      state: 'IDLE',
      message: 'No bill is ready at this payment point yet. Ask the cashier to prepare it.',
      merchantDisplayName: merchantName(device.merchantId),
      sale: null,
      claim: null,
    }
    if (!binding || TERMINAL.includes(await saleStatus(binding.saleReference))) return idle
    if (activeClaim(device.id)) {
      return {
        state: 'BUSY',
        message: 'Payment in progress for another customer. Please wait a moment and scan again.',
        merchantDisplayName: null,
        sale: null,
        claim: null,
      }
    }
    return {
      state: 'READY',
      message: 'A bill is ready here. Choose "Show my bill" to see it. Opening this page does not take it.',
      merchantDisplayName: merchantName(device.merchantId),
      sale: null,
      claim: null,
    }
  }

  /** A suspended or revoked device serves nobody new; a customer who already holds a claim keeps seeing their own bill, read-only. */
  const unusable = (device: StoredDevice, claimToken?: string | null) => {
    const mine = holderOf(device, claimToken)
    return mine ? forHolder(mine, null, device.status) : structuredClone(UNAVAILABLE)
  }

  const publicEntryService: PublicEntryService = {
    resolve: async (token, claimToken) => {
      await run(() => 0)
      const device = deviceByToken(token)
      if (!device) return structuredClone(UNAVAILABLE)
      if (device.status !== 'ACTIVE') return unusable(device, claimToken)
      const mine = holderOf(device, claimToken)
      return mine ? forHolder(mine, null) : forStranger(device)
    },

    claim: async (token, claimToken) => {
      await run(() => 0)
      const device = deviceByToken(token)
      if (!device) return structuredClone(UNAVAILABLE)
      if (device.status !== 'ACTIVE') return unusable(device, claimToken)
      save(
        MOCK_STORAGE_KEYS.entryClaims,
        claims().map((c) =>
          c.deviceId === device.id && c.endedAt === null && new Date(c.expiresAt).getTime() <= now()
            ? { ...c, endedAt: iso(), endReason: 'EXPIRED' }
            : c,
        ),
      )
      const mine = holderOf(device, claimToken)
      if (mine && mine.endedAt === null) {
        const renewed = { ...mine, expiresAt: iso(now() + CLAIM_TTL_MS) }
        save(MOCK_STORAGE_KEYS.entryClaims, claims().map((c) => (c.id === mine.id ? renewed : c)))
        return forHolder(renewed, null)
      }
      const binding = openBinding(device.id)
      if (!binding || TERMINAL.includes(await saleStatus(binding.saleReference))) return forStranger(device)
      if (claims().some((c) => c.deviceId === device.id && c.endedAt === null)) return forStranger(device)
      // The browser may propose its own token (so a lost answer is recoverable); it is used only if no claim anywhere has it.
      const proposed =
        Boolean(claimToken) &&
        /^[A-Za-z0-9_-]{43}$/.test(claimToken ?? '') &&
        !claims().some((c) => c.token === claimToken)
      const secret = proposed ? (claimToken as string) : randomToken(32)
      const created: StoredClaim = {
        id: crypto.randomUUID(),
        deviceId: device.id,
        bindingId: binding.id,
        saleReference: binding.saleReference,
        token: secret,
        expiresAt: iso(now() + CLAIM_TTL_MS),
        endedAt: null,
        endReason: null,
      }
      save(MOCK_STORAGE_KEYS.entryClaims, [...claims(), created])
      return forHolder(created, proposed ? null : secret)
    },

    release: async (token, claimToken) => {
      await run(() => 0)
      const device = deviceByToken(token)
      if (!device) return structuredClone(UNAVAILABLE)
      if (device.status !== 'ACTIVE') return unusable(device, claimToken)
      const mine = holderOf(device, claimToken)
      if (mine && mine.endedAt === null) {
        save(
          MOCK_STORAGE_KEYS.entryClaims,
          claims().map((c) => (c.id === mine.id ? { ...c, endedAt: iso(), endReason: 'RELEASED' } : c)),
        )
      }
      const after = holderOf(device, claimToken)
      return after ? forHolder(after, null) : forStranger(device)
    },
  }

  return { entryDeviceService, publicEntryService }
}
