// The ONE place that decides which initial records the mock services start from.
//
// - An ordinary mock build / the test suite: the long-standing SAMPLE_* records (unchanged).
// - The separate demo build (`vite build --mode demo`, R9c): the Kigali Demo Supermarket records, in their own `oupay.demo.*` storage.
//
// Every mock service reads its starting records from `ACTIVE_SEEDS`, so one switch moves the whole graph together and no service can start
// from a different business than another.
import type { BusinessMembership, User } from '@/types/auth'
import type { BankConnection, PaymentDestination } from '@/types/banking'
import type { Branch, BranchAssignment } from '@/types/branch'
import type { Invoice } from '@/types/invoice'
import type { Merchant } from '@/types/merchant'
import type { AuditEntry, BankTransaction, PaymentAllocation } from '@/types/payment'
import type { PaymentProfile } from '@/types/paymentProfile'
import type { StaffInvitation } from '@/types/staff'
import type { StoredAssignment as StoredEntryAssignment, StoredDevice as StoredEntryDevice } from './mockEntryDeviceService'
import type { StoredPosDraft } from './mockPosService'
import { DEMO_MEMBERSHIPS, DEMO_USERS } from './sampleAccounts'
import { SAMPLE_CATALOG_ITEMS, SAMPLE_CATALOG_PRICES, type StoredCatalogItem, type StoredPriceVersion } from './sampleCatalog'
import { SAMPLE_CATALOG_TAX, type StoredCatalogTax } from './sampleCatalogTax'
import {
  SAMPLE_CODE_ASSIGNMENTS,
  SAMPLE_COLLECTION_CODES,
  type StoredCodeAssignment,
  type StoredCollectionCode,
} from './sampleCollectionCodes'
import { SAMPLE_INVENTORY_BALANCES, SAMPLE_STOCK_MOVEMENTS, type StoredBalance, type StoredMovement } from './sampleInventory'
import { SAMPLE_INVOICES } from './sampleInvoices'
import {
  SAMPLE_AUDIT_ENTRIES,
  SAMPLE_BANK_CONNECTIONS,
  SAMPLE_BANK_TRANSACTIONS,
  SAMPLE_PAYMENT_ALLOCATIONS,
  SAMPLE_PAYMENT_DESTINATIONS,
  SAMPLE_PAYMENT_PROFILES,
  SAMPLE_PAYMENT_REQUESTS,
  type StoredPaymentRequest,
} from './sampleLedger'
import { SAMPLE_MERCHANTS } from './sampleMerchants'
import { SAMPLE_BRANCH_ASSIGNMENTS, SAMPLE_BRANCHES, SAMPLE_INVITATIONS } from './sampleOrganization'
import {
  KIGALI_BRANCH_ASSIGNMENTS,
  KIGALI_BRANCHES,
  KIGALI_INVITATIONS,
  KIGALI_MEMBERSHIPS,
  KIGALI_MERCHANTS,
  KIGALI_USERS,
} from './kigaliDemo/organization'
import {
  KIGALI_CATALOG_ITEMS,
  KIGALI_CATALOG_PRICES,
  KIGALI_CATALOG_TAX,
  KIGALI_INVENTORY_BALANCES,
  KIGALI_POS_DRAFTS,
  KIGALI_STOCK_MOVEMENTS,
} from './kigaliDemo/commerce'
import {
  KIGALI_AUDIT_ENTRIES,
  KIGALI_BANK_CONNECTIONS,
  KIGALI_BANK_TRANSACTIONS,
  KIGALI_CODE_ASSIGNMENTS,
  KIGALI_COLLECTION_CODES,
  KIGALI_ENTRY_DEVICE_ASSIGNMENTS,
  KIGALI_ENTRY_DEVICES,
  KIGALI_INVOICES,
  KIGALI_PAYMENT_ALLOCATIONS,
  KIGALI_PAYMENT_DESTINATIONS,
  KIGALI_PAYMENT_PROFILES,
  KIGALI_PAYMENT_REQUESTS,
} from './kigaliDemo/payments'

export interface MockSeedSet {
  users: User[]
  memberships: BusinessMembership[]
  merchants: Merchant[]
  branches: Branch[]
  branchAssignments: BranchAssignment[]
  invitations: StaffInvitation[]
  invoices: Invoice[]
  bankConnections: BankConnection[]
  paymentDestinations: PaymentDestination[]
  bankTransactions: BankTransaction[]
  paymentAllocations: PaymentAllocation[]
  auditEntries: AuditEntry[]
  paymentProfiles: PaymentProfile[]
  paymentRequests: StoredPaymentRequest[]
  catalogItems: StoredCatalogItem[]
  catalogPrices: StoredPriceVersion[]
  catalogTax: StoredCatalogTax[]
  inventoryBalances: StoredBalance[]
  inventoryMovements: StoredMovement[]
  collectionCodes: StoredCollectionCode[]
  collectionCodeAssignments: StoredCodeAssignment[]
  posDrafts: StoredPosDraft[]
  entryDevices: StoredEntryDevice[]
  entryDeviceAssignments: StoredEntryAssignment[]
}

export const SAMPLE_SEEDS: MockSeedSet = {
  users: DEMO_USERS,
  memberships: DEMO_MEMBERSHIPS,
  merchants: SAMPLE_MERCHANTS,
  branches: SAMPLE_BRANCHES,
  branchAssignments: SAMPLE_BRANCH_ASSIGNMENTS,
  invitations: SAMPLE_INVITATIONS,
  invoices: SAMPLE_INVOICES,
  bankConnections: SAMPLE_BANK_CONNECTIONS,
  paymentDestinations: SAMPLE_PAYMENT_DESTINATIONS,
  bankTransactions: SAMPLE_BANK_TRANSACTIONS,
  paymentAllocations: SAMPLE_PAYMENT_ALLOCATIONS,
  auditEntries: SAMPLE_AUDIT_ENTRIES,
  paymentProfiles: SAMPLE_PAYMENT_PROFILES,
  paymentRequests: SAMPLE_PAYMENT_REQUESTS,
  catalogItems: SAMPLE_CATALOG_ITEMS,
  catalogPrices: SAMPLE_CATALOG_PRICES,
  catalogTax: SAMPLE_CATALOG_TAX,
  inventoryBalances: SAMPLE_INVENTORY_BALANCES,
  inventoryMovements: SAMPLE_STOCK_MOVEMENTS,
  collectionCodes: SAMPLE_COLLECTION_CODES,
  collectionCodeAssignments: SAMPLE_CODE_ASSIGNMENTS,
  posDrafts: [],
  entryDevices: [],
  entryDeviceAssignments: [],
}

export const KIGALI_SEEDS: MockSeedSet = {
  users: KIGALI_USERS,
  memberships: KIGALI_MEMBERSHIPS,
  merchants: KIGALI_MERCHANTS,
  branches: KIGALI_BRANCHES,
  branchAssignments: KIGALI_BRANCH_ASSIGNMENTS,
  invitations: KIGALI_INVITATIONS,
  invoices: KIGALI_INVOICES,
  bankConnections: KIGALI_BANK_CONNECTIONS,
  paymentDestinations: KIGALI_PAYMENT_DESTINATIONS,
  bankTransactions: KIGALI_BANK_TRANSACTIONS,
  paymentAllocations: KIGALI_PAYMENT_ALLOCATIONS,
  auditEntries: KIGALI_AUDIT_ENTRIES,
  paymentProfiles: KIGALI_PAYMENT_PROFILES,
  paymentRequests: KIGALI_PAYMENT_REQUESTS,
  catalogItems: KIGALI_CATALOG_ITEMS,
  catalogPrices: KIGALI_CATALOG_PRICES,
  catalogTax: KIGALI_CATALOG_TAX,
  inventoryBalances: KIGALI_INVENTORY_BALANCES,
  inventoryMovements: KIGALI_STOCK_MOVEMENTS,
  collectionCodes: KIGALI_COLLECTION_CODES,
  collectionCodeAssignments: KIGALI_CODE_ASSIGNMENTS,
  posDrafts: KIGALI_POS_DRAFTS,
  entryDevices: KIGALI_ENTRY_DEVICES,
  entryDeviceAssignments: KIGALI_ENTRY_DEVICE_ASSIGNMENTS,
}

/**
 * What every mock service starts from. A build-time constant: the demo build contains the Kigali records, and an ordinary build or a server
 * build is unaffected.
 */
// The condition is written out here, from the build-time variables themselves (not imported), so the bundler can decide it at build time and
// leave the Kigali records out of every build that is not the demo.
const IS_DEMO_BUILD = import.meta.env.VITE_DEMO_EXPERIENCE === 'true' && import.meta.env.VITE_API_MODE !== 'http'

export const ACTIVE_SEEDS: MockSeedSet = IS_DEMO_BUILD ? KIGALI_SEEDS : SAMPLE_SEEDS
