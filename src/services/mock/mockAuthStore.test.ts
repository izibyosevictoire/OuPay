import { createMemoryStorage, createMockAuthStore } from './mockAuthStore'
import { MOCK_SCHEMA_VERSION, MOCK_STORAGE_KEYS } from './mockStorageKeys'

describe('mock store schema version', () => {
  it('resets data saved by an older version so new seed records appear', () => {
    const persistentStorage = createMemoryStorage()
    persistentStorage.setItem(MOCK_STORAGE_KEYS.users, JSON.stringify([{ id: 'stale-user' }]))
    persistentStorage.setItem(MOCK_STORAGE_KEYS.memberships, JSON.stringify([]))
    persistentStorage.setItem(MOCK_STORAGE_KEYS.schemaVersion, '1')

    const store = createMockAuthStore({ persistentStorage, sessionStorage: createMemoryStorage() })

    expect(store.loadUsers().some((user) => user.id === 'stale-user')).toBe(false)
    expect(store.loadMemberships().length).toBeGreaterThan(0)
    expect(persistentStorage.getItem(MOCK_STORAGE_KEYS.schemaVersion)).toBe(MOCK_SCHEMA_VERSION)
  })

  it('keeps data saved by the current version', () => {
    const persistentStorage = createMemoryStorage()
    const first = createMockAuthStore({ persistentStorage, sessionStorage: createMemoryStorage() })
    first.saveBranches([])
    const second = createMockAuthStore({ persistentStorage, sessionStorage: createMemoryStorage() })
    expect(second.loadBranches()).toEqual([])
  })

  it('ends a stale session when it resets', () => {
    const persistentStorage = createMemoryStorage()
    const sessionStorage = createMemoryStorage()
    sessionStorage.setItem(
      MOCK_STORAGE_KEYS.demoSession,
      JSON.stringify({ userId: 'x', expiresAt: '2999-01-01T00:00:00Z' }),
    )
    const store = createMockAuthStore({ persistentStorage, sessionStorage })
    expect(store.readSession()).toBeNull()
  })
})
