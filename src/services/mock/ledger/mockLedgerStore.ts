import { ACTIVE_SEEDS } from '../seeds'
import type { BankConnection, PaymentDestination } from '@/types/banking'
import type { AppNotification } from '@/types/notification'
import type {
  AuditEntry,
  BankEventRecord,
  BankTransaction,
  PaymentAllocation,
  RefundRecord,
} from '@/types/payment'
import type { PaymentProfile } from '@/types/paymentProfile'
import type { MockAuthStore } from '../mockAuthStore'
import { MOCK_STORAGE_KEYS } from '../mockStorageKeys'
import {
  type StoredPaymentRequest,
} from '../sampleLedger'

interface Collection<T> {
  load(): T[]
  save(records: T[]): void
}

/**
 * The single financial source of truth inside the mock services: ONE set of collections that
 * every service (reconciliation, invoices, dashboard, notifications, public payment pages)
 * reads and writes. Nothing keeps its own copy of a total.
 */
export function createLedgerStore(store: MockAuthStore) {
  const collection = <T>(key: string, seed: T[]): Collection<T> => ({
    load: () => store.loadRecords<T>(key, seed),
    save: (records) => store.saveRecords(key, records),
  })
  return {
    bankConnections: collection<BankConnection>(
      MOCK_STORAGE_KEYS.bankConnections,
      ACTIVE_SEEDS.bankConnections,
    ),
    paymentDestinations: collection<PaymentDestination>(
      MOCK_STORAGE_KEYS.paymentDestinations,
      ACTIVE_SEEDS.paymentDestinations,
    ),
    bankTransactions: collection<BankTransaction>(
      MOCK_STORAGE_KEYS.bankTransactions,
      ACTIVE_SEEDS.bankTransactions,
    ),
    allocations: collection<PaymentAllocation>(
      MOCK_STORAGE_KEYS.paymentAllocations,
      ACTIVE_SEEDS.paymentAllocations,
    ),
    bankEvents: collection<BankEventRecord>(MOCK_STORAGE_KEYS.bankEvents, []),
    auditEntries: collection<AuditEntry>(MOCK_STORAGE_KEYS.auditEntries, ACTIVE_SEEDS.auditEntries),
    notifications: collection<AppNotification>(MOCK_STORAGE_KEYS.notifications, []),
    paymentProfiles: collection<PaymentProfile>(
      MOCK_STORAGE_KEYS.paymentProfiles,
      ACTIVE_SEEDS.paymentProfiles,
    ),
    paymentRequests: collection<StoredPaymentRequest>(
      MOCK_STORAGE_KEYS.paymentRequests,
      ACTIVE_SEEDS.paymentRequests,
    ),
    refunds: collection<RefundRecord>(MOCK_STORAGE_KEYS.refunds, []),
  }
}

export type LedgerStore = ReturnType<typeof createLedgerStore>

/** Short, readable, unique ID with a prefix, e.g. "btx-3f9a1c2e". */
export const newId = (prefix: string) => `${prefix}-${crypto.randomUUID().slice(0, 8)}`
