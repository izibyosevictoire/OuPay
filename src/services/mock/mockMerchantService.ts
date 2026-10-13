import { MerchantServiceError, type MerchantService } from '@/services/merchantService'
import type { BusinessMembership } from '@/types/auth'
import type { Merchant } from '@/types/merchant'
import { createMockAuthStore, type MockAuthStore } from './mockAuthStore'
import { MOCK_STORAGE_KEYS } from './mockStorageKeys'
import { SAMPLE_MERCHANTS } from './sampleMerchants'
import { simulateNetworkDelay } from './simulateNetwork'

const STORAGE_KEY = MOCK_STORAGE_KEYS.merchants

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

/** Reads the mock merchant records (shared with other mock services that need business names). */
export function loadStoredMerchants(storage: MerchantStorage): Merchant[] {
  const stored = storage.getItem(STORAGE_KEY)
  if (stored) {
    try {
      return JSON.parse(stored) as Merchant[]
    } catch {
      // Corrupt data: start again from the sample records.
    }
  }
  return structuredClone(SAMPLE_MERCHANTS)
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

    async listMerchantsForCurrentUser() {
      const userId = currentUserId()
      if (!userId) return unauthenticated()
      const merchantIds = new Set(activeMembershipsOf(userId).map((m) => m.merchantId))
      return respond(loadMerchants().filter((merchant) => merchantIds.has(merchant.id)))
    },
  }
}
