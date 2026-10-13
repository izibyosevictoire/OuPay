import type { BusinessMembership, User } from '@/types/auth'
import type { Branch, BranchAssignment } from '@/types/branch'
import type { Invoice } from '@/types/invoice'
import type { StaffInvitation } from '@/types/staff'
import { MOCK_SCHEMA_VERSION, MOCK_STORAGE_KEYS } from './mockStorageKeys'
import { DEMO_MEMBERSHIPS, DEMO_USERS } from './sampleAccounts'
import { SAMPLE_INVOICES } from './sampleInvoices'
import {
  SAMPLE_BRANCH_ASSIGNMENTS,
  SAMPLE_BRANCHES,
  SAMPLE_INVITATIONS,
} from './sampleOrganization'

export type KeyValueStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const USERS_KEY = MOCK_STORAGE_KEYS.users
const MEMBERSHIPS_KEY = MOCK_STORAGE_KEYS.memberships
const BRANCHES_KEY = MOCK_STORAGE_KEYS.branches
const BRANCH_ASSIGNMENTS_KEY = MOCK_STORAGE_KEYS.branchAssignments
const INVITATIONS_KEY = MOCK_STORAGE_KEYS.invitations
const INVOICES_KEY = MOCK_STORAGE_KEYS.invoices
/** Holds only { userId, expiresAt }: a demo session marker, never a credential or token. */
const SESSION_KEY = MOCK_STORAGE_KEYS.demoSession

interface StoredSession {
  userId: string
  expiresAt: string
}

export interface MockAuthStore {
  loadUsers(): User[]
  saveUsers(users: User[]): void
  loadMemberships(): BusinessMembership[]
  saveMemberships(memberships: BusinessMembership[]): void
  loadBranches(): Branch[]
  saveBranches(branches: Branch[]): void
  loadBranchAssignments(): BranchAssignment[]
  saveBranchAssignments(assignments: BranchAssignment[]): void
  loadInvitations(): StaffInvitation[]
  saveInvitations(invitations: StaffInvitation[]): void
  loadInvoices(): Invoice[]
  saveInvoices(invoices: Invoice[]): void
  /** Generic persisted collections for the ledger (see mockLedgerStore). */
  loadRecords<T>(key: string, seed: T[]): T[]
  saveRecords<T>(key: string, records: T[]): void
  /** `remember` keeps the marker across browser restarts; otherwise it dies with the tab. */
  startSession(userId: string, remember: boolean, lifetimeInMilliseconds: number): StoredSession
  readSession(): StoredSession | null
  endSession(): void
}

export function createMemoryStorage(): KeyValueStorage {
  const memory = new Map<string, string>()
  return {
    getItem: (key) => memory.get(key) ?? null,
    setItem: (key, value) => void memory.set(key, value),
    removeItem: (key) => void memory.delete(key),
  }
}

/** Browser storage can throw (privacy modes); fall back to memory so the demo still runs. */
function browserStorageOrMemory(kind: 'localStorage' | 'sessionStorage'): KeyValueStorage {
  try {
    const storage = window[kind]
    storage.setItem('oupay.mock.probe', '1')
    storage.removeItem('oupay.mock.probe')
    return storage
  } catch {
    return createMemoryStorage()
  }
}

interface MockAuthStoreOptions {
  /** Users, memberships and remembered sessions. */
  persistentStorage?: KeyValueStorage
  /** Non-remembered sessions. */
  sessionStorage?: KeyValueStorage
}

export function createMockAuthStore(options: MockAuthStoreOptions = {}): MockAuthStore {
  const persistent = options.persistentStorage ?? browserStorageOrMemory('localStorage')
  const session = options.sessionStorage ?? browserStorageOrMemory('sessionStorage')

  // Records saved by an older version of the mock would be missing newer seed data.
  if (persistent.getItem(MOCK_STORAGE_KEYS.schemaVersion) !== MOCK_SCHEMA_VERSION) {
    for (const key of Object.values(MOCK_STORAGE_KEYS)) persistent.removeItem(key)
    session.removeItem(SESSION_KEY)
    persistent.setItem(MOCK_STORAGE_KEYS.schemaVersion, MOCK_SCHEMA_VERSION)
  }

  const load = <T>(key: string, seed: T[]): T[] => {
    const stored = persistent.getItem(key)
    if (stored) {
      try {
        return JSON.parse(stored) as T[]
      } catch {
        // Corrupt data: fall back to the seed records.
      }
    }
    return structuredClone(seed)
  }

  const parseSession = (raw: string | null): StoredSession | null => {
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw) as Partial<StoredSession>
      return typeof parsed.userId === 'string' && typeof parsed.expiresAt === 'string'
        ? { userId: parsed.userId, expiresAt: parsed.expiresAt }
        : null
    } catch {
      return null
    }
  }

  return {
    loadUsers: () => load(USERS_KEY, DEMO_USERS),
    saveUsers: (users) => persistent.setItem(USERS_KEY, JSON.stringify(users)),
    loadMemberships: () => load(MEMBERSHIPS_KEY, DEMO_MEMBERSHIPS),
    saveMemberships: (memberships) =>
      persistent.setItem(MEMBERSHIPS_KEY, JSON.stringify(memberships)),

    loadBranches: () => load(BRANCHES_KEY, SAMPLE_BRANCHES),
    saveBranches: (branches) => persistent.setItem(BRANCHES_KEY, JSON.stringify(branches)),
    loadBranchAssignments: () => load(BRANCH_ASSIGNMENTS_KEY, SAMPLE_BRANCH_ASSIGNMENTS),
    saveBranchAssignments: (assignments) =>
      persistent.setItem(BRANCH_ASSIGNMENTS_KEY, JSON.stringify(assignments)),
    loadInvitations: () => load(INVITATIONS_KEY, SAMPLE_INVITATIONS),
    saveInvitations: (invitations) =>
      persistent.setItem(INVITATIONS_KEY, JSON.stringify(invitations)),

    loadInvoices: () => load(INVOICES_KEY, SAMPLE_INVOICES),
    saveInvoices: (invoices) => persistent.setItem(INVOICES_KEY, JSON.stringify(invoices)),

    loadRecords: (key, seed) => load(key, seed),
    saveRecords: (key, records) => persistent.setItem(key, JSON.stringify(records)),

    startSession(userId, remember, lifetimeInMilliseconds) {
      const started: StoredSession = {
        userId,
        expiresAt: new Date(Date.now() + lifetimeInMilliseconds).toISOString(),
      }
      persistent.removeItem(SESSION_KEY)
      session.removeItem(SESSION_KEY)
      ;(remember ? persistent : session).setItem(SESSION_KEY, JSON.stringify(started))
      return started
    },
    readSession: () =>
      parseSession(session.getItem(SESSION_KEY) ?? persistent.getItem(SESSION_KEY)),
    endSession() {
      persistent.removeItem(SESSION_KEY)
      session.removeItem(SESSION_KEY)
    },
  }
}
