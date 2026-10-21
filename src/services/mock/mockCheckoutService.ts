import { hasPermission } from '@/features/auth/permissions/permissions'
import {
  SIMPLE_CHECKOUT_DEFAULT_DESCRIPTION,
  SIMPLE_CHECKOUT_LIFETIME_MINUTES,
  SIMPLE_CHECKOUT_MAX_AMOUNT_RWF,
  SIMPLE_CHECKOUT_MAX_DESCRIPTION,
  SIMPLE_CHECKOUT_MIN_AMOUNT_RWF,
  WALK_IN_CUSTOMER_NAME,
} from '@/constants/checkout'
import { todayInKigali } from '@/lib/invoiceLifecycle'
import { CheckoutServiceError, type CheckoutService } from '@/services/checkoutService'
import type { InvoiceService } from '@/services/invoiceService'
import { OrganizationServiceError } from '@/services/organizationService'
import type {
  CheckoutReadiness,
  SimpleCheckoutInput,
  SimpleCheckoutOptions,
  SimpleCheckoutResult,
} from '@/types/checkout'
import type { Invoice } from '@/types/invoice'
import { newId, type LedgerStore } from './ledger/mockLedgerStore'
import { resolvePaymentRequest } from './ledger/paymentRequestView'
import type { MockAuthStore } from './mockAuthStore'
import {
  loadStoredMerchants,
  resolveDefaultStorage,
  type MerchantStorage,
} from './mockMerchantService'
import { createOperationRunner, requireActor, type Actor } from './mockOrganizationAccess'
import { chooseCollectingProfile, newUniquePaymentReference } from './mockPaymentProfileService'
import { MOCK_STORAGE_KEYS } from './mockStorageKeys'

interface MockCheckoutServiceOptions {
  authStore: MockAuthStore
  ledger: LedgerStore
  /** The mock invoice service: the sale goes through its normal draft and issue rules. */
  invoiceService: InvoiceService
  merchantStorage?: MerchantStorage
  delayInMilliseconds?: number
}

/**
 * What the mock remembers about a sale, so repeating it behaves like the server: the sale's permanent identifier with the
 * fingerprint of the sale it was first used for, and the retry keys that reached it.
 */
interface StoredSale {
  merchantId: string
  clientRequestId: string
  idempotencyKeys: string[]
  fingerprint: string
  createdByUserId: string
  invoiceId: string
}

const invalid = (message: string) => new CheckoutServiceError('validation', message)

/** The sale's meaning, canonical: who bills, how much, the note and the branch asked for. */
const fingerprintOf = (userId: string, input: SimpleCheckoutInput, description: string) =>
  JSON.stringify([userId, input.amountRwf, description, input.branchId ?? null])

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

type Decision =
  | { kind: 'repeat'; actor: Actor; sale: StoredSale }
  | { kind: 'new'; actor: Actor; branchId: string; fingerprint: string }

/**
 * DEMO ONLY: an in-browser stand-in for the server's simplified checkout, built on the SAME mock invoice, payment-link and
 * ledger services as every other screen. It makes the decisions the server makes (mode, branch eligibility, amount range, one
 * durable sale per client request id, a fixed thirty-minute request, nothing created unless a link can collect) but it proves
 * nothing about real money: a payment is only ever confirmed by the mock bank simulator, exactly like invoices.
 */
export function createMockCheckoutService(options: MockCheckoutServiceOptions): CheckoutService {
  const { authStore: store, ledger, invoiceService } = options
  const merchantStorage = options.merchantStorage ?? resolveDefaultStorage()
  const run = createOperationRunner(options.delayInMilliseconds ?? 450)
  const sales = () => store.loadRecords<StoredSale>(MOCK_STORAGE_KEYS.checkoutSales, [])

  const actorFor = (merchantId: string): Actor => {
    let actor: Actor
    try {
      actor = requireActor(store, merchantId)
    } catch (error) {
      if (error instanceof OrganizationServiceError) {
        throw new CheckoutServiceError(
          error.code === 'unauthenticated' ? 'unauthenticated' : 'not_found',
          error.message,
        )
      }
      throw error
    }
    if (!hasPermission(actor.membership.role, 'invoices:create')) {
      throw new CheckoutServiceError('forbidden', 'You do not have permission to collect payments.')
    }
    return actor
  }

  const merchantOf = (merchantId: string) =>
    loadStoredMerchants(merchantStorage).find((m) => m.id === merchantId)

  const modeOf = (merchantId: string) => merchantOf(merchantId)?.operatingMode ?? 'BUSINESS'

  /** Active branches this person is actively assigned to. Nothing is created or assigned for them. */
  const eligibleBranches = (merchantId: string, actor: Actor) => {
    const assignedBranchIds = new Set(
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
      .filter(
        (b) => b.merchantId === merchantId && b.status === 'ACTIVE' && assignedBranchIds.has(b.id),
      )
      .map((b) => ({
        id: b.id,
        name: b.name,
        code: b.code,
        paymentReady:
          chooseCollectingProfile(ledger, merchantId, b.id, actor.user.id) !== undefined,
      }))
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  const resultFor = (merchantId: string, invoice: Invoice): SimpleCheckoutResult => {
    const stored = ledger.paymentRequests
      .load()
      .filter((r) => r.merchantId === merchantId && r.invoiceId === invoice.id)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0]
    if (!stored) throw new CheckoutServiceError('not_found', 'This payment could not be found.')
    const { request } = resolvePaymentRequest(store, ledger, stored)
    const token =
      ledger.paymentProfiles.load().find((p) => p.id === request.paymentProfileId)
        ?.paymentProfileId ?? ''
    const merchant = merchantOf(merchantId)
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.invoiceNumber,
      paymentRequestId: request.id,
      publicReference: request.publicReference,
      amountRwf: request.requestedAmount,
      currency: 'RWF',
      description: invoice.items[0]?.description ?? SIMPLE_CHECKOUT_DEFAULT_DESCRIPTION,
      status: request.status,
      expiresAt: request.expiresAt,
      createdAt: request.createdAt,
      merchantDisplayName: merchant?.tradingName?.trim() || merchant?.legalName || 'Business',
      branchId: invoice.branchId,
      branchName: invoice.branchSnapshot.name,
      profileToken: token,
      paymentPath: `/p/${token}/r/${request.publicReference}`,
    }
  }

  /** Every check the server makes before it creates anything. Throws; creates nothing. */
  const decide = (merchantId: string, input: SimpleCheckoutInput, line: string): Decision => {
    const actor = actorFor(merchantId)
    if (modeOf(merchantId) !== 'SIMPLIFIED') {
      throw new CheckoutServiceError(
        'checkout_not_available',
        'Simplified checkout is only available to businesses in simplified mode.',
      )
    }
    const fingerprint = fingerprintOf(actor.user.id, input, line)
    const forMerchant = sales().filter((s) => s.merchantId === merchantId)
    const keyed = forMerchant.find((s) => s.idempotencyKeys.includes(input.idempotencyKey))
    if (keyed && (keyed.fingerprint !== fingerprint || keyed.createdByUserId !== actor.user.id)) {
      throw new CheckoutServiceError(
        'idempotency_key_reuse',
        'This Idempotency-Key was already used for a different request. Use a new key for a new request.',
      )
    }
    const known = forMerchant.find((s) => s.clientRequestId === input.clientRequestId)
    if (known) {
      if (known.fingerprint !== fingerprint || known.createdByUserId !== actor.user.id) {
        throw new CheckoutServiceError(
          'client_request_id_reuse',
          'This request identifier was already used for a different sale.',
        )
      }
      return { kind: 'repeat', actor, sale: known }
    }

    const eligible = eligibleBranches(merchantId, actor)
    const [onlyOrFirst] = eligible
    if (!onlyOrFirst) {
      throw new CheckoutServiceError(
        'no_eligible_branch',
        actor.membership.role === 'CASHIER'
          ? 'You are not assigned to an active branch yet. Ask your manager to assign you to one.'
          : 'You are not assigned to an active branch. Create a branch, or assign yourself to one, before collecting payments.',
      )
    }
    let branch = onlyOrFirst
    if (input.branchId) {
      const chosen = eligible.find((b) => b.id === input.branchId)
      if (!chosen) {
        throw new CheckoutServiceError(
          'branch_not_eligible',
          'Choose one of the branches you are assigned to.',
        )
      }
      branch = chosen
    } else if (eligible.length > 1) {
      throw new CheckoutServiceError('branch_required', 'Choose the branch you are billing for.')
    }
    // Nothing is created unless a payment link can collect: no half-finished sale is ever left behind.
    if (!branch.paymentReady) {
      throw new CheckoutServiceError(
        'no_active_profile',
        'There is no active payment link for this invoice. Create or switch one on in Payment links.',
      )
    }
    return { kind: 'new', actor, branchId: branch.id, fingerprint }
  }

  return {
    getSimpleCheckoutOptions: (merchantId) =>
      run<SimpleCheckoutOptions>(() => {
        const actor = actorFor(merchantId)
        const mode = modeOf(merchantId)
        const branches = mode === 'SIMPLIFIED' ? eligibleBranches(merchantId, actor) : []
        let readiness: CheckoutReadiness = 'READY'
        if (mode !== 'SIMPLIFIED') readiness = 'NOT_SIMPLIFIED'
        else if (branches.length === 0) readiness = 'NO_BRANCH'
        else if (branches.every((b) => !b.paymentReady)) readiness = 'NO_PAYMENT_LINK'
        return {
          operatingMode: mode,
          readiness,
          branches,
          minAmountRwf: SIMPLE_CHECKOUT_MIN_AMOUNT_RWF,
          maxAmountRwf: SIMPLE_CHECKOUT_MAX_AMOUNT_RWF,
          paymentLifetimeMinutes: SIMPLE_CHECKOUT_LIFETIME_MINUTES,
          defaultDescription: SIMPLE_CHECKOUT_DEFAULT_DESCRIPTION,
        }
      }),

    billSimpleCheckout: async (merchantId, input) => {
      // Validation that needs no data runs first, like the server's.
      if (
        !Number.isInteger(input.amountRwf) ||
        input.amountRwf < SIMPLE_CHECKOUT_MIN_AMOUNT_RWF ||
        input.amountRwf > SIMPLE_CHECKOUT_MAX_AMOUNT_RWF
      ) {
        throw invalid(
          `Enter a whole amount between RWF ${SIMPLE_CHECKOUT_MIN_AMOUNT_RWF} and RWF ${SIMPLE_CHECKOUT_MAX_AMOUNT_RWF}.`,
        )
      }
      const description = (input.description ?? '').trim()
      if (
        description.length > SIMPLE_CHECKOUT_MAX_DESCRIPTION ||
        CONTROL_CHARACTERS.test(description)
      ) {
        throw invalid(
          `The description can be at most ${SIMPLE_CHECKOUT_MAX_DESCRIPTION} characters, on one line.`,
        )
      }
      if (input.idempotencyKey.length < 8) throw invalid('An Idempotency-Key is required.')
      const line = description || SIMPLE_CHECKOUT_DEFAULT_DESCRIPTION

      // All decisions are taken before anything is created, so a refusal leaves nothing behind.
      const decision = await run(() => decide(merchantId, input, line))

      if (decision.kind === 'repeat') {
        const { sale } = decision
        return run(() => {
          if (!sale.idempotencyKeys.includes(input.idempotencyKey)) {
            store.saveRecords<StoredSale>(
              MOCK_STORAGE_KEYS.checkoutSales,
              sales().map((s) =>
                s.merchantId === sale.merchantId && s.clientRequestId === sale.clientRequestId
                  ? { ...s, idempotencyKeys: [...s.idempotencyKeys, input.idempotencyKey] }
                  : s,
              ),
            )
          }
          const invoice = store.loadInvoices().find((i) => i.id === sale.invoiceId)
          if (!invoice)
            throw new CheckoutServiceError('not_found', 'This payment could not be found.')
          return resultFor(merchantId, invoice)
        })
      }

      const draft = await invoiceService.createDraft(merchantId, {
        branchId: decision.branchId,
        assignedToUserId: decision.actor.user.id,
        customer: { name: WALK_IN_CUSTOMER_NAME },
        items: [
          {
            description: line,
            quantity: 1,
            unitPrice: input.amountRwf,
            discount: 0,
            taxRate: { category: 'NOT_APPLICABLE', rateBp: 0 },
          },
        ],
        taxMode: 'EXCLUSIVE',
        dueAt: todayInKigali(),
      })
      const issued = await invoiceService.issueInvoice(merchantId, draft.id, draft.version)

      return run(() => {
        // Stamp where the sale came from (the server sets this; no screen or form can), then open the request.
        store.saveInvoices(
          store
            .loadInvoices()
            .map((i) => (i.id === issued.id ? { ...i, saleChannel: 'SIMPLIFIED' as const } : i)),
        )
        const profile = chooseCollectingProfile(
          ledger,
          merchantId,
          decision.branchId,
          decision.actor.user.id,
        )
        if (!profile) {
          throw new CheckoutServiceError(
            'no_active_profile',
            'There is no active payment link for this invoice.',
          )
        }
        const now = new Date()
        ledger.paymentRequests.save([
          ...ledger.paymentRequests.load(),
          {
            id: newId('pr'),
            merchantId,
            paymentProfileId: profile.id,
            invoiceId: issued.id,
            requestedAmount: issued.grandTotal,
            currency: 'RWF',
            publicReference: newUniquePaymentReference(ledger),
            expiresAt: new Date(
              now.getTime() + SIMPLE_CHECKOUT_LIFETIME_MINUTES * 60_000,
            ).toISOString(),
            createdAt: now.toISOString(),
            updatedAt: now.toISOString(),
          },
        ])
        store.saveRecords<StoredSale>(MOCK_STORAGE_KEYS.checkoutSales, [
          ...sales(),
          {
            merchantId,
            clientRequestId: input.clientRequestId,
            idempotencyKeys: [input.idempotencyKey],
            fingerprint: decision.fingerprint,
            createdByUserId: decision.actor.user.id,
            invoiceId: issued.id,
          },
        ])
        return resultFor(merchantId, { ...issued, saleChannel: 'SIMPLIFIED' })
      })
    },
  }
}
