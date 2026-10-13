import {
  MAXIMUM_OPEN_PAYMENT_AMOUNT,
  MINIMUM_OPEN_PAYMENT_AMOUNT,
  OPEN_REQUEST_LIFETIME_MINUTES,
  PAYMENT_METHODS,
} from '@/constants/paymentMethods'
import { formatRwf } from '@/lib/format'
import { generatePaymentReference } from '@/lib/publicTokens'
import { getAdapter } from '@/services/banking/providerRegistry'
import { PaymentServiceError } from '@/services/paymentServiceError'
import type { PublicPaymentService } from '@/services/publicPaymentService'
import type { BankConnection, PaymentDestination } from '@/types/banking'
import type {
  PaymentProfile,
  PublicPaymentMethod,
  PublicProfileView,
  PublicRequestView,
} from '@/types/paymentProfile'
import { createMockAuthStore, type MockAuthStore } from './mockAuthStore'
import { createLedgerStore, newId, type LedgerStore } from './ledger/mockLedgerStore'
import { resolvePaymentRequest } from './ledger/paymentRequestView'
import {
  loadStoredMerchants,
  resolveDefaultStorage,
  type MerchantStorage,
} from './mockMerchantService'
import { createOperationRunner } from './mockOrganizationAccess'
import type { StoredPaymentRequest } from './sampleLedger'

interface MockPublicPaymentServiceOptions {
  authStore?: MockAuthStore
  ledger?: LedgerStore
  merchantStorage?: MerchantStorage
  delayInMilliseconds?: number
  now?: () => Date
}

const unavailableProfile: PublicProfileView = {
  merchantDisplayName: '',
  branchName: null,
  cashierDisplayName: null,
  isMerchantVerified: false,
  status: 'UNAVAILABLE',
  paymentMethods: [],
}

/** "Aline Uwase" -> "Aline U." Nothing more is shown to the public. */
const publicCashierName = (fullName: string): string => {
  const [first = '', ...rest] = fullName.trim().split(/\s+/)
  const last = rest[rest.length - 1]
  return last ? `${first} ${last.charAt(0).toUpperCase()}.` : first
}

/**
 * MOCK anonymous payment pages. Every answer is built from the public token only and exposes
 * the merchant display name, optional branch and cashier first name, the amount, the reference
 * and the status of THIS request. Nothing here can confirm a payment.
 */
export function createMockPublicPaymentService(
  options: MockPublicPaymentServiceOptions = {},
): PublicPaymentService {
  const store = options.authStore ?? createMockAuthStore()
  const ledger = options.ledger ?? createLedgerStore(store)
  const merchantStorage = options.merchantStorage ?? resolveDefaultStorage()
  const clock = options.now ?? (() => new Date())
  const run = createOperationRunner(options.delayInMilliseconds ?? 300)

  const findProfileByToken = (token: string): PaymentProfile | undefined =>
    ledger.paymentProfiles.load().find((profile) => profile.paymentProfileId === token)

  const destinationAndConnection = (
    profile: PaymentProfile,
  ): { destination?: PaymentDestination; connection?: BankConnection } => {
    const destination = ledger.paymentDestinations
      .load()
      .find((candidate) => candidate.id === profile.paymentDestinationId)
    const connection = destination
      ? ledger.bankConnections.load().find((c) => c.id === destination.bankConnectionId)
      : undefined
    return { destination, connection }
  }

  const methodsFor = (profile: PaymentProfile): PublicPaymentMethod[] => {
    const { destination, connection } = destinationAndConnection(profile)
    return PAYMENT_METHODS.map<PublicPaymentMethod>((method) => {
      const adapter = getAdapter(method.providerId)
      const isConfigured =
        destination?.providerId === method.providerId && connection?.status === 'CONNECTED'
      const canConfirm = adapter?.getProviderCapabilities().transactionWebhooks === 'SUPPORTED'
      const isUsable = Boolean(adapter && isConfigured && canConfirm)
      return {
        id: method.id,
        label: method.label,
        isUsable,
        isSimulated: Boolean(adapter?.isSimulated),
        unavailableReason: isUsable
          ? undefined
          : !adapter
            ? 'Not available yet.'
            : 'This merchant has not set this method up.',
        // Plain steps only: no USSD codes, deep links or endpoints are invented.
        instructions: isUsable
          ? [
              'Pay the merchant through your bank or wallet using the payment option it offers.',
              'Include the reference shown on this page exactly as written, so the payment can be matched.',
              'Never share a PIN, password or one-time code with anyone, including the merchant.',
              'Keep this page open: it updates once the bank confirms your payment.',
            ]
          : [],
      }
    })
  }

  const viewOfProfile = (profile: PaymentProfile): PublicProfileView => {
    const merchant = loadStoredMerchants(merchantStorage).find((m) => m.id === profile.merchantId)
    const isLive =
      profile.status === 'ACTIVE' &&
      merchant !== undefined &&
      merchant.status !== 'suspended' &&
      merchant.status !== 'rejected' &&
      destinationAndConnection(profile).connection?.status === 'CONNECTED'
    // An unavailable link reveals nothing: no name, no branch, no cashier.
    if (!isLive || !merchant) return unavailableProfile
    const branch = profile.branchId
      ? store.loadBranches().find((candidate) => candidate.id === profile.branchId)
      : undefined
    const cashier = profile.assignedCashierId
      ? store.loadUsers().find((candidate) => candidate.id === profile.assignedCashierId)
      : undefined
    return {
      merchantDisplayName: merchant.tradingName?.trim() || merchant.legalName,
      branchName: branch?.name ?? null,
      cashierDisplayName: cashier ? publicCashierName(cashier.fullName) : null,
      // Verified only when OuPay really verified the business, never by default.
      isMerchantVerified: merchant.status === 'active',
      status: 'ACTIVE',
      paymentMethods: methodsFor(profile),
    }
  }

  const viewOfRequest = (
    profile: PaymentProfile,
    stored: StoredPaymentRequest,
  ): PublicRequestView => {
    const { request, state } = resolvePaymentRequest(store, ledger, stored, clock())
    const invoice = stored.invoiceId
      ? store.loadInvoices().find((candidate) => candidate.id === stored.invoiceId)
      : undefined
    const { destination } = destinationAndConnection(profile)
    return {
      profile: viewOfProfile(profile),
      invoiceReference: invoice?.invoiceNumber ?? null,
      requestedAmount: request.requestedAmount,
      amountDue: state.amountDue,
      currency: 'RWF',
      confirmedAmount: state.confirmedAmount,
      publicReference: request.publicReference,
      isAmountFixed: true,
      stage: state.stage,
      expiresAt: request.expiresAt,
      instructionsOpened: Boolean(request.instructionsOpenedAt),
      customerClaimedPayment: Boolean(request.customerClaimedPaymentAt),
      isSimulated: destination?.isSimulated ?? true,
    }
  }

  /** The request, only if it belongs to the profile the URL names. Anything else is "not found". */
  const resolve = (token: string, publicReference: string) => {
    const profile = findProfileByToken(token)
    const stored = profile
      ? ledger.paymentRequests
          .load()
          .find((r) => r.publicReference === publicReference && r.paymentProfileId === profile.id)
      : undefined
    if (!profile || !stored) {
      throw new PaymentServiceError('not_found', 'This payment page could not be found.')
    }
    return { profile, stored }
  }

  const updateRequest = (stored: StoredPaymentRequest, changes: Partial<StoredPaymentRequest>) => {
    ledger.paymentRequests.save(
      ledger.paymentRequests
        .load()
        .map((r) =>
          r.id === stored.id ? { ...r, ...changes, updatedAt: clock().toISOString() } : r,
        ),
    )
  }

  return {
    getProfile: (paymentProfileId) =>
      run(() => {
        const profile = findProfileByToken(paymentProfileId)
        if (!profile)
          throw new PaymentServiceError('not_found', 'This payment page could not be found.')
        return viewOfProfile(profile)
      }),

    createOpenRequest: (paymentProfileId, amountInRwf) =>
      run(() => {
        const profile = findProfileByToken(paymentProfileId)
        if (!profile)
          throw new PaymentServiceError('not_found', 'This payment page could not be found.')
        if (viewOfProfile(profile).status !== 'ACTIVE') {
          throw new PaymentServiceError(
            'profile_unavailable',
            'This payment link is not available.',
          )
        }
        if (
          !Number.isInteger(amountInRwf) ||
          amountInRwf < MINIMUM_OPEN_PAYMENT_AMOUNT ||
          amountInRwf > MAXIMUM_OPEN_PAYMENT_AMOUNT
        ) {
          throw new PaymentServiceError(
            'validation',
            `Enter a whole amount between ${formatRwf(MINIMUM_OPEN_PAYMENT_AMOUNT)} and ${formatRwf(MAXIMUM_OPEN_PAYMENT_AMOUNT)}.`,
          )
        }
        const now = clock()
        const references = new Set(ledger.paymentRequests.load().map((r) => r.publicReference))
        let publicReference = generatePaymentReference()
        while (references.has(publicReference)) publicReference = generatePaymentReference()
        const stored: StoredPaymentRequest = {
          id: newId('pr'),
          merchantId: profile.merchantId,
          paymentProfileId: profile.id,
          invoiceId: null,
          requestedAmount: amountInRwf,
          currency: 'RWF',
          publicReference,
          expiresAt: new Date(now.getTime() + OPEN_REQUEST_LIFETIME_MINUTES * 60_000).toISOString(),
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        }
        ledger.paymentRequests.save([...ledger.paymentRequests.load(), stored])
        return viewOfRequest(profile, stored)
      }),

    getRequest: (paymentProfileId, publicReference) =>
      run(() => {
        const { profile, stored } = resolve(paymentProfileId, publicReference)
        return viewOfRequest(profile, stored)
      }),

    markInstructionsOpened: (paymentProfileId, publicReference) =>
      run(() => {
        const { stored } = resolve(paymentProfileId, publicReference)
        if (!stored.instructionsOpenedAt) {
          updateRequest(stored, { instructionsOpenedAt: clock().toISOString() })
        }
      }),

    claimPaymentInitiated: (paymentProfileId, publicReference) =>
      run(() => {
        const { profile, stored } = resolve(paymentProfileId, publicReference)
        const view = viewOfRequest(profile, stored)
        if (view.stage === 'EXPIRED' || view.stage === 'CANCELLED') {
          throw new PaymentServiceError('request_unavailable', 'This request is no longer payable.')
        }
        // A claim only. It never changes the verified status, which comes from the bank alone.
        if (!stored.customerClaimedPaymentAt) {
          updateRequest(stored, { customerClaimedPaymentAt: clock().toISOString() })
        }
      }),
  }
}
