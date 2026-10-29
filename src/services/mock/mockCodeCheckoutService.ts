import {
  CODE_CHECKOUT_DEFAULT_DESCRIPTION,
  CODE_CHECKOUT_LIFETIME_MINUTES,
  CODE_CHECKOUT_MAX_AMOUNT_RWF,
  CODE_CHECKOUT_MAX_DESCRIPTION,
  CODE_CHECKOUT_MIN_AMOUNT_RWF,
  CODE_DEMO_NOTICE,
} from '@/constants/codeCheckout'
import { WALK_IN_CUSTOMER_NAME } from '@/constants/checkout'
import { hasPermission } from '@/features/auth/permissions/permissions'
import { todayInKigali } from '@/lib/invoiceLifecycle'
import { customerStatusOf } from '@/lib/codeSaleStatus'
import {
  CodeCheckoutServiceError,
  type CodeCheckoutService,
  type PublicCodeSaleService,
} from '@/services/codeCheckoutService'
import type { InvoiceService } from '@/services/invoiceService'
import type { InvoiceItemInput } from '@/types/invoice'
import { OrganizationServiceError } from '@/services/organizationService'
import type {
  CodeChoice,
  CodeCheckoutOptions,
  CodeCheckoutReadiness,
  CodePresentation,
  CodeSale,
  CodeSaleInput,
  PublicCodeSale,
} from '@/types/codeCheckout'
import { newId, type LedgerStore } from './ledger/mockLedgerStore'
import { resolvePaymentRequest } from './ledger/paymentRequestView'
import type { MockAuthStore } from './mockAuthStore'
import {
  loadStoredMerchants,
  resolveDefaultStorage,
  type MerchantStorage,
} from './mockMerchantService'
import { createOperationRunner, requireActor, type Actor } from './mockOrganizationAccess'
import { newUniquePaymentReference } from './mockPaymentProfileService'
import { MOCK_STORAGE_KEYS } from './mockStorageKeys'
import {
  SAMPLE_CODE_ASSIGNMENTS,
  SAMPLE_COLLECTION_CODES,
  type StoredCodeAssignment,
  type StoredCollectionCode,
} from './sampleCollectionCodes'

/** A code sale with every invoice line of a POS cart. `amountRwf` is the total the cashier reviewed: the invoice must equal it. */
export type MockCartSaleInput = CodeSaleInput & { lines: InvoiceItemInput[] }
export type MockCartBilling = (merchantId: string, input: MockCartSaleInput) => Promise<CodeSale>

interface MockCodeCheckoutOptions {
  authStore: MockAuthStore
  ledger: LedgerStore
  /** The mock invoice service: the sale goes through its normal draft and issue rules. */
  invoiceService: InvoiceService
  merchantStorage?: MerchantStorage
  delayInMilliseconds?: number
}

/** The sale as the mock remembers it: an immutable snapshot, like the server's `code_sales` row. */
export interface StoredCodeSale {
  saleId: string
  merchantId: string
  clientRequestId: string
  idempotencyKeys: string[]
  fingerprint: string
  agentUserId: string
  agentName: string
  invoiceId: string
  paymentRequestId: string
  branchId: string
  branchName: string
  description: string
  amountRwf: number
  mode: 'DEMONSTRATION'
  codeId: string
  codeLabel: string
  codeInternalRef: string
  assignmentId: string
}

const fail = (code: ConstructorParameters<typeof CodeCheckoutServiceError>[0], message: string) =>
  new CodeCheckoutServiceError(code, message)

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

const ASSIGNABLE = ['REQUESTED', 'REQUEST_DECLARED', 'ACTIVE']

/** The server's wording for why live collection is refused: the mock never enables it. */
const LIVE_OFF = 'Live collection is not enabled yet. Nothing can be billed with this code.'

interface Held {
  code: StoredCollectionCode
  assignment: StoredCodeAssignment
  mode: 'DEMONSTRATION' | 'UNAVAILABLE'
  reason: string | null
  refusal: 'code_not_available' | 'live_collection_unavailable' | null
}

/**
 * DEMO ONLY: an in-browser stand-in for the server's agent code checkout, built on the SAME mock collection-code registry, invoice
 * service and ledger as every other screen. It makes the decisions the server makes: only a code the caller holds, DEMONSTRATION for
 * a simulated code and nothing for a bank-approved one (live collection is off), one durable sale per client request id, a fixed
 * thirty-minute request, nothing created unless a payment link on the code's own account can collect. It proves nothing about real
 * money: a payment is only ever confirmed by the mock bank simulator.
 */
export function createMockCodeCheckout(options: MockCodeCheckoutOptions): {
  codeCheckoutService: CodeCheckoutService
  publicCodeSaleService: PublicCodeSaleService
  /** Mock-only: bills a MULTI-LINE sale (POS billing). The public service interface is the server's and has no such call. */
  billCart: MockCartBilling
} {
  const { authStore: store, ledger, invoiceService } = options
  const merchantStorage = options.merchantStorage ?? resolveDefaultStorage()
  const run = createOperationRunner(options.delayInMilliseconds ?? 450)

  const sales = () => store.loadRecords<StoredCodeSale>(MOCK_STORAGE_KEYS.codeSales, [])
  const codes = () =>
    store.loadRecords<StoredCollectionCode>(
      MOCK_STORAGE_KEYS.collectionCodes,
      SAMPLE_COLLECTION_CODES,
    )
  const assignments = () =>
    store.loadRecords<StoredCodeAssignment>(
      MOCK_STORAGE_KEYS.collectionCodeAssignments,
      SAMPLE_CODE_ASSIGNMENTS,
    )

  const actorFor = (merchantId: string): Actor => {
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
    if (!hasPermission(actor.membership.role, 'invoices:create')) {
      throw fail('forbidden', 'You do not have permission to collect payments.')
    }
    return actor
  }

  const merchantOf = (merchantId: string) =>
    loadStoredMerchants(merchantStorage).find((m) => m.id === merchantId)

  /** The links that can collect to ONE settlement account. A sample code's fictitious account has no record: any link may stand in. */
  const collectingProfile = (
    merchantId: string,
    code: StoredCollectionCode,
    branchId: string | null,
    userId: string,
  ) => {
    const destination = ledger.paymentDestinations
      .load()
      .find((d) => d.id === code.settlementDestinationId)
    const candidates = ledger.paymentProfiles.load().filter((profile) => {
      if (profile.merchantId !== merchantId || profile.status !== 'ACTIVE') return false
      if (destination && profile.paymentDestinationId !== destination.id) return false
      const own = destination
        ? destination
        : ledger.paymentDestinations.load().find((d) => d.id === profile.paymentDestinationId)
      const connection = own
        ? ledger.bankConnections.load().find((c) => c.id === own.bankConnectionId)
        : undefined
      return connection?.status === 'CONNECTED'
    })
    return (
      candidates.find((p) => p.assignedCashierId === userId && p.branchId === branchId) ??
      candidates.find((p) => p.assignedCashierId === null && p.branchId === branchId) ??
      candidates.find((p) => p.assignedCashierId === null && p.branchId === null)
    )
  }

  /** Why a code cannot bill, computed fresh from the staff, branch and connection data. Never stored. */
  const issuesOf = (code: StoredCollectionCode, assignment: StoredCodeAssignment) => {
    const issues: string[] = []
    if (code.simulated) issues.push('SIMULATED')
    if (!(code.status === 'ACTIVE' && code.approval !== null && code.externalCode !== null)) {
      issues.push('NOT_BANK_APPROVED')
    }
    const destination = ledger.paymentDestinations
      .load()
      .find((d) => d.merchantId === code.merchantId && d.id === code.settlementDestinationId)
    const connection = destination
      ? ledger.bankConnections.load().find((c) => c.id === destination.bankConnectionId)?.status
      : code.sampleConnectionStatus
    if (connection !== 'CONNECTED') issues.push('SETTLEMENT_ACCOUNT_NOT_CONNECTED')
    const branchId = assignment.branchId ?? code.branchId
    if (branchId) {
      const branch = store.loadBranches().find((b) => b.id === branchId)
      if (!branch || branch.status !== 'ACTIVE') issues.push('BRANCH_INACTIVE')
    }
    const membership = store.loadMemberships().find((m) => m.id === assignment.membershipId)
    if (!membership || membership.status !== 'ACTIVE') issues.push('ASSIGNEE_NOT_ACTIVE')
    if (
      branchId &&
      !store
        .loadBranchAssignments()
        .some(
          (a) =>
            a.merchantId === code.merchantId &&
            a.membershipId === assignment.membershipId &&
            a.branchId === branchId &&
            a.status === 'ACTIVE',
        )
    ) {
      issues.push('ASSIGNEE_NOT_AT_BRANCH')
    }
    return issues
  }

  const heldBy = (merchantId: string, actor: Actor): Held[] =>
    assignments()
      .filter(
        (a) =>
          a.merchantId === merchantId &&
          a.validTo === null &&
          a.assigneeKind === 'MEMBER' &&
          a.membershipId === actor.membership.id,
      )
      .flatMap((assignment) => {
        const code = codes().find((c) => c.merchantId === merchantId && c.id === assignment.codeId)
        if (!code) return []
        const issues = issuesOf(code, assignment)
        const demonstrable =
          code.simulated &&
          ASSIGNABLE.includes(code.status) &&
          issues.every((i) => i === 'SIMULATED' || i === 'NOT_BANK_APPROVED')
        if (demonstrable) {
          return [{ code, assignment, mode: 'DEMONSTRATION', reason: null, refusal: null } as Held]
        }
        const liveOff = issues.length === 0
        return [
          {
            code,
            assignment,
            mode: 'UNAVAILABLE',
            reason: liveOff ? LIVE_OFF : 'This code is not eligible for billing right now.',
            refusal: liveOff ? 'live_collection_unavailable' : 'code_not_available',
          } as Held,
        ]
      })

  const branchOf = (held: Held) => {
    const id = held.assignment.branchId ?? held.code.branchId
    return id ? store.loadBranches().find((b) => b.id === id) : undefined
  }

  const choiceOf = (merchantId: string, actor: Actor, held: Held): CodeChoice => {
    const branch = branchOf(held)
    return {
      id: held.code.id,
      label: held.code.displayLabel,
      mode: held.mode,
      reason: held.reason,
      paymentReady:
        collectingProfile(merchantId, held.code, branch?.id ?? null, actor.user.id) !== undefined,
      branchName: branch?.name ?? held.assignment.branchName ?? null,
    }
  }

  const presentationOf = (sale: StoredCodeSale): CodePresentation => ({
    mode: sale.mode,
    label: sale.codeLabel,
    bankCode: null,
    demoReference: sale.codeInternalRef,
    notice: CODE_DEMO_NOTICE,
  })

  const requestOf = (sale: StoredCodeSale) => {
    const stored = ledger.paymentRequests.load().find((r) => r.id === sale.paymentRequestId)
    if (!stored) throw fail('not_found', 'This sale could not be found.')
    return resolvePaymentRequest(store, ledger, stored)
  }

  const saleDto = (sale: StoredCodeSale): CodeSale => {
    const { request, state: derived } = requestOf(sale)
    // A demonstration is not payable: whatever the (simulated) bank reported, it never shows money, a part payment or "paid".
    const closed = derived.status === 'EXPIRED' || derived.status === 'CANCELLED'
    const state = closed
      ? { ...derived, confirmedAmount: 0, amountDue: sale.amountRwf }
      : {
          status: 'AWAITING_PAYMENT' as const,
          stage: 'AWAITING_PAYMENT' as const,
          confirmedAmount: 0,
          amountDue: sale.amountRwf,
        }
    const invoice = store.loadInvoices().find((i) => i.id === sale.invoiceId)
    const merchant = merchantOf(sale.merchantId)
    return {
      saleId: sale.saleId,
      invoiceId: sale.invoiceId,
      invoiceNumber: invoice?.invoiceNumber ?? '',
      saleReference: request.publicReference,
      amountRwf: sale.amountRwf,
      currency: 'RWF',
      description: sale.description,
      status: state.status,
      stage: state.stage,
      confirmedAmount: state.confirmedAmount,
      amountDue: state.amountDue,
      expiresAt: request.expiresAt,
      createdAt: request.createdAt,
      merchantDisplayName: merchant?.tradingName?.trim() || merchant?.legalName || 'Business',
      branchName: sale.branchName,
      agentName: sale.agentName,
      code: presentationOf(sale),
    }
  }

  const fingerprintOf = (
    actor: Actor,
    input: CodeSaleInput,
    description: string,
    lines?: InvoiceItemInput[],
  ) =>
    JSON.stringify([
      actor.user.id,
      input.amountRwf,
      description,
      input.collectionCodeId ?? null,
      input.branchId ?? null,
      lines ?? null,
    ])

  /**
   * One bill. `lines` (mock-only, used by POS billing) makes it a MULTI-LINE invoice priced by the invoice service's own rules; without
   * it the invoice is the single amount-only line of code checkout.
   */
  const bill = async (
    merchantId: string,
    input: CodeSaleInput,
    lines?: InvoiceItemInput[],
  ): Promise<CodeSale> => {
    // Validation that needs no data runs first, like the server's.
    if (
      !Number.isInteger(input.amountRwf) ||
      input.amountRwf < CODE_CHECKOUT_MIN_AMOUNT_RWF ||
      input.amountRwf > CODE_CHECKOUT_MAX_AMOUNT_RWF
    ) {
      throw fail(
        'validation',
        `Enter a whole amount between RWF ${CODE_CHECKOUT_MIN_AMOUNT_RWF} and RWF ${CODE_CHECKOUT_MAX_AMOUNT_RWF}.`,
      )
    }
    const description = (input.description ?? '').trim()
    if (
      description.length > CODE_CHECKOUT_MAX_DESCRIPTION ||
      CONTROL_CHARACTERS.test(description)
    ) {
      throw fail(
        'validation',
        `The description can be at most ${CODE_CHECKOUT_MAX_DESCRIPTION} characters, on one line.`,
      )
    }
    if (input.idempotencyKey.length < 8) throw fail('validation', 'An Idempotency-Key is required.')
    const line = description || CODE_CHECKOUT_DEFAULT_DESCRIPTION

    // Every decision is taken before anything is created, so a refusal leaves nothing behind.
    const decision = await run(() => {
      const actor = actorFor(merchantId)
      const fingerprint = fingerprintOf(actor, input, line, lines)
      const forMerchant = sales().filter((s) => s.merchantId === merchantId)
      const keyed = forMerchant.find((s) => s.idempotencyKeys.includes(input.idempotencyKey))
      if (keyed && (keyed.fingerprint !== fingerprint || keyed.agentUserId !== actor.user.id)) {
        throw fail(
          'idempotency_key_reuse',
          'This Idempotency-Key was already used for a different request. Use a new key for a new request.',
        )
      }
      const known = forMerchant.find((s) => s.clientRequestId === input.clientRequestId)
      if (known) {
        if (known.fingerprint !== fingerprint || known.agentUserId !== actor.user.id) {
          throw fail(
            'client_request_id_reuse',
            'This request identifier was already used for a different sale.',
          )
        }
        // The original sale is returned from its own record, whatever the code's eligibility is today.
        return { kind: 'repeat' as const, sale: known }
      }
      const held = heldBy(merchantId, actor)
      if (held.length === 0) {
        throw fail(
          'no_assigned_code',
          'You are not assigned a collection code. Ask the business owner or a manager to assign you one.',
        )
      }
      let chosen: Held | undefined
      if (input.collectionCodeId) {
        chosen = held.find((h) => h.code.id === input.collectionCodeId)
        if (!chosen) throw fail('code_not_assigned', 'Choose one of the codes assigned to you.')
      } else if (held.length === 1) {
        chosen = held[0]
      }
      if (!chosen) {
        throw fail('code_required', 'Choose which of your codes you are billing through.')
      }
      if (chosen.mode !== 'DEMONSTRATION') {
        throw fail(chosen.refusal ?? 'code_not_available', chosen.reason ?? LIVE_OFF)
      }
      const branch = branchOf(chosen)
      if (!branch) {
        throw fail('no_eligible_branch', 'This code has no active branch, so you cannot bill yet.')
      }
      if (!collectingProfile(merchantId, chosen.code, branch.id, actor.user.id)) {
        throw fail(
          'no_active_profile',
          'There is no active payment link on this code’s settlement account. Create or switch one on in Payment links.',
        )
      }
      return {
        kind: 'new' as const,
        actor,
        chosen,
        branchId: branch.id,
        branchName: branch.name,
        fingerprint,
      }
    })

    if (decision.kind === 'repeat') {
      const { sale } = decision
      return run(() => {
        if (!sale.idempotencyKeys.includes(input.idempotencyKey)) {
          store.saveRecords<StoredCodeSale>(
            MOCK_STORAGE_KEYS.codeSales,
            sales().map((s) =>
              s.saleId === sale.saleId
                ? { ...s, idempotencyKeys: [...s.idempotencyKeys, input.idempotencyKey] }
                : s,
            ),
          )
        }
        return saleDto(sale)
      })
    }

    const draft = await invoiceService.createDraft(merchantId, {
      branchId: decision.branchId,
      assignedToUserId: decision.actor.user.id,
      customer: { name: WALK_IN_CUSTOMER_NAME },
      items: lines ?? [
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
    if (lines && issued.grandTotal !== input.amountRwf) {
      // The invoice engine computed something else than what was reviewed: nothing is billed (the draft is left a draft).
      throw fail(
        'validation',
        'The invoice could not be priced exactly as reviewed, so nothing was billed.',
      )
    }

    return run(() => {
      // Stamp where the sale came from (the server sets this; no screen or form can), then open the request.
      store.saveInvoices(
        store.loadInvoices().map((i) =>
          i.id === issued.id
            ? {
                ...i,
                saleChannel: 'CODE' as const,
                demonstration: true,
                // Its own series: DEMO-0001... never INV-.
                invoiceNumber: `DEMO-${String(
                  store.loadInvoices().filter((c) => c.merchantId === merchantId && c.demonstration)
                    .length + 1,
                ).padStart(4, '0')}`,
              }
            : i,
        ),
      )
      const profile = collectingProfile(
        merchantId,
        decision.chosen.code,
        decision.branchId,
        decision.actor.user.id,
      )
      if (!profile) {
        throw fail('no_active_profile', 'There is no active payment link for this sale.')
      }
      const now = new Date()
      const requestId = newId('pr')
      ledger.paymentRequests.save([
        ...ledger.paymentRequests.load(),
        {
          id: requestId,
          merchantId,
          paymentProfileId: profile.id,
          invoiceId: issued.id,
          requestedAmount: issued.grandTotal,
          currency: 'RWF',
          publicReference: newUniquePaymentReference(ledger),
          expiresAt: new Date(
            now.getTime() + CODE_CHECKOUT_LIFETIME_MINUTES * 60_000,
          ).toISOString(),
          createdAt: now.toISOString(),
          updatedAt: now.toISOString(),
        },
      ])
      const stored: StoredCodeSale = {
        saleId: requestId,
        merchantId,
        clientRequestId: input.clientRequestId,
        idempotencyKeys: [input.idempotencyKey],
        fingerprint: decision.fingerprint,
        agentUserId: decision.actor.user.id,
        agentName: decision.actor.user.fullName,
        invoiceId: issued.id,
        paymentRequestId: requestId,
        branchId: decision.branchId,
        branchName: decision.branchName,
        description: line,
        amountRwf: input.amountRwf,
        mode: 'DEMONSTRATION',
        codeId: decision.chosen.code.id,
        codeLabel: decision.chosen.code.displayLabel,
        codeInternalRef: decision.chosen.code.internalRef,
        assignmentId: decision.chosen.assignment.id,
      }
      store.saveRecords<StoredCodeSale>(MOCK_STORAGE_KEYS.codeSales, [...sales(), stored])
      return saleDto(stored)
    })
  }

  return {
    codeCheckoutService: {
      getCodeCheckoutOptions: (merchantId) =>
        run<CodeCheckoutOptions>(() => {
          const actor = actorFor(merchantId)
          const choices = heldBy(merchantId, actor).map((h) => choiceOf(merchantId, actor, h))
          let readiness: CodeCheckoutReadiness = 'READY'
          if (choices.length === 0) readiness = 'NO_ASSIGNED_CODE'
          else if (choices.every((c) => c.mode === 'UNAVAILABLE')) readiness = 'CODE_NOT_AVAILABLE'
          else if (choices.every((c) => c.mode === 'UNAVAILABLE' || !c.paymentReady)) {
            readiness = 'NO_PAYMENT_LINK'
          }
          return {
            readiness,
            codes: choices,
            minAmountRwf: CODE_CHECKOUT_MIN_AMOUNT_RWF,
            maxAmountRwf: CODE_CHECKOUT_MAX_AMOUNT_RWF,
            paymentLifetimeMinutes: CODE_CHECKOUT_LIFETIME_MINUTES,
            liveCollectionEnabled: false,
            note: null,
          }
        }),

      billCodeSale: (merchantId, input) => bill(merchantId, input),

      getCodeSale: (merchantId, saleId) =>
        run(() => {
          const actor = actorFor(merchantId)
          const sale = sales().find((s) => s.merchantId === merchantId && s.saleId === saleId)
          // The agent who billed it, and anyone who manages billing: nobody else sees another agent's sale.
          const mayManage =
            hasPermission(actor.membership.role, 'invoices:view') &&
            actor.membership.role !== 'CASHIER'
          if (!sale || (sale.agentUserId !== actor.user.id && !mayManage)) {
            throw fail('not_found', 'This sale could not be found.')
          }
          return saleDto(sale)
        }),
    },

    billCart: (merchantId, input) => bill(merchantId, input, input.lines),
    publicCodeSaleService: {
      getPublicCodeSale: (reference) =>
        run((): PublicCodeSale => {
          const request = ledger.paymentRequests.load().find((r) => r.publicReference === reference)
          const sale = request ? sales().find((s) => s.paymentRequestId === request.id) : undefined
          if (!sale) throw fail('not_found', 'This payment page could not be found.')
          const dto = saleDto(sale)
          const status = customerStatusOf(dto.status, dto.stage)
          return {
            merchantDisplayName: dto.merchantDisplayName,
            saleReference: dto.saleReference,
            amountRwf: dto.amountRwf,
            currency: 'RWF',
            description: dto.description,
            status,
            confirmedAmount: dto.confirmedAmount,
            amountDue: dto.amountDue,
            expiresAt: dto.expiresAt,
            // The customer never sees OuPay's internal code reference.
            code: { ...dto.code, demoReference: null },
            // A demonstration shows no instructions: nothing can be paid, and none are invented.
            instructions: [],
            statusNote:
              status === 'AWAITING_PAYMENT'
                ? 'Nothing can be paid: this is a demonstration with a simulated code.'
                : status === 'PAID'
                  ? 'The bank has confirmed this payment and it has been applied to this sale.'
                  : status === 'PARTIALLY_PAID'
                    ? 'The bank has confirmed part of the amount. The rest is still due.'
                    : status === 'REQUIRES_RECONCILIATION'
                      ? 'The bank reported a payment that is not yet matched to this sale. The business will review it.'
                      : status === 'EXPIRED'
                        ? 'This request has expired.'
                        : 'This request was cancelled.',
          }
        }),
    },
  }
}
