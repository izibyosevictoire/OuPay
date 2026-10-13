import { DEMO_TOOLS_BUILD } from '@/lib/demoTools'
import type { AuthService } from './authService'
import type { BankSimulatorService } from './bankSimulatorService'
import type { BankingConfigurationService } from './bankingService'
import type { BranchService } from './branchService'
import type { DashboardService } from './dashboardService'
import { API_BASE_URL, API_MODE } from './http/apiConfig'
import { createHttpClient } from './http/httpClient'
import {
  createHttpAuthService,
  createHttpBankingService,
  createHttpBranchService,
  createHttpDashboardService,
  createHttpInvoiceService,
  createHttpMerchantService,
  createHttpNotificationService,
  createHttpPaymentProfileService,
  createHttpPublicPaymentService,
  createHttpReconciliationService,
  createHttpStaffService,
} from './http/httpServices'
import type { InvoiceService } from './invoiceService'
import type { MerchantService } from './merchantService'
import { createMockAuthService } from './mock/mockAuthService'
import { createMockAuthStore } from './mock/mockAuthStore'
import { createMockBankingService } from './mock/mockBankingService'
import { createMockBankSimulator } from './mock/mockBankSimulator'
import { createMockBranchService } from './mock/mockBranchService'
import { createLedgerStore } from './mock/ledger/mockLedgerStore'
import { createMockDashboardService } from './mock/mockDashboardService'
import { createMockInvoiceService } from './mock/mockInvoiceService'
import { createMockMerchantService } from './mock/mockMerchantService'
import { createMockNotificationService } from './mock/mockNotificationService'
import { createMockPaymentProfileService } from './mock/mockPaymentProfileService'
import { createMockPublicPaymentService } from './mock/mockPublicPaymentService'
import { createMockReconciliationService } from './mock/mockReconciliationService'
import { createMockStaffService } from './mock/mockStaffService'
import type { NotificationService } from './notificationService'
import type { PaymentProfileService } from './paymentProfileService'
import type { PublicPaymentService } from './publicPaymentService'
import type { ReconciliationService } from './reconciliationService'
import type { StaffService } from './staffService'

/**
 * THE ONE PLACE that decides where data comes from (see docs/backend.md, "Demo mode and
 * server-backed mode").
 *
 * - `VITE_API_MODE` unset or `mock`: in-browser mock services (demo mode). Every service shares one
 *   mock store and one ledger so users, memberships, invoices and payments stay consistent.
 * - `VITE_API_MODE=http`: the real backend. No mock store is created, so no mock data is read,
 *   written or shown, and the session lives in the server's HttpOnly cookie.
 *
 * A build runs in exactly one mode. The mock graph is only constructed when it is used.
 */
interface Services {
  authService: AuthService
  merchantService: MerchantService
  branchService: BranchService
  staffService: StaffService
  dashboardService: DashboardService
  invoiceService: InvoiceService
  reconciliationService: ReconciliationService
  notificationService: NotificationService
  bankingService: BankingConfigurationService
  paymentProfileService: PaymentProfileService
  publicPaymentService: PublicPaymentService
  /** Demo only (mock mode, demo build). The trusted event processor is never exported at all. */
  bankSimulator: BankSimulatorService | null
}

function createMockServices(): Services {
  const mockAuthStore = createMockAuthStore()
  // One ledger (transactions, allocations, requests, notifications) behind every payment-side
  // service, so no screen or total can disagree with another.
  const mockLedger = createLedgerStore(mockAuthStore)
  const shared = { authStore: mockAuthStore, ledger: mockLedger }
  return {
    authService: createMockAuthService({ store: mockAuthStore }),
    merchantService: createMockMerchantService({ authStore: mockAuthStore }),
    branchService: createMockBranchService({ authStore: mockAuthStore }),
    staffService: createMockStaffService({ authStore: mockAuthStore }),
    dashboardService: createMockDashboardService(shared),
    invoiceService: createMockInvoiceService(shared),
    reconciliationService: createMockReconciliationService(shared),
    notificationService: createMockNotificationService(shared),
    bankingService: createMockBankingService(shared),
    paymentProfileService: createMockPaymentProfileService(shared),
    publicPaymentService: createMockPublicPaymentService(shared),
    /**
     * The trusted bank-event processor is deliberately NOT exported: ordinary code can never
     * confirm a payment. Only this demo simulator reaches it, and only when demo tools are on.
     */
    bankSimulator: DEMO_TOOLS_BUILD ? createMockBankSimulator(shared) : null,
  }
}

function createHttpServices(): Services {
  const http = createHttpClient({ baseUrl: API_BASE_URL })
  return {
    authService: createHttpAuthService(http),
    merchantService: createHttpMerchantService(http),
    branchService: createHttpBranchService(http),
    staffService: createHttpStaffService(http),
    dashboardService: createHttpDashboardService(http),
    invoiceService: createHttpInvoiceService(http),
    reconciliationService: createHttpReconciliationService(http),
    notificationService: createHttpNotificationService(http),
    bankingService: createHttpBankingService(http),
    paymentProfileService: createHttpPaymentProfileService(http),
    publicPaymentService: createHttpPublicPaymentService(http),
    // Server mode has no in-browser simulator: events reach the server only through its
    // authenticated provider boundary.
    bankSimulator: null,
  }
}

const services: Services = API_MODE === 'http' ? createHttpServices() : createMockServices()

export const {
  authService,
  merchantService,
  branchService,
  staffService,
  dashboardService,
  invoiceService,
  reconciliationService,
  notificationService,
  bankingService,
  paymentProfileService,
  publicPaymentService,
  bankSimulator,
} = services
