import { getPermissionScope } from '@/features/auth/permissions/permissions'
import { generatePaymentReference, generatePublicToken } from '@/lib/publicTokens'
import { INVOICE_REQUEST_LIFETIME_DAYS } from '@/constants/paymentMethods'
import { PaymentServiceError } from '@/services/paymentServiceError'
import type {
  CreatePaymentProfileInput,
  InvoicePaymentRequestView,
  PaymentProfileService,
  PaymentProfileView,
} from '@/services/paymentProfileService'
import type { PaymentProfile, PaymentRequest } from '@/types/paymentProfile'
import { createMockAuthStore, type MockAuthStore } from './mockAuthStore'
import { createLedgerStore, newId, type LedgerStore } from './ledger/mockLedgerStore'
import { resolvePaymentRequest } from './ledger/paymentRequestView'
import { createLedgerOperations } from './ledger/ledgerOperations'
import { createOperationRunner } from './mockOrganizationAccess'
import { requirePaymentActor } from './mockPaymentAccess'
import {
  loadStoredMerchants,
  resolveDefaultStorage,
  type MerchantStorage,
} from './mockMerchantService'

interface MockPaymentProfileServiceOptions {
  authStore?: MockAuthStore
  ledger?: LedgerStore
  merchantStorage?: MerchantStorage
  delayInMilliseconds?: number
}

export function createMockPaymentProfileService(
  options: MockPaymentProfileServiceOptions = {},
): PaymentProfileService {
  const store = options.authStore ?? createMockAuthStore()
  const ledger = options.ledger ?? createLedgerStore(store)
  const merchantStorage = options.merchantStorage ?? resolveDefaultStorage()
  const ops = createLedgerOperations(store, ledger)
  const run = createOperationRunner(options.delayInMilliseconds ?? 350)

  const merchantDisplayName = (merchantId: string): string => {
    const merchant = loadStoredMerchants(merchantStorage).find((m) => m.id === merchantId)
    return merchant?.tradingName?.trim() || merchant?.legalName || 'Business'
  }

  const toView = (profile: PaymentProfile): PaymentProfileView => {
    const branch = profile.branchId
      ? store.loadBranches().find((candidate) => candidate.id === profile.branchId)
      : undefined
    const cashier = profile.assignedCashierId
      ? store.loadUsers().find((candidate) => candidate.id === profile.assignedCashierId)
      : undefined
    const destination = ledger.paymentDestinations
      .load()
      .find((candidate) => candidate.id === profile.paymentDestinationId)
    return {
      ...profile,
      branchName: branch?.name ?? null,
      cashierName: cashier?.fullName ?? null,
      destinationLabel: destination?.label ?? 'Unknown destination',
      destinationMasked: destination?.maskedAccount ?? '',
      isSimulated: destination?.isSimulated ?? true,
    }
  }

  const withToken = (request: PaymentRequest): InvoicePaymentRequestView => ({
    ...request,
    profileToken:
      ledger.paymentProfiles.load().find((p) => p.id === request.paymentProfileId)
        ?.paymentProfileId ?? '',
  })

  const findProfile = (merchantId: string, profileId: string): PaymentProfile => {
    const profile = ledger.paymentProfiles
      .load()
      .find((candidate) => candidate.id === profileId && candidate.merchantId === merchantId)
    if (!profile)
      throw new PaymentServiceError('not_found', 'This payment link could not be found.')
    return profile
  }

  const saveProfile = (updated: PaymentProfile) =>
    ledger.paymentProfiles.save(
      ledger.paymentProfiles.load().map((p) => (p.id === updated.id ? updated : p)),
    )

  /** Any token currently in use, so a new one can never collide with it. */
  const newUniqueToken = (): string => {
    const used = new Set(ledger.paymentProfiles.load().map((p) => p.paymentProfileId))
    for (;;) {
      const token = generatePublicToken(12)
      if (!used.has(token)) return token
    }
  }

  const cashiersOfMerchant = (merchantId: string) => {
    const users = store.loadUsers()
    const assignments = store.loadBranchAssignments().filter((a) => a.status === 'ACTIVE')
    return store
      .loadMemberships()
      .filter(
        (membership) =>
          membership.merchantId === merchantId &&
          membership.role === 'CASHIER' &&
          membership.status === 'ACTIVE',
      )
      .flatMap((membership) => {
        const user = users.find((candidate) => candidate.id === membership.userId)
        if (!user || user.status !== 'ACTIVE') return []
        return [
          {
            userId: user.id,
            fullName: user.fullName,
            branchIds: assignments
              .filter((a) => a.membershipId === membership.id)
              .map((a) => a.branchId),
          },
        ]
      })
  }

  return {
    listProfiles: (merchantId) =>
      run(() => {
        const actor = requirePaymentActor(store, merchantId, 'payment_profiles:view')
        const full = getPermissionScope(actor.membership.role, 'payment_profiles:view') === 'all'
        return ledger.paymentProfiles
          .load()
          .filter(
            (profile) =>
              profile.merchantId === merchantId &&
              (full || profile.assignedCashierId === actor.user.id),
          )
          .map(toView)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      }),

    getProfile: (merchantId, profileId) =>
      run(() => {
        const actor = requirePaymentActor(store, merchantId, 'payment_profiles:view')
        const full = getPermissionScope(actor.membership.role, 'payment_profiles:view') === 'all'
        const profile = findProfile(merchantId, profileId)
        // A cashier asking for someone else's link gets the same answer as for a missing one.
        if (!full && profile.assignedCashierId !== actor.user.id) {
          throw new PaymentServiceError('not_found', 'This payment link could not be found.')
        }
        return toView(profile)
      }),

    getFormOptions: (merchantId) =>
      run(() => {
        requirePaymentActor(store, merchantId, 'payment_profiles:manage')
        return {
          destinations: ledger.paymentDestinations.load().filter((destination) => {
            if (destination.merchantId !== merchantId) return false
            const connection = ledger.bankConnections
              .load()
              .find((candidate) => candidate.id === destination.bankConnectionId)
            return connection?.status === 'CONNECTED'
          }),
          branches: store
            .loadBranches()
            .filter((branch) => branch.merchantId === merchantId && branch.status === 'ACTIVE')
            .map((branch) => ({ id: branch.id, name: branch.name })),
          cashiers: cashiersOfMerchant(merchantId),
        }
      }),

    createProfile: (merchantId, input: CreatePaymentProfileInput) =>
      run(() => {
        requirePaymentActor(store, merchantId, 'payment_profiles:manage')
        const label = input.label.trim()
        if (label.length < 2 || label.length > 60) {
          throw new PaymentServiceError(
            'validation',
            'Give the link a short name (2 to 60 characters).',
          )
        }
        const destination = ledger.paymentDestinations
          .load()
          .find(
            (candidate) =>
              candidate.id === input.paymentDestinationId && candidate.merchantId === merchantId,
          )
        const connection = destination
          ? ledger.bankConnections.load().find((c) => c.id === destination.bankConnectionId)
          : undefined
        if (!destination || connection?.status !== 'CONNECTED') {
          throw new PaymentServiceError(
            'validation',
            'Choose a payment destination with a connected bank link.',
          )
        }

        const branchId = input.branchId || null
        if (branchId) {
          const branch = store
            .loadBranches()
            .find((candidate) => candidate.id === branchId && candidate.merchantId === merchantId)
          if (!branch || branch.status !== 'ACTIVE') {
            throw new PaymentServiceError('validation', 'Choose an active branch of this business.')
          }
        }
        const cashierId = input.assignedCashierId || null
        if (cashierId) {
          const cashier = cashiersOfMerchant(merchantId).find((c) => c.userId === cashierId)
          if (!cashier) {
            throw new PaymentServiceError(
              'validation',
              'Choose an active cashier of this business.',
            )
          }
          if (branchId && !cashier.branchIds.includes(branchId)) {
            throw new PaymentServiceError(
              'validation',
              'That cashier is not assigned to the chosen branch.',
            )
          }
        }

        const now = new Date().toISOString()
        const profile: PaymentProfile = {
          id: newId('pp'),
          merchantId,
          paymentProfileId: newUniqueToken(),
          merchantDisplayName: merchantDisplayName(merchantId),
          label,
          branchId,
          assignedCashierId: cashierId,
          paymentDestinationId: destination.id,
          status: 'ACTIVE',
          createdAt: now,
          updatedAt: now,
        }
        ledger.paymentProfiles.save([...ledger.paymentProfiles.load(), profile])
        return toView(profile)
      }),

    setProfileActive: (merchantId, profileId, isActive) =>
      run(() => {
        requirePaymentActor(store, merchantId, 'payment_profiles:manage')
        const profile = findProfile(merchantId, profileId)
        if (profile.status === 'REVOKED') {
          throw new PaymentServiceError(
            'invalid_state',
            'A replaced link can never be switched back on. Reissue a new one instead.',
          )
        }
        const updated: PaymentProfile = {
          ...profile,
          status: isActive ? 'ACTIVE' : 'INACTIVE',
          updatedAt: new Date().toISOString(),
        }
        saveProfile(updated)
        return toView(updated)
      }),

    reissueProfile: (merchantId, profileId) =>
      run(() => {
        requirePaymentActor(store, merchantId, 'payment_profiles:manage')
        const old = findProfile(merchantId, profileId)
        if (old.status === 'REVOKED') {
          throw new PaymentServiceError('invalid_state', 'This link was already replaced.')
        }
        const now = new Date().toISOString()
        const replacement: PaymentProfile = {
          ...old,
          id: newId('pp'),
          paymentProfileId: newUniqueToken(),
          merchantDisplayName: merchantDisplayName(merchantId),
          status: 'ACTIVE',
          createdAt: now,
          updatedAt: now,
          replacedByProfileId: undefined,
        }
        delete replacement.replacedByProfileId
        saveProfile({
          ...old,
          status: 'REVOKED',
          updatedAt: now,
          replacedByProfileId: replacement.id,
        })
        ledger.paymentProfiles.save([...ledger.paymentProfiles.load(), replacement])
        return toView(replacement)
      }),

    createInvoicePaymentRequest: (merchantId, invoiceId) =>
      run(() => {
        const actor = requirePaymentActor(store, merchantId, 'invoices:view')
        const stored = store
          .loadInvoices()
          .find((candidate) => candidate.id === invoiceId && candidate.merchantId === merchantId)
        const full = getPermissionScope(actor.membership.role, 'invoices:view') === 'all'
        if (!stored || (!full && stored.assignedToUserId !== actor.user.id)) {
          throw new PaymentServiceError('not_found', 'This invoice could not be found.')
        }
        const invoice = ops.decorate(stored)
        if (invoice.status !== 'ISSUED') {
          throw new PaymentServiceError(
            'invoice_not_payable',
            'Only an issued invoice can be paid. Cancelled, voided and draft invoices cannot.',
          )
        }
        if (invoice.payment!.remainingBalance <= 0) {
          throw new PaymentServiceError(
            'invoice_not_payable',
            'This invoice is already fully paid.',
          )
        }

        // Reuse a live request so the customer keeps one reference for one invoice.
        const live = ledger.paymentRequests
          .load()
          .filter((r) => r.merchantId === merchantId && r.invoiceId === invoice.id)
          .map((r) => resolvePaymentRequest(store, ledger, r))
          .find(({ state }) => state.status !== 'CANCELLED' && state.status !== 'EXPIRED')
        if (live) return withToken(live.request)

        const candidates = ledger.paymentProfiles.load().filter((profile) => {
          if (profile.merchantId !== merchantId || profile.status !== 'ACTIVE') return false
          const destination = ledger.paymentDestinations
            .load()
            .find((d) => d.id === profile.paymentDestinationId)
          const connection = destination
            ? ledger.bankConnections.load().find((c) => c.id === destination.bankConnectionId)
            : undefined
          return connection?.status === 'CONNECTED'
        })
        const profile =
          candidates.find(
            (p) =>
              p.assignedCashierId === invoice.assignedToUserId && p.branchId === invoice.branchId,
          ) ??
          candidates.find((p) => p.assignedCashierId === null && p.branchId === invoice.branchId) ??
          candidates.find((p) => p.assignedCashierId === null && p.branchId === null)
        if (!profile) {
          throw new PaymentServiceError(
            'no_active_profile',
            'There is no active payment link for this invoice. Create or switch one on in Payment links.',
          )
        }

        const now = new Date()
        const references = new Set(ledger.paymentRequests.load().map((r) => r.publicReference))
        let publicReference = generatePaymentReference()
        while (references.has(publicReference)) publicReference = generatePaymentReference()
        const created = {
          id: newId('pr'),
          merchantId,
          paymentProfileId: profile.id,
          invoiceId: invoice.id,
          requestedAmount: invoice.payment!.remainingBalance,
          currency: 'RWF' as const,
          publicReference,
          expiresAt: new Date(
            now.getTime() + INVOICE_REQUEST_LIFETIME_DAYS * 24 * 3_600_000,
          ).toISOString(),
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        }
        ledger.paymentRequests.save([...ledger.paymentRequests.load(), created])
        return withToken(resolvePaymentRequest(store, ledger, created).request)
      }),

    listInvoicePaymentRequests: (merchantId, invoiceId) =>
      run<InvoicePaymentRequestView[]>(() => {
        const actor = requirePaymentActor(store, merchantId, 'invoices:view')
        const invoice = store
          .loadInvoices()
          .find((candidate) => candidate.id === invoiceId && candidate.merchantId === merchantId)
        const full = getPermissionScope(actor.membership.role, 'invoices:view') === 'all'
        if (!invoice || (!full && invoice.assignedToUserId !== actor.user.id)) {
          throw new PaymentServiceError('not_found', 'This invoice could not be found.')
        }
        return ledger.paymentRequests
          .load()
          .filter((r) => r.merchantId === merchantId && r.invoiceId === invoiceId)
          .map((r) => withToken(resolvePaymentRequest(store, ledger, r).request))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      }),

    cancelPaymentRequest: (merchantId, requestId) =>
      run(() => {
        requirePaymentActor(store, merchantId, 'payment_profiles:manage')
        const stored = ledger.paymentRequests
          .load()
          .find((r) => r.id === requestId && r.merchantId === merchantId)
        if (!stored) throw new PaymentServiceError('not_found', 'This request could not be found.')
        const { state } = resolvePaymentRequest(store, ledger, stored)
        if (state.status === 'SETTLED' || state.status === 'PARTIALLY_SETTLED') {
          throw new PaymentServiceError(
            'invalid_state',
            'Money has already been confirmed for this request, so it cannot be cancelled.',
          )
        }
        const now = new Date().toISOString()
        const cancelled = { ...stored, cancelledAt: stored.cancelledAt ?? now, updatedAt: now }
        ledger.paymentRequests.save(
          ledger.paymentRequests.load().map((r) => (r.id === cancelled.id ? cancelled : r)),
        )
        return resolvePaymentRequest(store, ledger, cancelled).request
      }),
  }
}
