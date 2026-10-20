import { MerchantServiceError, type MerchantService } from '@/services/merchantService'
import type { BusinessMembership } from '@/types/auth'
import type { Merchant, MerchantSettings } from '@/types/merchant'
import { createMockAuthStore, type MockAuthStore } from './mockAuthStore'
import { MOCK_STORAGE_KEYS } from './mockStorageKeys'
import { SAMPLE_MERCHANTS } from './sampleMerchants'
import { simulateNetworkDelay } from './simulateNetwork'

const STORAGE_KEY = MOCK_STORAGE_KEYS.merchants
const SETTINGS_STORAGE_KEY = MOCK_STORAGE_KEYS.merchantSettings

/** Mock counterpart of the merchant_settings row: only what is not already on the merchant record. */
type StoredSettingsMeta = Record<string, { version: number; updatedAt: string }>

/**
 * Mock-only trigger so the failure path can be exercised by hand and in tests:
 * registering with this TIN simulates the registry being unreachable.
 */
export const SIMULATED_OUTAGE_TIN = '999999999'

export type MerchantStorage = Pick<Storage, 'getItem' | 'setItem'>

interface MockMerchantServiceOptions {
  storage?: MerchantStorage
  /** Shared with the auth service so merchants, memberships and the session stay consistent. */
  authStore?: MockAuthStore
  delayInMilliseconds?: number
}

export function resolveDefaultStorage(): MerchantStorage {
  try {
    // Throws in some privacy modes; fall back to memory so the app still works.
    const probeKey = `${STORAGE_KEY}.probe`
    window.localStorage.setItem(probeKey, '1')
    window.localStorage.removeItem(probeKey)
    return window.localStorage
  } catch {
    const memory = new Map<string, string>()
    return {
      getItem: (key) => memory.get(key) ?? null,
      setItem: (key, value) => void memory.set(key, value),
    }
  }
}

/** Records saved before operating modes existed have none: they are BUSINESS, as on the backend. */
const withOperatingMode = (merchants: Merchant[]): Merchant[] =>
  merchants.map((merchant) => ({
    ...merchant,
    operatingMode: merchant.operatingMode ?? 'BUSINESS',
  }))

/** Reads the mock merchant records (shared with other mock services that need business names). */
export function loadStoredMerchants(storage: MerchantStorage): Merchant[] {
  const stored = storage.getItem(STORAGE_KEY)
  if (stored) {
    try {
      return withOperatingMode(JSON.parse(stored) as Merchant[])
    } catch {
      // Corrupt data: start again from the sample records.
    }
  }
  return withOperatingMode(structuredClone(SAMPLE_MERCHANTS))
}

export function createMockMerchantService(
  options: MockMerchantServiceOptions = {},
): MerchantService {
  const storage = options.storage ?? resolveDefaultStorage()
  const authStore = options.authStore ?? createMockAuthStore()
  const delay = options.delayInMilliseconds ?? 500

  const loadMerchants = () => loadStoredMerchants(storage)
  const saveMerchants = (merchants: Merchant[]) =>
    storage.setItem(STORAGE_KEY, JSON.stringify(merchants))

  const loadSettingsMeta = (): StoredSettingsMeta => {
    try {
      return JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? '{}') as StoredSettingsMeta
    } catch {
      return {}
    }
  }
  const settingsOf = (merchant: Merchant): MerchantSettings => {
    const meta = loadSettingsMeta()[merchant.id]
    return {
      merchantId: merchant.id,
      operatingMode: merchant.operatingMode,
      updatedAt: meta?.updatedAt,
      version: meta?.version ?? 0,
    }
  }

  const respond = <T>(value: T) => simulateNetworkDelay(value, delay)
  const reject = (error: MerchantServiceError) =>
    new Promise<never>((_, fail) => setTimeout(() => fail(error), delay))

  const currentUserId = () => authStore.readSession()?.userId ?? null
  const activeMembershipsOf = (userId: string): BusinessMembership[] =>
    authStore
      .loadMemberships()
      .filter((membership) => membership.userId === userId && membership.status === 'ACTIVE')
  const unauthenticated = () =>
    reject(new MerchantServiceError('unauthenticated', 'Please sign in to continue.'))
  const notFound = () =>
    reject(new MerchantServiceError('not_found', 'This business could not be found.'))

  return {
    async createMerchant(input) {
      const userId = currentUserId()
      if (!userId) return unauthenticated()
      const merchants = loadMerchants()
      const { tin, registrationNumber } = input.registration

      if (tin === SIMULATED_OUTAGE_TIN) {
        return reject(
          new MerchantServiceError(
            'service_unavailable',
            'The registration service is temporarily unavailable. Please try again.',
          ),
        )
      }
      if (tin && merchants.some((merchant) => merchant.registration.tin === tin)) {
        return reject(
          new MerchantServiceError(
            'duplicate_tin',
            'A business with this TIN is already registered.',
          ),
        )
      }
      if (
        registrationNumber &&
        merchants.some(
          (merchant) => merchant.registration.registrationNumber === registrationNumber,
        )
      ) {
        return reject(
          new MerchantServiceError(
            'duplicate_registration_number',
            'A business with this registration number is already registered.',
          ),
        )
      }

      const now = new Date().toISOString()
      const merchant: Merchant = {
        ...input,
        id: `mrc-${crypto.randomUUID().slice(0, 8)}`,
        ownerUserId: userId,
        // Never approved here: verification is a future back-office decision.
        status: 'pending_verification',
        operatingMode: input.operatingMode ?? 'BUSINESS',
        bankingConfiguration: { status: 'not_configured' },
        createdAt: now,
        updatedAt: now,
      }
      saveMerchants([...merchants, merchant])
      // The registering user becomes the business owner.
      authStore.saveMemberships([
        ...authStore.loadMemberships(),
        {
          id: `mem-${crypto.randomUUID().slice(0, 8)}`,
          userId,
          merchantId: merchant.id,
          role: 'OWNER',
          status: 'ACTIVE',
          createdAt: now,
          updatedAt: now,
        },
      ])
      return respond(merchant)
    },

    async getMerchantById(merchantId) {
      const userId = currentUserId()
      if (!userId) return unauthenticated()
      const isMember = activeMembershipsOf(userId).some((m) => m.merchantId === merchantId)
      const merchant = loadMerchants().find((candidate) => candidate.id === merchantId)
      // Non-members get the same answer as a missing business.
      if (!merchant || !isMember) return notFound()
      return respond(merchant)
    },

    async updateMerchant(merchantId, changes) {
      const userId = currentUserId()
      if (!userId) return unauthenticated()
      const merchants = loadMerchants()
      const existing = merchants.find((candidate) => candidate.id === merchantId)
      const membership = activeMembershipsOf(userId).find((m) => m.merchantId === merchantId)
      if (!existing || !membership) return notFound()
      // Mirrors what a real backend must enforce independently of the UI.
      if (membership.role !== 'OWNER') {
        return reject(
          new MerchantServiceError('forbidden', 'Only an owner can edit the business profile.'),
        )
      }
      if (existing.status === 'suspended') {
        return reject(
          new MerchantServiceError('profile_locked', 'A suspended business cannot be edited.'),
        )
      }
      const updated: Merchant = {
        ...existing,
        tradingName: changes.tradingName,
        location: { ...existing.location, physicalAddress: changes.physicalAddress },
        contact: changes.contact,
        updatedAt: new Date().toISOString(),
      }
      saveMerchants(merchants.map((merchant) => (merchant.id === merchantId ? updated : merchant)))
      return respond(updated)
    },

    async getMerchantSettings(merchantId) {
      const userId = currentUserId()
      if (!userId) return unauthenticated()
      const isMember = activeMembershipsOf(userId).some((m) => m.merchantId === merchantId)
      const merchant = loadMerchants().find((candidate) => candidate.id === merchantId)
      // Non-members get the same answer as a missing business.
      if (!merchant || !isMember) return notFound()
      return respond(settingsOf(merchant))
    },

    async updateMerchantSettings(merchantId, changes) {
      const userId = currentUserId()
      if (!userId) return unauthenticated()
      const merchants = loadMerchants()
      const existing = merchants.find((candidate) => candidate.id === merchantId)
      const membership = activeMembershipsOf(userId).find((m) => m.merchantId === merchantId)
      if (!existing || !membership) return notFound()
      // Mirrors what the real backend enforces independently of the UI.
      if (membership.role !== 'OWNER') {
        return reject(
          new MerchantServiceError('forbidden', 'Only an owner can change how the business works.'),
        )
      }
      if (existing.status === 'suspended' || existing.status === 'rejected') {
        return reject(
          new MerchantServiceError('profile_locked', 'This business can no longer be configured.'),
        )
      }
      const current = settingsOf(existing)
      if (current.version !== changes.expectedVersion) {
        return reject(
          new MerchantServiceError(
            'version_conflict',
            'The settings were changed by someone else. Reload them and try again.',
          ),
        )
      }
      if (current.operatingMode === changes.operatingMode) return respond(current)
      const now = new Date().toISOString()
      // Only the mode changes: invoices, payments, memberships and sessions are never touched.
      saveMerchants(
        merchants.map((merchant) =>
          merchant.id === merchantId
            ? { ...merchant, operatingMode: changes.operatingMode }
            : merchant,
        ),
      )
      storage.setItem(
        SETTINGS_STORAGE_KEY,
        JSON.stringify({
          ...loadSettingsMeta(),
          [merchantId]: { version: current.version + 1, updatedAt: now },
        }),
      )
      return respond({
        merchantId,
        operatingMode: changes.operatingMode,
        updatedAt: now,
        version: current.version + 1,
      })
    },

    async listMerchantsForCurrentUser() {
      const userId = currentUserId()
      if (!userId) return unauthenticated()
      const merchantIds = new Set(activeMembershipsOf(userId).map((m) => m.merchantId))
      return respond(loadMerchants().filter((merchant) => merchantIds.has(merchant.id)))
    },
  }
}
