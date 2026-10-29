/** Every browser-storage key the mock backend persists, in one place. */
export const MOCK_STORAGE_KEYS = {
  users: 'oupay.mock.users',
  memberships: 'oupay.mock.memberships',
  merchants: 'oupay.mock.merchants',
  merchantSettings: 'oupay.mock.merchantSettings',
  branches: 'oupay.mock.branches',
  branchAssignments: 'oupay.mock.branchAssignments',
  invitations: 'oupay.mock.invitations',
  invoices: 'oupay.mock.invoices',
  bankConnections: 'oupay.mock.bankConnections',
  paymentDestinations: 'oupay.mock.paymentDestinations',
  bankTransactions: 'oupay.mock.bankTransactions',
  paymentAllocations: 'oupay.mock.paymentAllocations',
  bankEvents: 'oupay.mock.bankEvents',
  auditEntries: 'oupay.mock.auditEntries',
  notifications: 'oupay.mock.notifications',
  paymentProfiles: 'oupay.mock.paymentProfiles',
  paymentRequests: 'oupay.mock.paymentRequests',
  refunds: 'oupay.mock.refunds',
  checkoutSales: 'oupay.mock.checkoutSales',
  codeSales: 'oupay.mock.codeSales',
  kycApplications: 'oupay.mock.kycApplications',
  catalogItems: 'oupay.mock.catalogItems',
  catalogPrices: 'oupay.mock.catalogPrices',
  inventoryBalances: 'oupay.mock.inventoryBalances',
  inventoryMovements: 'oupay.mock.inventoryMovements',
  posDrafts: 'oupay.mock.posDrafts',
  posSales: 'oupay.mock.posSales',
  catalogTax: 'oupay.mock.catalogTax',
  collectionCodes: 'oupay.mock.collectionCodes',
  collectionCodeAssignments: 'oupay.mock.collectionCodeAssignments',
  demoSession: 'oupay.mock.demoSession',
  schemaVersion: 'oupay.mock.schemaVersion',
} as const

/**
 * Bump whenever the shape or seed data of the mock records changes. Browsers holding data
 * from an older version are reset to the new seed data instead of showing stale records.
 */
export const MOCK_SCHEMA_VERSION = '7'
