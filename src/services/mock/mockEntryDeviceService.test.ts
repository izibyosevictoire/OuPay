import { EntryDeviceServiceError } from '@/services/entryDeviceService'
import { createTestBackend } from '@/test/merchantTestDouble'
import { DEMO_USER_IDS } from './sampleAccounts'
import { createMockEntryDevices } from './mockEntryDeviceService'
import { SAMPLE_MERCHANT_ID } from './sampleMerchants'
import { SAMPLE_BRANCH_IDS } from './sampleOrganization'

const M = SAMPLE_MERCHANT_ID
type Backend = ReturnType<typeof createTestBackend>

let counter = 0
const id = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, '0')}`

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: unknown) => (error instanceof EntryDeviceServiceError ? error.code : String(error)),
  )

/** The mock entry devices over the SAME mock sales as every other screen, with a clock the test controls. */
function setup() {
  const t: Backend = createTestBackend()
  let now = Date.parse('2026-11-03T08:00:00Z')
  const entry = createMockEntryDevices({
    authStore: t.store,
    publicCodeSaleService: t.fastCodeCheckout.publicCodeSaleService,
    merchantStorage: t.merchantStorage,
    delayInMilliseconds: 0,
    now: () => now,
  })
  return { t, ...entry, advance: (ms: number) => (now += ms) }
}

async function demoSale(t: Backend, amountRwf = 5_000) {
  t.signInAs('owner')
  const profile = t.ledger.paymentProfiles
    .load()
    .find((p) => p.merchantId === M && p.status === 'ACTIVE' && p.assignedCashierId === null)
  const destination = t.ledger.paymentDestinations.load().find((d) => d.id === profile?.paymentDestinationId)
  if (!destination) throw new Error('no destination')
  const requested = await t.fastCollectionCodes.requestCode(M, {
    clientOperationId: crypto.randomUUID(),
    settlementDestinationId: destination.id,
    displayLabel: 'Demo counter',
    branchId: SAMPLE_BRANCH_IDS.remera,
  })
  await t.fastCollectionCodes.assign(M, requested.code.id, { membershipId: 'mem-004' })
  t.signInAs('cashier')
  return t.fastCodeCheckout.codeCheckoutService.billCodeSale(M, {
    amountRwf,
    collectionCodeId: requested.code.id,
    clientRequestId: id(),
    idempotencyKey: `idem-key-${counter}-${'x'.repeat(8)}`,
  })
}

async function ownerDevice(s: ReturnType<typeof setup>, name = 'Counter 1', cashier: string | null = DEMO_USER_IDS.cashier) {
  s.t.signInAs('owner')
  const { device } = await s.entryDeviceService.registerDevice(M, {
    clientRequestId: id(),
    deviceType: 'STATIC_QR',
    displayName: name,
    branchId: SAMPLE_BRANCH_IDS.remera,
    assignedCashierUserId: cashier,
  })
  return device
}

describe('mock payment-entry devices make the decisions the server makes', () => {
  it('registers once per request id, keeps one permanent opaque path, and refuses a cashier outside the branch', async () => {
    const s = setup()
    s.t.signInAs('owner')
    const input = {
      clientRequestId: id(),
      deviceType: 'NFC_TAG' as const,
      displayName: 'Door tag',
      branchId: SAMPLE_BRANCH_IDS.remera,
      assignedCashierUserId: null,
    }
    const first = await s.entryDeviceService.registerDevice(M, input)
    const again = await s.entryDeviceService.registerDevice(M, input)
    expect(first.replayed).toBe(false)
    expect(again.replayed).toBe(true)
    expect(again.device.id).toBe(first.device.id)
    expect(first.device.entryPath).toMatch(/^\/e\/[A-Za-z0-9_-]{22}$/)
    expect(first.device.entryPath).not.toContain(M)
    expect(await code(s.entryDeviceService.registerDevice(M, { ...input, clientRequestId: id(), displayName: 'Other', assignedCashierUserId: 'nobody' }))).toBe('cashier_not_eligible')
    expect(await code(s.entryDeviceService.registerDevice(M, { ...input, displayName: 'Changed' }))).toBe('client_request_id_reuse')
    expect(await code(s.entryDeviceService.registerDevice(M, { ...input, clientRequestId: id(), deviceType: 'NFC_BRACELET', displayName: 'Loose' }))).toBe('validation')
    // A cashier can never register one.
    s.t.signInAs('cashier')
    expect(await code(s.entryDeviceService.registerDevice(M, { ...input, clientRequestId: id(), displayName: 'Mine' }))).toBe('forbidden')
  })

  it('leads a device to one explicit bill, never falls back to another, and refuses a second open bill', async () => {
    const s = setup()
    const device = await ownerDevice(s)
    const first = await demoSale(s.t, 5_000)
    const second = await demoSale(s.t, 6_000)
    s.t.signInAs('cashier')
    expect((await s.publicEntryService.resolve(device.entryPath.slice(3))).state).toBe('IDLE')
    const bound = await s.entryDeviceService.bindSale(M, device.id, { saleId: first.saleId, expectedVersion: device.version })
    expect(bound.binding?.saleReference).toBe(first.saleReference)
    expect(await code(s.entryDeviceService.bindSale(M, device.id, { saleId: second.saleId, expectedVersion: bound.version }))).toBe('device_has_open_bill')
    // The bill already leads from this device: it can not also lead from another one.
    const other = await ownerDevice(s, 'Counter 2')
    s.t.signInAs('cashier')
    expect(await code(s.entryDeviceService.bindSale(M, other.id, { saleId: first.saleId, expectedVersion: other.version }))).toBe('sale_already_bound')
    const closed = await s.entryDeviceService.unbindSale(M, device.id, { reason: 'Done', confirmActiveSession: false })
    expect(closed.binding).toBeNull()
  })

  it('gives the device to ONE customer, shows everyone else "busy" without detail, and keeps the holder on their bill', async () => {
    const s = setup()
    const device = await ownerDevice(s)
    const sale = await demoSale(s.t, 9_000)
    s.t.signInAs('cashier')
    await s.entryDeviceService.bindSale(M, device.id, { saleId: sale.saleId, expectedVersion: device.version })
    const token = device.entryPath.slice(3)
    // Reading never takes it.
    expect((await s.publicEntryService.resolve(token)).state).toBe('READY')
    expect((await s.publicEntryService.resolve(token)).sale).toBeNull()
    const first = await s.publicEntryService.claim(token)
    expect(first.state).toBe('CLAIMED')
    expect(first.claim?.claimToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.sale?.amountRwf).toBe(9_000)
    const second = await s.publicEntryService.claim(token)
    expect(second).toMatchObject({ state: 'BUSY', sale: null, claim: null })
    expect(JSON.stringify(second)).not.toContain(sale.saleReference)
    const holder = await s.publicEntryService.resolve(token, first.claim?.claimToken)
    expect(holder.state).toBe('CLAIMED')
    expect(holder.sale?.saleReference).toBe(sale.saleReference)
    // The counter is warned before cutting a session off.
    expect(await code(s.entryDeviceService.unbindSale(M, device.id, { reason: 'Next', confirmActiveSession: false }))).toBe('customer_session_active')
  })

  it('treats a timeout as the end of a session, not a failure, and frees the device for the next customer', async () => {
    const s = setup()
    const device = await ownerDevice(s)
    const sale = await demoSale(s.t)
    s.t.signInAs('cashier')
    await s.entryDeviceService.bindSale(M, device.id, { saleId: sale.saleId, expectedVersion: device.version })
    const token = device.entryPath.slice(3)
    const first = await s.publicEntryService.claim(token)
    s.advance(6 * 60 * 1000)
    const back = await s.publicEntryService.resolve(token, first.claim?.claimToken)
    expect(back.state).toBe('SESSION_ENDED')
    expect(back.sale?.saleReference).toBe(sale.saleReference)
    expect(back.message).not.toMatch(/fail/i)
    expect((await s.publicEntryService.claim(token)).state).toBe('CLAIMED')
  })

  it('answers every unusable token identically, and a revoked device becomes unavailable at once', async () => {
    const s = setup()
    const device = await ownerDevice(s)
    const token = device.entryPath.slice(3)
    const unknown = await s.publicEntryService.resolve('AAAAAAAAAAAAAAAAAAAAAA')
    for (const odd of ['short', 'x'.repeat(300), 'AAAAAAAAAAAAAAAAAAAAAB']) {
      expect(await s.publicEntryService.resolve(odd)).toEqual(unknown)
    }
    expect(unknown.state).toBe('UNAVAILABLE')
    s.t.signInAs('owner')
    await s.entryDeviceService.revokeDevice(M, device.id, { expectedVersion: device.version, reason: 'Lost' })
    expect(await s.publicEntryService.resolve(token)).toEqual(unknown)
    expect(await code(s.entryDeviceService.reactivateDevice(M, device.id, { expectedVersion: 1, reason: 'Undo' }))).toBe('device_status_invalid')
  })

  it('keeps tenants apart and the cashier to their own devices', async () => {
    const s = setup()
    const mine = await ownerDevice(s, 'Aline counter', DEMO_USER_IDS.cashier)
    await ownerDevice(s, 'Someone else', null)
    s.t.signInAs('cashier')
    const visible = await s.entryDeviceService.listDevices(M)
    // A cashier sees the devices assigned to them and the shared ones at their branch.
    expect(visible.map((d) => d.displayName).sort()).toEqual(['Aline counter', 'Someone else'])
    expect(await code(s.entryDeviceService.revokeDevice(M, mine.id, { expectedVersion: 0, reason: 'No' }))).toBe('forbidden')
    expect(await code(s.entryDeviceService.getDevice('another-merchant', mine.id))).toBe('not_found')
  })

  it('recovers a lost claim answer when the browser proposed its own token, and never adopts a token that is already in use', async () => {
    const s = setup()
    const device = await ownerDevice(s)
    const sale = await demoSale(s.t)
    s.t.signInAs('cashier')
    await s.entryDeviceService.bindSale(M, device.id, { saleId: sale.saleId, expectedVersion: device.version })
    const token = device.entryPath.slice(3)
    const mine = 'M'.repeat(43)
    const first = await s.publicEntryService.claim(token, mine)
    expect(first.state).toBe('CLAIMED')
    expect(first.claim?.claimToken).toBeNull()
    // The same request again (the answer was lost) is the same claim, not a second one and not "busy".
    expect((await s.publicEntryService.claim(token, mine)).state).toBe('CLAIMED')
    expect((await s.publicEntryService.claim(token, 'N'.repeat(43))).state).toBe('BUSY')
    // After the session ends, the used token is not reused: the server mints a new one.
    s.advance(6 * 60 * 1000)
    const again = await s.publicEntryService.claim(token, mine)
    expect(again.state).toBe('CLAIMED')
    expect(again.claim?.claimToken).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(again.claim?.claimToken).not.toBe(mine)
  })

  it('lets a customer who holds a claim keep seeing their own bill after the device is suspended or revoked, and nobody else', async () => {
    const s = setup()
    const device = await ownerDevice(s)
    const sale = await demoSale(s.t)
    s.t.signInAs('cashier')
    const bound = await s.entryDeviceService.bindSale(M, device.id, { saleId: sale.saleId, expectedVersion: device.version })
    const token = device.entryPath.slice(3)
    const held = await s.publicEntryService.claim(token)
    const claim = held.claim?.claimToken
    s.t.signInAs('owner')
    const suspended = await s.entryDeviceService.suspendDevice(M, device.id, { expectedVersion: bound.version, reason: 'Checking' })
    const unknown = await s.publicEntryService.resolve('AAAAAAAAAAAAAAAAAAAAAA')
    expect(await s.publicEntryService.resolve(token)).toEqual(unknown)
    const holder = await s.publicEntryService.resolve(token, claim)
    expect(holder.state).toBe('SESSION_ENDED')
    expect(holder.claim?.endReason).toBe('DEVICE_SUSPENDED')
    expect(holder.sale?.saleReference).toBe(sale.saleReference)
    await s.entryDeviceService.revokeDevice(M, device.id, { expectedVersion: suspended.version, reason: 'Lost' })
    expect(await s.publicEntryService.resolve(token)).toEqual(unknown)
    expect((await s.publicEntryService.claim(token, claim)).state).toBe('SESSION_ENDED')
    expect((await s.publicEntryService.resolve(token, claim)).claim?.endReason).toBe('DEVICE_REVOKED')
  })
})
