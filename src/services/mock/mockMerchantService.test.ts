import { MerchantServiceError } from '@/services/merchantService'
import { createMemoryStorage, createMockAuthStore } from '@/services/mock/mockAuthStore'
import type { CreateMerchantInput } from '@/types/merchant'
import { createMockMerchantService, SIMULATED_OUTAGE_TIN } from './mockMerchantService'
import { DEMO_USER_IDS } from './sampleAccounts'
import { SAMPLE_MERCHANT_ID, SAMPLE_MERCHANTS, SAMPLE_SECOND_MERCHANT_ID } from './sampleMerchants'

const newBusiness: CreateMerchantInput = {
  legalName: 'Mama Jane Fruits',
  businessType: 'informal_vendor',
  registration: {},
  location: {
    country: 'RW',
    province: 'Kigali City',
    district: 'Gasabo',
    sector: 'Remera',
    physicalAddress: 'Remera market',
  },
  contact: { fullName: 'Jane', email: 'jane@example.rw', phoneNumber: '+250788123456' },
}

/** A service and the auth store it shares, signed in as the given demo user (or nobody). */
function createService(signedInAs: string | null = DEMO_USER_IDS.owner) {
  const authStore = createMockAuthStore({
    persistentStorage: createMemoryStorage(),
    sessionStorage: createMemoryStorage(),
  })
  if (signedInAs) authStore.startSession(signedInAs, false, 60_000)
  const service = createMockMerchantService({
    delayInMilliseconds: 0,
    storage: createMemoryStorage(),
    authStore,
  })
  return { authStore, service }
}

describe('mock merchant operating mode', () => {
  const change = (operatingMode: 'BUSINESS' | 'SIMPLIFIED', expectedVersion: number) => ({
    operatingMode,
    expectedVersion,
  })

  it('creates a business as BUSINESS unless another mode is chosen', async () => {
    const { service } = createService()
    expect((await service.createMerchant(newBusiness)).operatingMode).toBe('BUSINESS')
    const simplified = await service.createMerchant({
      ...newBusiness,
      registration: { tin: '555666777' },
      operatingMode: 'SIMPLIFIED',
    })
    expect(simplified.operatingMode).toBe('SIMPLIFIED')
    expect(await service.getMerchantSettings(simplified.id)).toMatchObject({
      operatingMode: 'SIMPLIFIED',
      version: 0,
    })
    // The legal form is a separate fact.
    expect(simplified.businessType).toBe('informal_vendor')
  })

  it('reads records saved before modes existed as BUSINESS', async () => {
    const storage = createMemoryStorage()
    const legacy = { ...SAMPLE_MERCHANTS[0]!, operatingMode: undefined }
    storage.setItem('oupay.mock.merchants', JSON.stringify([legacy]))
    const { authStore } = createService()
    const service = createMockMerchantService({ delayInMilliseconds: 0, storage, authStore })
    expect((await service.getMerchantById(SAMPLE_MERCHANT_ID)).operatingMode).toBe('BUSINESS')
    expect(await service.getMerchantSettings(SAMPLE_MERCHANT_ID)).toMatchObject({
      operatingMode: 'BUSINESS',
      version: 0,
    })
  })

  it('lets the owner change the mode, bumping the version and keeping the merchant record', async () => {
    const { service } = createService()
    const saved = await service.updateMerchantSettings(SAMPLE_MERCHANT_ID, change('SIMPLIFIED', 0))
    expect(saved).toMatchObject({ operatingMode: 'SIMPLIFIED', version: 1 })
    expect(saved.updatedAt).toBeDefined()
    const merchant = await service.getMerchantById(SAMPLE_MERCHANT_ID)
    expect(merchant.operatingMode).toBe('SIMPLIFIED')
    expect(merchant.legalName).toBe('Sample Business Ltd')
    expect(merchant.businessType).toBe('registered_company')
    const listed = await service.listMerchantsForCurrentUser()
    expect(listed.find((m) => m.id === SAMPLE_MERCHANT_ID)?.operatingMode).toBe('SIMPLIFIED')
  })

  it('does nothing when the mode is already set', async () => {
    const { service } = createService()
    const same = await service.updateMerchantSettings(SAMPLE_MERCHANT_ID, change('BUSINESS', 0))
    expect(same).toMatchObject({ operatingMode: 'BUSINESS', version: 0 })
  })

  it('rejects a stale version', async () => {
    const { service } = createService()
    await service.updateMerchantSettings(SAMPLE_MERCHANT_ID, change('SIMPLIFIED', 0))
    await expect(
      service.updateMerchantSettings(SAMPLE_MERCHANT_ID, change('BUSINESS', 0)),
    ).rejects.toMatchObject({ code: 'version_conflict' })
    expect((await service.getMerchantSettings(SAMPLE_MERCHANT_ID)).operatingMode).toBe('SIMPLIFIED')
  })

  it('lets members read but only owners change the mode', async () => {
    for (const user of [DEMO_USER_IDS.manager, DEMO_USER_IDS.cashier]) {
      const { service } = createService(user)
      expect(await service.getMerchantSettings(SAMPLE_MERCHANT_ID)).toMatchObject({
        operatingMode: 'BUSINESS',
      })
      await expect(
        service.updateMerchantSettings(SAMPLE_MERCHANT_ID, change('SIMPLIFIED', 0)),
      ).rejects.toMatchObject({ code: 'forbidden' })
      expect((await service.getMerchantSettings(SAMPLE_MERCHANT_ID)).operatingMode).toBe('BUSINESS')
    }
  })

  it('treats another business like a missing one and requires a session', async () => {
    const { service } = createService(DEMO_USER_IDS.cafeOwner)
    await expect(service.getMerchantSettings(SAMPLE_MERCHANT_ID)).rejects.toMatchObject({
      code: 'not_found',
    })
    await expect(
      service.updateMerchantSettings(SAMPLE_MERCHANT_ID, change('SIMPLIFIED', 0)),
    ).rejects.toMatchObject({ code: 'not_found' })
    await expect(
      createService(null).service.getMerchantSettings(SAMPLE_MERCHANT_ID),
    ).rejects.toMatchObject({ code: 'unauthenticated' })
  })

  it('refuses to configure a rejected business', async () => {
    const storage = createMemoryStorage()
    storage.setItem(
      'oupay.mock.merchants',
      JSON.stringify([{ ...SAMPLE_MERCHANTS[0]!, status: 'rejected' }]),
    )
    const { authStore } = createService()
    const service = createMockMerchantService({ delayInMilliseconds: 0, storage, authStore })
    await expect(
      service.updateMerchantSettings(SAMPLE_MERCHANT_ID, change('SIMPLIFIED', 0)),
    ).rejects.toMatchObject({ code: 'profile_locked' })
  })
})

describe('mock merchant service', () => {
  it('creates merchants as pending verification, never active', async () => {
    const merchant = await createService().service.createMerchant(newBusiness)
    expect(merchant.status).toBe('pending_verification')
    expect(merchant.id).toMatch(/^mrc-/)
    expect(merchant.ownerUserId).toBe(DEMO_USER_IDS.owner)
    expect(merchant.bankingConfiguration.status).toBe('not_configured')
    expect(merchant.createdAt).toBe(merchant.updatedAt)
  })

  it('makes the registering user an active OWNER of the new business', async () => {
    const { service, authStore } = createService(DEMO_USER_IDS.newcomer)
    const merchant = await service.createMerchant(newBusiness)
    const membership = authStore
      .loadMemberships()
      .find((m) => m.userId === DEMO_USER_IDS.newcomer && m.merchantId === merchant.id)
    expect(membership).toMatchObject({ role: 'OWNER', status: 'ACTIVE' })
    expect((await service.listMerchantsForCurrentUser()).map(({ id }) => id)).toEqual([merchant.id])
  })

  it('lists only businesses where the user has an ACTIVE membership', async () => {
    const owner = await createService(DEMO_USER_IDS.owner).service.listMerchantsForCurrentUser()
    expect(owner.map(({ id }) => id).sort()).toEqual(
      [SAMPLE_MERCHANT_ID, SAMPLE_SECOND_MERCHANT_ID].sort(),
    )
    for (const user of [DEMO_USER_IDS.suspended, DEMO_USER_IDS.revoked, DEMO_USER_IDS.newcomer]) {
      expect(await createService(user).service.listMerchantsForCurrentUser()).toEqual([])
    }
  })

  it('treats non-members like a missing business', async () => {
    const { service } = createService(DEMO_USER_IDS.newcomer)
    await expect(service.getMerchantById(SAMPLE_MERCHANT_ID)).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('requires a signed-in user for every operation', async () => {
    const { service } = createService(null)
    await expect(service.createMerchant(newBusiness)).rejects.toMatchObject({
      code: 'unauthenticated',
    })
    await expect(service.listMerchantsForCurrentUser()).rejects.toMatchObject({
      code: 'unauthenticated',
    })
  })

  it('returns created merchants by id', async () => {
    const { service } = createService()
    const merchant = await service.createMerchant(newBusiness)
    expect((await service.getMerchantById(merchant.id)).legalName).toBe('Mama Jane Fruits')
  })

  it('rejects an unknown merchant id', async () => {
    await expect(createService().service.getMerchantById('nope')).rejects.toMatchObject({
      code: 'not_found',
    })
  })

  it('rejects duplicate TINs', async () => {
    const { service } = createService()
    const input = { ...newBusiness, registration: { tin: '123456789' } }
    await service.createMerchant(input)
    await expect(service.createMerchant(input)).rejects.toMatchObject({ code: 'duplicate_tin' })
  })

  it('simulates an outage for the reserved TIN', async () => {
    const outcome = createService().service.createMerchant({
      ...newBusiness,
      registration: { tin: SIMULATED_OUTAGE_TIN },
    })
    await expect(outcome).rejects.toBeInstanceOf(MerchantServiceError)
    await expect(outcome).rejects.toMatchObject({ code: 'service_unavailable' })
  })

  it('updates only permitted fields and refreshes updatedAt', async () => {
    const { service } = createService()
    const before = await service.getMerchantById(SAMPLE_MERCHANT_ID)
    const after = await service.updateMerchant(SAMPLE_MERCHANT_ID, {
      tradingName: 'New Name',
      physicalAddress: 'New street',
      contact: { ...before.contact, fullName: 'New Contact' },
    })
    expect(after.tradingName).toBe('New Name')
    expect(after.location.physicalAddress).toBe('New street')
    expect(after.location.district).toBe(before.location.district)
    expect(after.legalName).toBe(before.legalName)
    expect(after.status).toBe(before.status)
    expect(Date.parse(after.updatedAt)).toBeGreaterThan(Date.parse(before.updatedAt))
  })

  it('refuses profile edits from members who are not owners', async () => {
    const edit = {
      physicalAddress: 'New street',
      contact: { fullName: 'X', email: 'x@y.rw', phoneNumber: '+250788000001' },
    }
    for (const user of [DEMO_USER_IDS.manager, DEMO_USER_IDS.cashier]) {
      await expect(
        createService(user).service.updateMerchant(SAMPLE_MERCHANT_ID, edit),
      ).rejects.toMatchObject({ code: 'forbidden' })
    }
  })

  it('persists across service instances sharing storage', async () => {
    const storage = createMemoryStorage()
    const authStore = createMockAuthStore({
      persistentStorage: createMemoryStorage(),
      sessionStorage: createMemoryStorage(),
    })
    authStore.startSession(DEMO_USER_IDS.owner, false, 60_000)
    const first = createMockMerchantService({ delayInMilliseconds: 0, storage, authStore })
    const created = await first.createMerchant(newBusiness)
    const second = createMockMerchantService({ delayInMilliseconds: 0, storage, authStore })
    expect((await second.getMerchantById(created.id)).id).toBe(created.id)
  })
})
