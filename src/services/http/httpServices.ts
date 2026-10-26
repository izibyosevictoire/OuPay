import type { AuthService } from '@/services/authService'
import { AuthServiceError, type AuthServiceErrorCode } from '@/services/authService'
import type { BankingConfigurationService } from '@/services/bankingService'
import type { BranchService } from '@/services/branchService'
import {
  CatalogServiceError,
  type CatalogService,
  type CatalogServiceErrorCode,
} from '@/services/catalogService'
import {
  CheckoutServiceError,
  type CheckoutService,
  type CheckoutServiceErrorCode,
} from '@/services/checkoutService'
import type { DashboardService } from '@/services/dashboardService'
import { InvoiceServiceError, type InvoiceService } from '@/services/invoiceService'
import { MerchantServiceError, type MerchantService } from '@/services/merchantService'
import type { NotificationService } from '@/services/notificationService'
import { OrganizationServiceError } from '@/services/organizationService'
import { PaymentServiceError, type PaymentServiceErrorCode } from '@/services/paymentServiceError'
import type { PaymentProfileService } from '@/services/paymentProfileService'
import type { PublicPaymentService } from '@/services/publicPaymentService'
import type { ReconciliationService } from '@/services/reconciliationService'
import type { StaffService } from '@/services/staffService'
import type { AuthSession } from '@/types/auth'
import type { CatalogItem, CatalogPackage, PriceVersion } from '@/types/catalog'
import type { InvoicePage } from '@/types/invoice'
import { mapHttpError, translating } from './errorMapping'
import type { ReportsService } from '@/services/reportsService'
import type { HttpClient } from './httpClient'

const AUTH_CODES: AuthServiceErrorCode[] = [
  'invalid_credentials',
  'account_unavailable',
  'email_taken',
  'session_expired',
  'invalid_token',
  'expired_token',
  'validation',
  'rate_limited',
  'invalid_invitation',
  'invitation_email_mismatch',
  'service_unavailable',
]
const MERCHANT_CODES = [
  'not_found',
  'duplicate_tin',
  'duplicate_registration_number',
  'profile_locked',
  'version_conflict',
  'unauthenticated',
  'forbidden',
  'service_unavailable',
]
const ORGANIZATION_CODES = [
  'unauthenticated',
  'not_found',
  'forbidden',
  'duplicate_branch_code',
  'branch_inactive',
  'duplicate_assignment',
  'membership_not_active',
  'invalid_transition',
  'last_owner',
  'self_escalation',
  'duplicate_invitation',
  'invalid_invitation',
  'invitation_email_mismatch',
  'validation',
  'service_unavailable',
]
const INVOICE_CODES = [
  'unauthenticated',
  'not_found',
  'forbidden',
  'validation',
  'branch_inactive',
  'assignee_not_eligible',
  'invalid_transition',
  'void_not_allowed',
  'version_conflict',
  'service_unavailable',
]
const PAYMENT_CODES: PaymentServiceErrorCode[] = [
  'unauthenticated',
  'not_found',
  'forbidden',
  'validation',
  'allocation_conflict',
  'transaction_not_confirmed',
  'invoice_not_payable',
  'exceeds_remaining',
  'exceeds_unapplied',
  'allocation_not_active',
  'not_supported',
  'invalid_state',
  'profile_unavailable',
  'request_unavailable',
  'no_active_profile',
  'service_unavailable',
]

const CHECKOUT_CODES: CheckoutServiceErrorCode[] = [
  'unauthenticated',
  'not_found',
  'forbidden',
  'validation',
  'checkout_not_available',
  'no_eligible_branch',
  'branch_required',
  'branch_not_eligible',
  'branch_inactive',
  'assignee_not_eligible',
  'no_active_profile',
  'client_request_id_reuse',
  'idempotency_key_reuse',
  'request_in_progress',
  'service_unavailable',
]

const CATALOG_CODES: CatalogServiceErrorCode[] = [
  'unauthenticated',
  'not_found',
  'forbidden',
  'validation',
  'invalid_unit_configuration',
  'unsupported_unit',
  'dimension_mismatch',
  'invalid_quantity',
  'invalid_count',
  'precision_exceeded',
  'quantity_out_of_range',
  'invalid_package_conversion',
  'duplicate_code',
  'duplicate_label',
  'version_conflict',
  'catalog_unavailable',
  'service_unavailable',
]

const authError = (error: unknown) =>
  mapHttpError(error, (code, message) => new AuthServiceError(code, message), AUTH_CODES)
const merchantError = (error: unknown) =>
  mapHttpError(error, (code, message) => new MerchantServiceError(code, message), MERCHANT_CODES)
const organizationError = (error: unknown) =>
  mapHttpError(
    error,
    (code, message) => new OrganizationServiceError(code, message),
    ORGANIZATION_CODES,
  )
const invoiceError = (error: unknown) =>
  mapHttpError(error, (code, message) => new InvoiceServiceError(code, message), INVOICE_CODES)
const checkoutError = (error: unknown) =>
  mapHttpError(error, (code, message) => new CheckoutServiceError(code, message), CHECKOUT_CODES)
/** The server omits null fields from its JSON, so a missing field means null. Normalised once, here. */
type Nullable<T, K extends keyof T> = Omit<T, K> & { [P in K]?: T[P] | null }
type RawCatalogItem = Omit<Nullable<CatalogItem, 'description' | 'code' | 'stockUnit'>, 'packages'> & {
  packages?: CatalogPackage[]
}
type RawPriceVersion = Nullable<PriceVersion, 'reason'>
interface RawCatalogPage {
  items?: RawCatalogItem[]
  nextCursor?: string | null
  totalCount?: number | null
}
const normaliseCatalogItem = (raw: RawCatalogItem): CatalogItem => ({
  ...raw,
  description: raw.description ?? null,
  code: raw.code ?? null,
  stockUnit: raw.stockUnit ?? null,
  packages: raw.packages ?? [],
})

const catalogError = (error: unknown) =>
  mapHttpError(error, (code, message) => new CatalogServiceError(code, message), CATALOG_CODES)
const paymentError = (error: unknown) =>
  mapHttpError(error, (code, message) => new PaymentServiceError(code, message), PAYMENT_CODES)

const m = (merchantId: string) => `/merchants/${merchantId}`

interface PageEnvelope<T> {
  items: T[]
  nextCursor?: string | null
  totalCount?: number
}

const PAGE_SIZE = 200
const MAX_PAGES = 500

/**
 * The server paginates every high-volume list with deterministic keyset pages (see docs/backend.md). The
 * service contracts still return whole lists, so this follows the cursor until it runs out: the UI sees
 * exactly what it saw before, while no single response is ever unbounded.
 */
async function fetchAllPages<T>(http: HttpClient, path: string): Promise<T[]> {
  const items: T[] = []
  let cursor: string | undefined
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const result = await http.get<PageEnvelope<T>>(path, { query: { limit: PAGE_SIZE, cursor } })
    items.push(...result.items)
    if (!result.nextCursor) return items
    cursor = result.nextCursor
  }
  throw new Error(`The list at ${path} has more than ${MAX_PAGES * PAGE_SIZE} items.`)
}

export function createHttpAuthService(http: HttpClient): AuthService {
  return {
    register: translating(
      (input) => http.post<AuthSession>('/auth/register', { body: input }),
      authError,
    ),
    login: translating(
      (credentials, options) =>
        http.post<AuthSession>('/auth/login', {
          body: { ...credentials, rememberMe: options.rememberMe },
        }),
      authError,
    ),
    logout: translating(() => http.post<void>('/auth/logout'), authError),
    // The server answers 204 when there is no (valid) session.
    getCurrentSession: translating(
      async () => (await http.get<AuthSession | undefined>('/auth/session')) ?? null,
      authError,
    ),
    // Always 204, whether or not the account exists. The link in the e-mail carries the token.
    requestPasswordReset: translating(
      (email) => http.post<void>('/auth/password-reset/request', { body: { email } }),
      authError,
    ),
    // POST with a body, not GET: the token must not end up in a URL or an access log.
    verifyPasswordResetToken: translating(
      (token) => http.post<void>('/auth/password-reset/verify', { body: { token } }),
      authError,
    ),
    resetPassword: translating(
      ({ token, newPassword }) =>
        http.post<void>('/auth/password-reset/confirm', { body: { token, newPassword } }),
      authError,
    ),
    changePassword: translating(
      (input) => http.post<void>('/auth/password/change', { body: input }),
      authError,
    ),
    requestEmailVerification: translating(
      () => http.post<void>('/auth/email-verification/request'),
      authError,
    ),
    confirmEmailVerification: translating(
      (token) => http.post<void>('/auth/email-verification/confirm', { body: { token } }),
      authError,
    ),
  }
}

export function createHttpMerchantService(http: HttpClient): MerchantService {
  return {
    createMerchant: translating((input) => http.post('/merchants', { body: input }), merchantError),
    getMerchantById: translating((id) => http.get(`/merchants/${id}`), merchantError),
    updateMerchant: translating(
      (id, changes) => http.put(`/merchants/${id}`, { body: changes }),
      merchantError,
    ),
    listMerchantsForCurrentUser: translating(() => http.get('/merchants'), merchantError),
    getMerchantSettings: translating((id) => http.get(`${m(id)}/settings`), merchantError),
    updateMerchantSettings: translating(
      (id, changes) => http.put(`${m(id)}/settings`, { body: changes }),
      merchantError,
    ),
  }
}

export function createHttpBranchService(http: HttpClient): BranchService {
  return {
    listBranches: translating((id) => http.get(`${m(id)}/branches`), organizationError),
    getBranch: translating(
      (id, branchId) => http.get(`${m(id)}/branches/${branchId}`),
      organizationError,
    ),
    createBranch: translating(
      (id, input) => http.post(`${m(id)}/branches`, { body: input }),
      organizationError,
    ),
    updateBranch: translating(
      (id, branchId, input) => http.put(`${m(id)}/branches/${branchId}`, { body: input }),
      organizationError,
    ),
    changeBranchStatus: translating(
      (id, branchId, status) =>
        http.put(`${m(id)}/branches/${branchId}/status`, { body: { status } }),
      organizationError,
    ),
    listBranchAssignments: translating(
      (id, filter) => http.get(`${m(id)}/branch-assignments`, { query: filter }),
      organizationError,
    ),
    updateBranchAssignments: translating(
      (id, membershipId, branchIds) =>
        http.put(`${m(id)}/memberships/${membershipId}/branch-assignments`, {
          body: { branchIds },
        }),
      organizationError,
    ),
  }
}

export function createHttpStaffService(http: HttpClient): StaffService {
  return {
    listStaff: translating((id) => http.get(`${m(id)}/staff`), organizationError),
    // The server e-mails the single-use link; the response never contains a token.
    inviteStaff: translating(
      (id, input) => http.post(`${m(id)}/invitations`, { body: input }),
      organizationError,
    ),
    listInvitations: translating((id) => http.get(`${m(id)}/invitations`), organizationError),
    getInvitationPreview: translating(
      (token) => http.get(`/public/invitations/${encodeURIComponent(token)}`),
      organizationError,
    ),
    acceptInvitation: translating(
      (token) => http.post(`/invitations/${encodeURIComponent(token)}/accept`),
      organizationError,
    ),
    updateMembershipRole: translating(
      (id, membershipId, role) =>
        http.put(`${m(id)}/memberships/${membershipId}/role`, { body: { role } }),
      organizationError,
    ),
    suspendMembership: translating(
      (id, membershipId) => http.post(`${m(id)}/memberships/${membershipId}/suspend`),
      organizationError,
    ),
    reactivateMembership: translating(
      (id, membershipId) => http.post(`${m(id)}/memberships/${membershipId}/reactivate`),
      organizationError,
    ),
    revokeMembership: translating(
      (id, membershipId) => http.post(`${m(id)}/memberships/${membershipId}/revoke`),
      organizationError,
    ),
  }
}

export function createHttpInvoiceService(http: HttpClient): InvoiceService {
  return {
    listInvoices: translating(async (id, request) => {
      // An explicit limit asks for exactly one page. Without one the caller wants everything: follow the cursor.
      if (request?.limit !== undefined || request?.cursor !== undefined) {
        return http.get<InvoicePage>(`${m(id)}/invoices`, {
          query: { limit: request.limit, cursor: request.cursor },
        })
      }
      const items = await fetchAllPages<InvoicePage['items'][number]>(http, `${m(id)}/invoices`)
      return { items, totalCount: items.length, nextCursor: null }
    }, invoiceError),
    getInvoice: translating(
      (id, invoiceId) => http.get(`${m(id)}/invoices/${invoiceId}`),
      invoiceError,
    ),
    getInvoiceFormOptions: translating(
      (id) => http.get(`${m(id)}/invoices/form-options`),
      invoiceError,
    ),
    createDraft: translating(
      (id, input) => http.post(`${m(id)}/invoices`, { body: input }),
      invoiceError,
    ),
    updateDraft: translating(
      (id, invoiceId, input, expectedVersion) =>
        http.put(`${m(id)}/invoices/${invoiceId}`, { body: input, query: { expectedVersion } }),
      invoiceError,
    ),
    issueInvoice: translating(
      (id, invoiceId, expectedVersion) =>
        http.post(`${m(id)}/invoices/${invoiceId}/issue`, { query: { expectedVersion } }),
      invoiceError,
    ),
    cancelDraft: translating(
      (id, invoiceId, expectedVersion) =>
        http.post(`${m(id)}/invoices/${invoiceId}/cancel`, { query: { expectedVersion } }),
      invoiceError,
    ),
    voidInvoice: translating(
      (id, invoiceId, input, expectedVersion) =>
        http.post(`${m(id)}/invoices/${invoiceId}/void`, {
          body: input,
          query: { expectedVersion },
        }),
      invoiceError,
    ),
  }
}

export function createHttpDashboardService(http: HttpClient): DashboardService {
  // The dashboard has no dedicated error type; failures surface as the payment error shape.
  return {
    getSummary: translating(
      ({ merchantId }) => http.get(`${m(merchantId)}/dashboard/summary`),
      paymentError,
    ),
    getRecentTransactions: translating(
      ({ merchantId }, limit) =>
        http.get(`${m(merchantId)}/dashboard/recent-transactions`, { query: { limit } }),
      paymentError,
    ),
    getDailyPaymentActivity: translating(
      ({ merchantId }) => http.get(`${m(merchantId)}/dashboard/daily-payment-activity`),
      paymentError,
    ),
    getProviderBreakdown: translating(
      ({ merchantId }) => http.get(`${m(merchantId)}/dashboard/provider-breakdown`),
      paymentError,
    ),
  }
}

export function createHttpReconciliationService(http: HttpClient): ReconciliationService {
  return {
    listBankTransactions: translating(
      (id) => fetchAllPages(http, `${m(id)}/bank-transactions`),
      paymentError,
    ),
    getBankTransaction: translating(
      (id, transactionId) => http.get(`${m(id)}/bank-transactions/${transactionId}`),
      paymentError,
    ),
    listAllocations: translating(
      (id) => fetchAllPages(http, `${m(id)}/payment-allocations`),
      paymentError,
    ),
    listPayableInvoices: translating((id) => http.get(`${m(id)}/payable-invoices`), paymentError),
    allocateManually: translating(
      (id, input) => http.post(`${m(id)}/reconciliation/allocations`, { body: input }),
      paymentError,
    ),
    reverseAllocation: translating(
      (id, allocationId, input) =>
        http.post(`${m(id)}/reconciliation/allocations/${allocationId}/reverse`, { body: input }),
      paymentError,
    ),
    markReviewed: translating(
      (id, transactionId, input) =>
        http.post(`${m(id)}/bank-transactions/${transactionId}/review`, { body: input }),
      paymentError,
    ),
  }
}

export function createHttpNotificationService(http: HttpClient): NotificationService {
  return {
    listNotifications: translating(
      (id) => fetchAllPages(http, `${m(id)}/notifications`),
      paymentError,
    ),
    markAsRead: translating(
      (id, notificationId) => http.post(`${m(id)}/notifications/${notificationId}/read`),
      paymentError,
    ),
    markAllAsRead: translating((id) => http.post(`${m(id)}/notifications/read-all`), paymentError),
  }
}

export function createHttpBankingService(http: HttpClient): BankingConfigurationService {
  return {
    listProviders: translating(() => http.get('/banking/providers'), paymentError),
    listConnections: translating((id) => http.get(`${m(id)}/bank-connections`), paymentError),
    listPaymentDestinations: translating(
      (id) => http.get(`${m(id)}/payment-destinations`),
      paymentError,
    ),
    startAccountLink: translating(
      (id, request) => http.post(`${m(id)}/bank-connections`, { body: request }),
      paymentError,
    ),
    completeAccountLink: translating(
      (id, connectionId) => http.post(`${m(id)}/bank-connections/${connectionId}/complete`),
      paymentError,
    ),
    disableConnection: translating(
      (id, connectionId) => http.post(`${m(id)}/bank-connections/${connectionId}/disable`),
      paymentError,
    ),
  }
}

export function createHttpPaymentProfileService(http: HttpClient): PaymentProfileService {
  return {
    listProfiles: translating((id) => http.get(`${m(id)}/payment-profiles`), paymentError),
    getProfile: translating(
      (id, profileId) => http.get(`${m(id)}/payment-profiles/${profileId}`),
      paymentError,
    ),
    getFormOptions: translating(
      (id) => http.get(`${m(id)}/payment-profiles/form-options`),
      paymentError,
    ),
    createProfile: translating(
      (id, input) => http.post(`${m(id)}/payment-profiles`, { body: input }),
      paymentError,
    ),
    setProfileActive: translating(
      (id, profileId, isActive) =>
        http.put(`${m(id)}/payment-profiles/${profileId}/active`, { body: { isActive } }),
      paymentError,
    ),
    reissueProfile: translating(
      (id, profileId) => http.post(`${m(id)}/payment-profiles/${profileId}/reissue`),
      paymentError,
    ),
    createInvoicePaymentRequest: translating(
      (id, invoiceId) => http.post(`${m(id)}/invoices/${invoiceId}/payment-requests`),
      paymentError,
    ),
    listInvoicePaymentRequests: translating(
      (id, invoiceId) => http.get(`${m(id)}/invoices/${invoiceId}/payment-requests`),
      paymentError,
    ),
    cancelPaymentRequest: translating(
      (id, requestId) => http.post(`${m(id)}/payment-requests/${requestId}/cancel`),
      paymentError,
    ),
  }
}

/**
 * Simplified checkout. The sale's permanent identifier travels in the body and the retry key in the
 * Idempotency-Key header; the amount goes as a JSON number and the server decides everything else.
 */
export function createHttpCheckoutService(http: HttpClient): CheckoutService {
  return {
    getSimpleCheckoutOptions: translating(
      (id) => http.get(`${m(id)}/checkout/simple/options`),
      checkoutError,
    ),
    billSimpleCheckout: translating(
      (id, input) =>
        http.post(`${m(id)}/checkout/simple`, {
          headers: { 'Idempotency-Key': input.idempotencyKey },
          body: {
            amountRwf: input.amountRwf,
            description: input.description,
            branchId: input.branchId,
            clientRequestId: input.clientRequestId,
          },
        }),
      checkoutError,
    ),
  }
}

/**
 * The goods-and-services catalog. Decimals travel as plain text and prices as whole-RWF JSON numbers; merchant identity is
 * only ever the path, never the body. Versions are sent in the body (`expectedVersion`) for optimistic locking.
 */
export function createHttpCatalogService(http: HttpClient): CatalogService {
  const base = (merchantId: string) => `${m(merchantId)}/catalog`
  const itemPath = (merchantId: string, itemId: string) => `${base(merchantId)}/items/${itemId}`
  return {
    listMeasurementUnits: translating(
      (id) => http.get(`${base(id)}/measurement-units`),
      catalogError,
    ),
    listItems: translating(async (id, query) => {
      const page = await http.get<RawCatalogPage>(`${base(id)}/items`, {
        query: {
          limit: query?.limit,
          cursor: query?.cursor,
          q: query?.q?.trim() || undefined,
          type: query?.type,
          active: query?.active,
        },
      })
      return {
        items: (page.items ?? []).map(normaliseCatalogItem),
        nextCursor: page.nextCursor ?? null,
        totalCount: page.totalCount ?? null,
      }
    }, catalogError),
    getItem: translating(
      async (id, itemId) =>
        normaliseCatalogItem(await http.get<RawCatalogItem>(itemPath(id, itemId))),
      catalogError,
    ),
    createItem: translating(
      async (id, input) =>
        normaliseCatalogItem(await http.post<RawCatalogItem>(`${base(id)}/items`, { body: input })),
      catalogError,
    ),
    updateItem: translating(
      async (id, itemId, input) =>
        normaliseCatalogItem(
          await http.put<RawCatalogItem>(itemPath(id, itemId), { body: input }),
        ),
      catalogError,
    ),
    changeItemStatus: translating(
      async (id, itemId, input) =>
        normaliseCatalogItem(
          await http.put<RawCatalogItem>(`${itemPath(id, itemId)}/status`, { body: input }),
        ),
      catalogError,
    ),
    listPriceHistory: translating(async (id, itemId) => {
      const versions = await http.get<RawPriceVersion[]>(`${itemPath(id, itemId)}/price-history`)
      return versions.map((v) => ({ ...v, reason: v.reason ?? null }))
    }, catalogError),
    createPackage: translating(
      (id, itemId, input) => http.post(`${itemPath(id, itemId)}/packages`, { body: input }),
      catalogError,
    ),
    updatePackage: translating(
      (id, itemId, packageId, input) =>
        http.put(`${itemPath(id, itemId)}/packages/${packageId}`, { body: input }),
      catalogError,
    ),
  }
}

/** Anonymous customer pages: only public tokens, no merchant context, no session. */
export function createHttpPublicPaymentService(http: HttpClient): PublicPaymentService {
  const base = '/public/payment-profiles'
  return {
    getProfile: translating((token) => http.get(`${base}/${token}`), paymentError),
    createOpenRequest: translating(
      (token, amountInRwf) =>
        http.post(`${base}/${token}/requests`, { body: { amount: amountInRwf } }),
      paymentError,
    ),
    getRequest: translating(
      (token, reference) => http.get(`${base}/${token}/requests/${reference}`),
      paymentError,
    ),
    markInstructionsOpened: translating(
      (token, reference) => http.post(`${base}/${token}/requests/${reference}/instructions-opened`),
      paymentError,
    ),
    claimPaymentInitiated: translating(
      (token, reference) => http.post(`${base}/${token}/requests/${reference}/claim`),
      paymentError,
    ),
  }
}


export function createHttpReportsService(http: HttpClient): ReportsService {
  return {
    getSummary: (merchantId, range) =>
      http.get(`/merchants/${merchantId}/reports/summary`, {
        query: { from: range.from, to: range.to },
      }),
  }
}
