import { vi } from 'vitest'
import {
  authService,
  bankingService,
  bankSimulator,
  branchService,
  catalogService,
  checkoutService,
  inventoryService,
  collectionCodeService,
  notificationService,
  paymentProfileService,
  publicPaymentService,
  reconciliationService,
  dashboardService,
  invoiceService,
  merchantService,
  staffService,
} from '@/services'
import { createMockAuthService } from '@/services/mock/mockAuthService'
import { createMemoryStorage, createMockAuthStore } from '@/services/mock/mockAuthStore'
import { createMockBankingService } from '@/services/mock/mockBankingService'
import { createMockBankSimulator } from '@/services/mock/mockBankSimulator'
import { createMockBranchService } from '@/services/mock/mockBranchService'
import { createMockCatalogService } from '@/services/mock/mockCatalogService'
import { createMockCheckoutService } from '@/services/mock/mockCheckoutService'
import { createMockCollectionCodeService } from '@/services/mock/mockCollectionCodeService'
import { createMockInventoryService } from '@/services/mock/mockInventoryService'
import { createBankEventProcessor } from '@/services/mock/ledger/bankEventProcessor'
import { createLedgerStore } from '@/services/mock/ledger/mockLedgerStore'
import { createMockNotificationService } from '@/services/mock/mockNotificationService'
import { createMockPaymentProfileService } from '@/services/mock/mockPaymentProfileService'
import { createMockPublicPaymentService } from '@/services/mock/mockPublicPaymentService'
import { createMockReconciliationService } from '@/services/mock/mockReconciliationService'
import { createMockDashboardService } from '@/services/mock/mockDashboardService'
import { createMockInvoiceService } from '@/services/mock/mockInvoiceService'
import { createMockMerchantService } from '@/services/mock/mockMerchantService'
import { createMockStaffService } from '@/services/mock/mockStaffService'
import { DEMO_USER_IDS } from '@/services/mock/sampleAccounts'

export { createMemoryStorage }

export type DemoUserKey = keyof typeof DEMO_USER_IDS

/** A zero-latency, in-memory backend: every mock service sharing one store. */
export function createTestBackend() {
  const store = createMockAuthStore({
    persistentStorage: createMemoryStorage(),
    sessionStorage: createMemoryStorage(),
  })
  const merchantStorage = createMemoryStorage()
  const fastAuth = createMockAuthService({ store, delayInMilliseconds: 0 })
  const fastMerchants = createMockMerchantService({
    storage: merchantStorage,
    authStore: store,
    delayInMilliseconds: 0,
  })
  const fastBranches = createMockBranchService({ authStore: store, delayInMilliseconds: 0 })
  const fastStaff = createMockStaffService({
    authStore: store,
    merchantStorage,
    delayInMilliseconds: 0,
  })
  const ledger = createLedgerStore(store)
  const fastDashboard = createMockDashboardService({ authStore: store, ledger })
  const fastInvoices = createMockInvoiceService({
    authStore: store,
    ledger,
    merchantStorage,
    delayInMilliseconds: 0,
  })
  const fastCheckout = createMockCheckoutService({
    authStore: store,
    ledger,
    invoiceService: fastInvoices,
    merchantStorage,
    delayInMilliseconds: 0,
  })
  const fastCatalog = createMockCatalogService({
    authStore: store,
    merchantStorage,
    delayInMilliseconds: 0,
  })
  const fastInventory = createMockInventoryService({
    authStore: store,
    merchantStorage,
    delayInMilliseconds: 0,
  })
  const fastCollectionCodes = createMockCollectionCodeService({
    authStore: store,
    delayInMilliseconds: 0,
  })
  const fastReconciliation = createMockReconciliationService({
    authStore: store,
    ledger,
    delayInMilliseconds: 0,
  })
  const fastNotifications = createMockNotificationService({
    authStore: store,
    ledger,
    delayInMilliseconds: 0,
  })
  const fastBanking = createMockBankingService({ authStore: store, ledger, delayInMilliseconds: 0 })
  const fastProfiles = createMockPaymentProfileService({
    authStore: store,
    ledger,
    merchantStorage,
    delayInMilliseconds: 0,
  })
  const fastPublic = createMockPublicPaymentService({
    authStore: store,
    ledger,
    merchantStorage,
    delayInMilliseconds: 0,
  })
  const fastSimulator = createMockBankSimulator({
    authStore: store,
    ledger,
    delayInMilliseconds: 0,
  })
  // For tests that need to feed a raw event straight to the trusted processor.
  const processor = createBankEventProcessor(store, ledger)
  return {
    store,
    ledger,
    merchantStorage,
    processor,
    fastReconciliation,
    fastNotifications,
    fastBanking,
    fastProfiles,
    fastPublic,
    fastSimulator,
    fastDashboard,
    fastInvoices,
    fastCheckout,
    fastCatalog,
    fastInventory,
    fastCollectionCodes,
    fastAuth,
    fastMerchants,
    fastBranches,
    fastStaff,
    signInAs: (user: DemoUserKey, lifetimeInMilliseconds = 60 * 60 * 1000) =>
      store.startSession(DEMO_USER_IDS[user], false, lifetimeInMilliseconds),
  }
}

type TestBackend = ReturnType<typeof createTestBackend>

/** Spies every method of a singleton service so it delegates to the zero-latency copy. */
function delegateAll<T extends object>(singleton: T, fast: T) {
  for (const key of Object.keys(singleton) as (keyof T)[]) {
    if (typeof singleton[key] !== 'function') continue
    vi.spyOn(singleton, key as never).mockImplementation(((...args: unknown[]) =>
      (fast[key] as (...inner: unknown[]) => unknown)(...args)) as never)
  }
}
let activeBackend: TestBackend | null = null

export function getActiveTestBackend(): TestBackend {
  if (!activeBackend) throw new Error('Call useFastBackend() in a beforeEach first.')
  return activeBackend
}

/**
 * Points the app's singleton services at a fresh in-memory backend so UI tests run quickly
 * and never share state. Every method is spied (delegating to the fast copy), so tests can
 * assert calls or override one with mockRejectedValueOnce. Pair with vi.restoreAllMocks().
 */
export function useFastBackend() {
  const backend = createTestBackend()
  activeBackend = backend
  const { fastAuth, fastMerchants, fastBranches, fastStaff, fastDashboard, fastInvoices } = backend
  delegateAll(reconciliationService, backend.fastReconciliation)
  delegateAll(notificationService, backend.fastNotifications)
  delegateAll(bankingService, backend.fastBanking)
  delegateAll(paymentProfileService, backend.fastProfiles)
  delegateAll(checkoutService, backend.fastCheckout)
  delegateAll(catalogService, backend.fastCatalog)
  delegateAll(inventoryService, backend.fastInventory)
  delegateAll(collectionCodeService, backend.fastCollectionCodes)
  delegateAll(publicPaymentService, backend.fastPublic)
  if (bankSimulator) delegateAll(bankSimulator, backend.fastSimulator)
  return {
    ...backend,
    getDashboardSummary: vi
      .spyOn(dashboardService, 'getSummary')
      .mockImplementation(fastDashboard.getSummary),
    getRecentTransactions: vi
      .spyOn(dashboardService, 'getRecentTransactions')
      .mockImplementation(fastDashboard.getRecentTransactions),
    getDailyPaymentActivity: vi
      .spyOn(dashboardService, 'getDailyPaymentActivity')
      .mockImplementation(fastDashboard.getDailyPaymentActivity),
    getProviderBreakdown: vi
      .spyOn(dashboardService, 'getProviderBreakdown')
      .mockImplementation(fastDashboard.getProviderBreakdown),
    listInvoices: vi
      .spyOn(invoiceService, 'listInvoices')
      .mockImplementation(fastInvoices.listInvoices),
    getInvoice: vi.spyOn(invoiceService, 'getInvoice').mockImplementation(fastInvoices.getInvoice),
    getInvoiceFormOptions: vi
      .spyOn(invoiceService, 'getInvoiceFormOptions')
      .mockImplementation(fastInvoices.getInvoiceFormOptions),
    createDraft: vi
      .spyOn(invoiceService, 'createDraft')
      .mockImplementation(fastInvoices.createDraft),
    updateDraft: vi
      .spyOn(invoiceService, 'updateDraft')
      .mockImplementation(fastInvoices.updateDraft),
    issueInvoice: vi
      .spyOn(invoiceService, 'issueInvoice')
      .mockImplementation(fastInvoices.issueInvoice),
    cancelDraft: vi
      .spyOn(invoiceService, 'cancelDraft')
      .mockImplementation(fastInvoices.cancelDraft),
    voidInvoice: vi
      .spyOn(invoiceService, 'voidInvoice')
      .mockImplementation(fastInvoices.voidInvoice),
    createMerchant: vi
      .spyOn(merchantService, 'createMerchant')
      .mockImplementation(fastMerchants.createMerchant),
    getMerchantById: vi
      .spyOn(merchantService, 'getMerchantById')
      .mockImplementation(fastMerchants.getMerchantById),
    updateMerchant: vi
      .spyOn(merchantService, 'updateMerchant')
      .mockImplementation(fastMerchants.updateMerchant),
    listMerchants: vi
      .spyOn(merchantService, 'listMerchantsForCurrentUser')
      .mockImplementation(fastMerchants.listMerchantsForCurrentUser),
    getMerchantSettings: vi
      .spyOn(merchantService, 'getMerchantSettings')
      .mockImplementation(fastMerchants.getMerchantSettings),
    updateMerchantSettings: vi
      .spyOn(merchantService, 'updateMerchantSettings')
      .mockImplementation(fastMerchants.updateMerchantSettings),
    register: vi.spyOn(authService, 'register').mockImplementation(fastAuth.register),
    login: vi.spyOn(authService, 'login').mockImplementation(fastAuth.login),
    logout: vi.spyOn(authService, 'logout').mockImplementation(fastAuth.logout),
    getCurrentSession: vi
      .spyOn(authService, 'getCurrentSession')
      .mockImplementation(fastAuth.getCurrentSession),
    requestPasswordReset: vi
      .spyOn(authService, 'requestPasswordReset')
      .mockImplementation(fastAuth.requestPasswordReset),
    verifyPasswordResetToken: vi
      .spyOn(authService, 'verifyPasswordResetToken')
      .mockImplementation(fastAuth.verifyPasswordResetToken),
    resetPassword: vi
      .spyOn(authService, 'resetPassword')
      .mockImplementation(fastAuth.resetPassword),
    changePassword: vi
      .spyOn(authService, 'changePassword')
      .mockImplementation(fastAuth.changePassword),
    requestEmailVerification: vi
      .spyOn(authService, 'requestEmailVerification')
      .mockImplementation(fastAuth.requestEmailVerification),
    confirmEmailVerification: vi
      .spyOn(authService, 'confirmEmailVerification')
      .mockImplementation(fastAuth.confirmEmailVerification),
    listBranches: vi
      .spyOn(branchService, 'listBranches')
      .mockImplementation(fastBranches.listBranches),
    getBranch: vi.spyOn(branchService, 'getBranch').mockImplementation(fastBranches.getBranch),
    createBranch: vi
      .spyOn(branchService, 'createBranch')
      .mockImplementation(fastBranches.createBranch),
    updateBranch: vi
      .spyOn(branchService, 'updateBranch')
      .mockImplementation(fastBranches.updateBranch),
    changeBranchStatus: vi
      .spyOn(branchService, 'changeBranchStatus')
      .mockImplementation(fastBranches.changeBranchStatus),
    listBranchAssignments: vi
      .spyOn(branchService, 'listBranchAssignments')
      .mockImplementation(fastBranches.listBranchAssignments),
    updateBranchAssignments: vi
      .spyOn(branchService, 'updateBranchAssignments')
      .mockImplementation(fastBranches.updateBranchAssignments),
    listStaff: vi.spyOn(staffService, 'listStaff').mockImplementation(fastStaff.listStaff),
    inviteStaff: vi.spyOn(staffService, 'inviteStaff').mockImplementation(fastStaff.inviteStaff),
    listInvitations: vi
      .spyOn(staffService, 'listInvitations')
      .mockImplementation(fastStaff.listInvitations),
    getInvitationPreview: vi
      .spyOn(staffService, 'getInvitationPreview')
      .mockImplementation(fastStaff.getInvitationPreview),
    acceptInvitation: vi
      .spyOn(staffService, 'acceptInvitation')
      .mockImplementation(fastStaff.acceptInvitation),
    updateMembershipRole: vi
      .spyOn(staffService, 'updateMembershipRole')
      .mockImplementation(fastStaff.updateMembershipRole),
    suspendMembership: vi
      .spyOn(staffService, 'suspendMembership')
      .mockImplementation(fastStaff.suspendMembership),
    reactivateMembership: vi
      .spyOn(staffService, 'reactivateMembership')
      .mockImplementation(fastStaff.reactivateMembership),
    revokeMembership: vi
      .spyOn(staffService, 'revokeMembership')
      .mockImplementation(fastStaff.revokeMembership),
  }
}
