import { hasPermission } from '@/features/auth/permissions/permissions'
import { canPerformInvoiceAction, type InvoiceAction } from '@/features/invoices/invoicePolicy'
import {
  calculateInvoice,
  countDecimals,
  MAX_QUANTITY_DECIMALS,
  quantityToMilli,
} from '@/lib/invoiceCalculations'
import { canTransitionInvoice, todayInKigali } from '@/lib/invoiceLifecycle'
import { InvoiceServiceError, type InvoiceService } from '@/services/invoiceService'
import { OrganizationServiceError } from '@/services/organizationService'
import type { Branch } from '@/types/branch'
import type {
  Invoice,
  InvoiceAssigneeOption,
  InvoiceDraftInput,
  InvoiceFormOptions,
  MerchantSnapshot,
} from '@/types/invoice'
import type { Merchant } from '@/types/merchant'
import { createMockAuthStore, type MockAuthStore } from './mockAuthStore'
import {
  loadStoredMerchants,
  resolveDefaultStorage,
  type MerchantStorage,
} from './mockMerchantService'
import { createLedgerOperations } from './ledger/ledgerOperations'
import { createLedgerStore, type LedgerStore } from './ledger/mockLedgerStore'
import { createOperationRunner, requireActor, type Actor } from './mockOrganizationAccess'

interface MockInvoiceServiceOptions {
  authStore?: MockAuthStore
  /** The shared ledger: invoice payment state is derived from it, never stored. */
  ledger?: LedgerStore
  /** Where mock merchant records live; used to freeze a merchant snapshot onto invoices. */
  merchantStorage?: MerchantStorage
  delayInMilliseconds?: number
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const MAX_ITEMS = 50
const MAX_UNIT_PRICE = 1_000_000_000
const MAX_QUANTITY = 1_000_000

const invalid = (message: string) => new InvoiceServiceError('validation', message)

/** Checks everything a DRAFT must satisfy. Issuing applies the stricter rules below. */
function validateDraftInput(input: InvoiceDraftInput) {
  const { customer } = input
  if (!customer.name?.trim()) throw invalid('Customer name is required.')
  if (customer.email && !EMAIL_PATTERN.test(customer.email))
    throw invalid('Customer email is not valid.')
  if (customer.tin && !/^\d{9}$/.test(customer.tin)) throw invalid('Customer TIN must be 9 digits.')
  if (!DATE_PATTERN.test(input.dueAt)) throw invalid('Due date is required.')
  if ((input.notes ?? '').length > 1000) throw invalid('Notes are too long.')
  if (input.items.length === 0) throw invalid('Add at least one line item.')
  if (input.items.length > MAX_ITEMS)
    throw invalid(`An invoice can have at most ${MAX_ITEMS} items.`)

  input.items.forEach((item, index) => {
    const label = `Item ${index + 1}`
    if (!item.description?.trim()) throw invalid(`${label}: description is required.`)
    const milli = quantityToMilli(item.quantity)
    if (milli < 1 || item.quantity > MAX_QUANTITY) {
      throw invalid(`${label}: quantity must be at least 0.001.`)
    }
    if (countDecimals(String(item.quantity)) > MAX_QUANTITY_DECIMALS) {
      throw invalid(`${label}: quantity allows up to ${MAX_QUANTITY_DECIMALS} decimal places.`)
    }
    if (
      !Number.isInteger(item.unitPrice) ||
      item.unitPrice < 0 ||
      item.unitPrice > MAX_UNIT_PRICE
    ) {
      throw invalid(`${label}: unit price must be a whole amount of francs.`)
    }
    if (!Number.isInteger(item.discount) || item.discount < 0)
      throw invalid(`${label}: discount must be a whole amount.`)
    if (
      !Number.isInteger(item.taxRate.rateBp) ||
      item.taxRate.rateBp < 0 ||
      item.taxRate.rateBp > 10_000
    ) {
      throw invalid(`${label}: tax rate must be between 0% and 100%.`)
    }
  })

  const { discountTotal, subtotal } = calculateInvoice(input.items, input.taxMode)
  const requestedDiscount = input.items.reduce((sum, item) => sum + item.discount, 0)
  if (requestedDiscount > subtotal || requestedDiscount !== discountTotal) {
    throw invalid('A discount cannot be larger than its line amount.')
  }
}

/** The stricter rules an invoice must meet to be ISSUED. */
function validateForIssue(invoice: Invoice) {
  if (!invoice.customer.name.trim()) throw invalid('Customer name is required to issue an invoice.')
  invoice.items.forEach((item, index) => {
    if (!item.description.trim() || !(item.quantity > 0) || item.unitPrice <= 0) {
      throw invalid(`Item ${index + 1} needs a description, a quantity and a price above zero.`)
    }
  })
  if (invoice.grandTotal <= 0) throw invalid('An issued invoice must have a total above zero.')
  if (invoice.dueAt < todayInKigali()) throw invalid('The due date cannot be in the past.')
}

const merchantAddress = (merchant: Merchant) =>
  [
    merchant.location.physicalAddress,
    merchant.location.sector,
    merchant.location.district,
    merchant.location.province,
  ]
    .filter(Boolean)
    .join(', ')

export function createMockInvoiceService(options: MockInvoiceServiceOptions = {}): InvoiceService {
  const store = options.authStore ?? createMockAuthStore()
  const merchantStorage = options.merchantStorage ?? resolveDefaultStorage()
  const ledger = options.ledger ?? createLedgerStore(store)
  const ops = createLedgerOperations(store, ledger)
  const run = createOperationRunner(options.delayInMilliseconds ?? 450)
  /** Payment status and balance come only from bank-confirmed allocations. */
  const decorate = (invoice: Invoice) => ops.decorate(invoice)

  /** Resolves the signed-in member of the merchant, re-throwing as an invoice error. */
  const actorFor = (merchantId: string): Actor => {
    try {
      return requireActor(store, merchantId)
    } catch (error) {
      if (error instanceof OrganizationServiceError) {
        const code = error.code === 'unauthenticated' ? 'unauthenticated' : 'not_found'
        throw new InvoiceServiceError(code, error.message)
      }
      throw error
    }
  }

  const requireCreatePermission = (actor: Actor) => {
    if (!hasPermission(actor.membership.role, 'invoices:create')) {
      throw new InvoiceServiceError('forbidden', 'You do not have permission to create invoices.')
    }
  }

  /** A cashier only ever sees invoices assigned to them; everything else looks like it does not exist. */
  const findVisibleInvoice = (actor: Actor, merchantId: string, invoiceId: string): Invoice => {
    const invoice = store
      .loadInvoices()
      .find((candidate) => candidate.id === invoiceId && candidate.merchantId === merchantId)
    if (
      !invoice ||
      !canPerformInvoiceAction(actor.membership.role, actor.user.id, invoice, 'view')
    ) {
      throw new InvoiceServiceError('not_found', 'This invoice could not be found.')
    }
    return invoice
  }

  const requireAction = (
    actor: Actor,
    invoice: Invoice,
    action: InvoiceAction,
    message: string,
  ) => {
    if (!canPerformInvoiceAction(actor.membership.role, actor.user.id, invoice, action)) {
      throw new InvoiceServiceError('forbidden', message)
    }
  }

  const assertVersion = (invoice: Invoice, expectedVersion: number) => {
    if (invoice.version !== expectedVersion) {
      throw new InvoiceServiceError(
        'version_conflict',
        'This invoice was changed by someone else. Reload it and try again.',
      )
    }
  }

  const saveInvoice = (updated: Invoice) =>
    store.saveInvoices(
      store.loadInvoices().map((invoice) => (invoice.id === updated.id ? updated : invoice)),
    )

  const activeBranch = (merchantId: string, branchId: string): Branch => {
    const branch = store
      .loadBranches()
      .find((b) => b.id === branchId && b.merchantId === merchantId)
    if (!branch) throw new InvoiceServiceError('validation', 'Choose a branch of this business.')
    if (branch.status !== 'ACTIVE') {
      throw new InvoiceServiceError(
        'branch_inactive',
        `${branch.name} is inactive and cannot be used for new invoices.`,
      )
    }
    return branch
  }

  /** The assignee must be an ACTIVE member with an ACTIVE assignment to this branch, right now. */
  const assertAssigneeEligible = (merchantId: string, branch: Branch, assigneeUserId: string) => {
    const user = store.loadUsers().find((u) => u.id === assigneeUserId)
    const membership = store
      .loadMemberships()
      .find(
        (m) => m.userId === assigneeUserId && m.merchantId === merchantId && m.status === 'ACTIVE',
      )
    const isAssigned = store
      .loadBranchAssignments()
      .some(
        (a) =>
          a.merchantId === merchantId &&
          a.branchId === branch.id &&
          a.membershipId === membership?.id &&
          a.status === 'ACTIVE',
      )
    if (!user || user.status !== 'ACTIVE' || !membership || !isAssigned) {
      throw new InvoiceServiceError(
        'assignee_not_eligible',
        `That person is not an active member assigned to ${branch.name}.`,
      )
    }
    return user
  }

  const snapshots = (
    merchantId: string,
    branch: Branch,
  ): { merchantSnapshot: MerchantSnapshot; branchSnapshot: Invoice['branchSnapshot'] } => {
    const merchant = loadStoredMerchants(merchantStorage).find((m) => m.id === merchantId)
    if (!merchant) throw new InvoiceServiceError('not_found', 'This business could not be found.')
    return {
      merchantSnapshot: {
        legalName: merchant.legalName,
        tradingName: merchant.tradingName,
        tin: merchant.registration.tin,
        registrationNumber: merchant.registration.registrationNumber,
        address: merchantAddress(merchant),
        phoneNumber: merchant.contact.phoneNumber,
        email: merchant.contact.email,
      },
      branchSnapshot: {
        name: branch.name,
        code: branch.code,
        address: branch.location.physicalAddress,
      },
    }
  }

  /** Per-merchant sequence, never reused: cancelled and voided invoices keep their numbers. */
  const nextInvoiceNumber = (merchantId: string) => {
    const highest = store
      .loadInvoices()
      .filter((invoice) => invoice.merchantId === merchantId)
      .reduce(
        (max, invoice) => Math.max(max, Number(/(\d+)$/.exec(invoice.invoiceNumber)?.[1] ?? 0)),
        0,
      )
    return `INV-${String(highest + 1).padStart(4, '0')}`
  }

  /** Shared by create and update: validate the request against the actor, branch and assignee. */
  const prepareContent = (actor: Actor, merchantId: string, input: InvoiceDraftInput) => {
    validateDraftInput(input)
    if (actor.membership.role === 'CASHIER' && input.assignedToUserId !== actor.user.id) {
      throw new InvoiceServiceError(
        'forbidden',
        'Cashiers can only create invoices for themselves.',
      )
    }
    const branch = activeBranch(merchantId, input.branchId)
    const assignee = assertAssigneeEligible(merchantId, branch, input.assignedToUserId)
    const calculation = calculateInvoice(input.items, input.taxMode)
    return { branch, assignee, calculation, ...snapshots(merchantId, branch) }
  }

  const contentFields = (
    input: InvoiceDraftInput,
    prepared: ReturnType<typeof prepareContent>,
    ids: string[] = [],
  ) => ({
    branchId: prepared.branch.id,
    assignedToUserId: prepared.assignee.id,
    assignedToName: prepared.assignee.fullName,
    customer: {
      name: input.customer.name.trim(),
      email: input.customer.email || undefined,
      phoneNumber: input.customer.phoneNumber || undefined,
      address: input.customer.address || undefined,
      tin: input.customer.tin || undefined,
    },
    merchantSnapshot: prepared.merchantSnapshot,
    branchSnapshot: prepared.branchSnapshot,
    taxMode: input.taxMode,
    ...calculateInvoice(
      input.items,
      input.taxMode,
      ids.length ? ids : input.items.map(() => `item-${crypto.randomUUID().slice(0, 8)}`),
    ),
    dueAt: input.dueAt,
    notes: input.notes?.trim() || undefined,
  })

  return {
    listInvoices: (merchantId, request) =>
      run(() => {
        const actor = actorFor(merchantId)
        if (!hasPermission(actor.membership.role, 'invoices:view')) {
          throw new InvoiceServiceError('forbidden', 'You do not have permission to view invoices.')
        }
        const visible = store
          .loadInvoices()
          .filter(
            (invoice) =>
              invoice.merchantId === merchantId &&
              canPerformInvoiceAction(actor.membership.role, actor.user.id, invoice, 'view'),
          )
          .map(decorate)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
        // Pagination-shaped, but the mock dataset is small: one page with everything.
        const items = request?.limit ? visible.slice(0, request.limit) : visible
        return { items, totalCount: visible.length, nextCursor: null }
      }),

    getInvoice: (merchantId, invoiceId) =>
      run(() => decorate(findVisibleInvoice(actorFor(merchantId), merchantId, invoiceId))),

    getInvoiceFormOptions: (merchantId) =>
      run<InvoiceFormOptions>(() => {
        const actor = actorFor(merchantId)
        requireCreatePermission(actor)
        const activeBranches = store
          .loadBranches()
          .filter((branch) => branch.merchantId === merchantId && branch.status === 'ACTIVE')
        const activeBranchIds = new Set(activeBranches.map((branch) => branch.id))
        const users = store.loadUsers()
        const assignments = store
          .loadBranchAssignments()
          .filter(
            (a) =>
              a.merchantId === merchantId &&
              a.status === 'ACTIVE' &&
              activeBranchIds.has(a.branchId),
          )

        const assignees = store
          .loadMemberships()
          .filter((m) => m.merchantId === merchantId && m.status === 'ACTIVE')
          .flatMap<InvoiceAssigneeOption>((membership) => {
            const user = users.find((u) => u.id === membership.userId)
            const branchIds = assignments
              .filter((a) => a.membershipId === membership.id)
              .map((a) => a.branchId)
            if (!user || user.status !== 'ACTIVE' || branchIds.length === 0) return []
            return [
              { userId: user.id, membershipId: membership.id, fullName: user.fullName, branchIds },
            ]
          })
          // Cashiers may only act for themselves.
          .filter(
            (assignee) => actor.membership.role !== 'CASHIER' || assignee.userId === actor.user.id,
          )
          .sort((a, b) => a.fullName.localeCompare(b.fullName))

        const usableBranchIds = new Set(assignees.flatMap((assignee) => assignee.branchIds))
        const branches = activeBranches
          // A cashier only sees branches they are assigned to; managers see every active branch.
          .filter((branch) => actor.membership.role !== 'CASHIER' || usableBranchIds.has(branch.id))
          .map((branch) => ({ id: branch.id, name: branch.name, code: branch.code }))
          .sort((a, b) => a.name.localeCompare(b.name))
        return { branches, assignees }
      }),

    createDraft: (merchantId, input) =>
      run(() => {
        const actor = actorFor(merchantId)
        requireCreatePermission(actor)
        const prepared = prepareContent(actor, merchantId, input)
        const now = new Date().toISOString()
        const invoice: Invoice = {
          id: `inv-${crypto.randomUUID().slice(0, 8)}`,
          merchantId,
          invoiceNumber: nextInvoiceNumber(merchantId),
          createdByUserId: actor.user.id,
          createdByName: actor.user.fullName,
          currency: 'RWF',
          createdAt: now,
          updatedAt: now,
          status: 'DRAFT',
          // Issuing or saving never implies payment; only bank reconciliation may change this.
          paymentStatus: 'UNPAID',
          version: 1,
          ...contentFields(input, prepared),
        }
        store.saveInvoices([...store.loadInvoices(), invoice])
        return decorate(invoice)
      }),

    updateDraft: (merchantId, invoiceId, input, expectedVersion) =>
      run(() => {
        const actor = actorFor(merchantId)
        const existing = findVisibleInvoice(actor, merchantId, invoiceId)
        if (!canTransitionInvoice(existing.status, 'ISSUED')) {
          throw new InvoiceServiceError('invalid_transition', 'Only drafts can be edited.')
        }
        requireAction(actor, existing, 'edit_draft', 'You cannot edit this invoice.')
        assertVersion(existing, expectedVersion)
        const prepared = prepareContent(actor, merchantId, input)
        const updated: Invoice = {
          ...existing,
          ...contentFields(
            input,
            prepared,
            existing.items.map((item) => item.id),
          ),
          updatedAt: new Date().toISOString(),
          version: existing.version + 1,
        }
        saveInvoice(updated)
        return decorate(updated)
      }),

    issueInvoice: (merchantId, invoiceId, expectedVersion) =>
      run(() => {
        const actor = actorFor(merchantId)
        const existing = findVisibleInvoice(actor, merchantId, invoiceId)
        if (!canTransitionInvoice(existing.status, 'ISSUED')) {
          throw new InvoiceServiceError('invalid_transition', 'Only drafts can be issued.')
        }
        requireAction(actor, existing, 'issue', 'You cannot issue this invoice.')
        assertVersion(existing, expectedVersion)

        // Eligibility is re-checked now: the branch or assignment may have changed since the draft.
        const branch = activeBranch(merchantId, existing.branchId)
        const assignee = assertAssigneeEligible(merchantId, branch, existing.assignedToUserId)
        const now = new Date().toISOString()
        // Freeze the merchant, branch and staff details as they are at issue time.
        const frozen = snapshots(merchantId, branch)
        const issued: Invoice = {
          ...existing,
          merchantSnapshot: frozen.merchantSnapshot,
          branchSnapshot: frozen.branchSnapshot,
          assignedToName: assignee.fullName,
          status: 'ISSUED',
          issuedAt: now,
          updatedAt: now,
          version: existing.version + 1,
        }
        validateForIssue(issued)
        saveInvoice(issued)
        return decorate(issued)
      }),

    cancelDraft: (merchantId, invoiceId, expectedVersion) =>
      run(() => {
        const actor = actorFor(merchantId)
        const existing = findVisibleInvoice(actor, merchantId, invoiceId)
        if (!canTransitionInvoice(existing.status, 'CANCELLED')) {
          throw new InvoiceServiceError(
            'invalid_transition',
            existing.status === 'ISSUED'
              ? 'An issued invoice cannot be cancelled. Ask an owner to void it.'
              : 'This invoice can no longer be cancelled.',
          )
        }
        requireAction(actor, existing, 'cancel_draft', 'You cannot cancel this invoice.')
        assertVersion(existing, expectedVersion)
        const now = new Date().toISOString()
        const cancelled: Invoice = {
          ...existing,
          status: 'CANCELLED',
          cancelledAt: now,
          updatedAt: now,
          version: existing.version + 1,
        }
        saveInvoice(cancelled)
        return decorate(cancelled)
      }),

    voidInvoice: (merchantId, invoiceId, { reason }, expectedVersion) =>
      run(() => {
        const actor = actorFor(merchantId)
        const existing = findVisibleInvoice(actor, merchantId, invoiceId)
        if (!hasPermission(actor.membership.role, 'invoices:void')) {
          throw new InvoiceServiceError('forbidden', 'Only an owner can void an invoice.')
        }
        if (!canTransitionInvoice(existing.status, 'VOIDED')) {
          throw new InvoiceServiceError('invalid_transition', 'Only issued invoices can be voided.')
        }
        if (decorate(existing).paymentStatus !== 'UNPAID') {
          throw new InvoiceServiceError(
            'void_not_allowed',
            'An invoice with payment activity cannot be voided. It needs a credit note or refund instead.',
          )
        }
        if (reason.trim().length < 3) throw invalid('Give a reason for voiding this invoice.')
        assertVersion(existing, expectedVersion)
        const now = new Date().toISOString()
        const voided: Invoice = {
          ...existing,
          status: 'VOIDED',
          voidedAt: now,
          voidReason: reason.trim(),
          updatedAt: now,
          version: existing.version + 1,
        }
        saveInvoice(voided)
        return decorate(voided)
      }),
  } satisfies InvoiceService
}
