import { DEMO_EXPERIENCE, MOCK_STORAGE_NAMESPACE as NS } from '@/lib/demoExperience'

/**
 * Every browser-storage key the mock backend persists, in one place. The demo experience (R9c) uses its own `oupay.demo.*` namespace, so a
 * demo and an ordinary mock session on the same origin can never overwrite or clear each other.
 */
export const MOCK_STORAGE_KEYS = {
  users: `${NS}.users`,
  memberships: `${NS}.memberships`,
  merchants: `${NS}.merchants`,
  merchantSettings: `${NS}.merchantSettings`,
  branches: `${NS}.branches`,
  branchAssignments: `${NS}.branchAssignments`,
  invitations: `${NS}.invitations`,
  invoices: `${NS}.invoices`,
  bankConnections: `${NS}.bankConnections`,
  paymentDestinations: `${NS}.paymentDestinations`,
  bankTransactions: `${NS}.bankTransactions`,
  paymentAllocations: `${NS}.paymentAllocations`,
  bankEvents: `${NS}.bankEvents`,
  auditEntries: `${NS}.auditEntries`,
  notifications: `${NS}.notifications`,
  paymentProfiles: `${NS}.paymentProfiles`,
  paymentRequests: `${NS}.paymentRequests`,
  refunds: `${NS}.refunds`,
  checkoutSales: `${NS}.checkoutSales`,
  codeSales: `${NS}.codeSales`,
  kycApplications: `${NS}.kycApplications`,
  catalogItems: `${NS}.catalogItems`,
  catalogPrices: `${NS}.catalogPrices`,
  inventoryBalances: `${NS}.inventoryBalances`,
  inventoryMovements: `${NS}.inventoryMovements`,
  posDrafts: `${NS}.posDrafts`,
  posSales: `${NS}.posSales`,
  catalogTax: `${NS}.catalogTax`,
  collectionCodes: `${NS}.collectionCodes`,
  collectionCodeAssignments: `${NS}.collectionCodeAssignments`,
  entryDevices: `${NS}.entryDevices`,
  entryDeviceAssignments: `${NS}.entryDeviceAssignments`,
  entryBindings: `${NS}.entryBindings`,
  entryClaims: `${NS}.entryClaims`,
  demoSession: `${NS}.demoSession`,
  /** Demo experience only: when the example data was first loaded (ISO time). Its absence means "first open". */
  demoInitialisedAt: `${NS}.demoInitialisedAt`,
  schemaVersion: `${NS}.schemaVersion`,
}

/**
 * Bump whenever the shape or seed data of the mock records changes. Browsers holding data
 * from an older version are reset to the new seed data instead of showing stale records.
 */
export const MOCK_SCHEMA_VERSION = DEMO_EXPERIENCE ? '7+kigali-demo-1' : '7'
