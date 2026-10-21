import { CheckoutServiceError } from '@/services/checkoutService'
import { createTestBackend } from '@/test/merchantTestDouble'
import type { SimpleCheckoutInput } from '@/types/checkout'
import { DEMO_USER_IDS } from './sampleAccounts'
import { SAMPLE_MERCHANT_ID } from './sampleMerchants'
import { SAMPLE_BRANCH_IDS } from './sampleOrganization'

const M = SAMPLE_MERCHANT_ID

function setup(user: 'owner' | 'manager' | 'cashier' = 'manager', simplified = true) {
  const t = createTestBackend()
  t.signInAs('owner')
  return (async () => {
    if (simplified) {
      await t.fastMerchants.updateMerchantSettings(M, {
        operatingMode: 'SIMPLIFIED',
        expectedVersion: 0,
      })
    }
    t.signInAs(user)
    return t
  })()
}

let counter = 0
const sale = (overrides: Partial<SimpleCheckoutInput> = {}): SimpleCheckoutInput => {
  counter += 1
  return {
    amountRwf: 5_000,
    clientRequestId: `00000000-0000-4000-8000-${String(counter).padStart(12, '0')}`,
    idempotencyKey: `idem-key-${counter}-${'x'.repeat(8)}`,
    ...overrides,
  }
}

const code = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (error: unknown) => (error instanceof CheckoutServiceError ? error.code : String(error)),
  )

describe('mock simplified checkout (the demo stand-in for the server)', () => {
  it('creates an issued invoice and a fixed 30-minute request, unpaid until a bank event says so', async () => {
    const t = await setup('manager')
    const result = await t.fastCheckout.billSimpleCheckout(
      M,
      sale({ amountRwf: 12_500, description: ' Moto ride ' }),
    )
    expect(result).toMatchObject({
      amountRwf: 12_500,
      currency: 'RWF',
      description: 'Moto ride',
      status: 'CREATED',
      branchId: SAMPLE_BRANCH_IDS.remera,
    })
    expect(result.paymentPath).toBe(`/p/${result.profileToken}/r/${result.publicReference}`)
    const lifetime = Date.parse(result.expiresAt) - Date.parse(result.createdAt)
    expect(lifetime).toBe(30 * 60_000)

    const invoice = await t.fastInvoices.getInvoice(M, result.invoiceId)
    expect(invoice).toMatchObject({
      status: 'ISSUED',
      saleChannel: 'SIMPLIFIED',
      paymentStatus: 'UNPAID',
      grandTotal: 12_500,
      taxTotal: 0,
      customer: { name: 'Walk-in customer' },
      assignedToUserId: DEMO_USER_IDS.manager,
    })
    expect(invoice.items).toHaveLength(1)
    expect(invoice.items[0]).toMatchObject({
      quantity: 1,
      unitPrice: 12_500,
      description: 'Moto ride',
    })
  })

  it('uses the default description when none is given', async () => {
    const t = await setup('manager')
    const result = await t.fastCheckout.billSimpleCheckout(M, sale({ description: '   ' }))
    expect(result.description).toBe('Payment')
  })

  it('refuses anything but a whole amount inside the range, and creates nothing', async () => {
    const t = await setup('manager')
    for (const amountRwf of [99, 0, -5, 10_000_001, 100.5, Number.NaN]) {
      expect(await code(t.fastCheckout.billSimpleCheckout(M, sale({ amountRwf })))).toBe(
        'validation',
      )
    }
    expect(
      await code(t.fastCheckout.billSimpleCheckout(M, sale({ description: 'x'.repeat(121) }))),
    ).toBe('validation')
    expect(await code(t.fastCheckout.billSimpleCheckout(M, sale({ description: 'a\nb' })))).toBe(
      'validation',
    )
    expect(t.store.loadInvoices().filter((i) => i.saleChannel === 'SIMPLIFIED')).toHaveLength(0)
    expect(await code(t.fastCheckout.billSimpleCheckout(M, sale({ amountRwf: 100 })))).toBe('ok')
    expect(await code(t.fastCheckout.billSimpleCheckout(M, sale({ amountRwf: 10_000_000 })))).toBe(
      'ok',
    )
  })

  it('is not available to a business in business mode', async () => {
    const t = await setup('manager', false)
    expect(await code(t.fastCheckout.billSimpleCheckout(M, sale()))).toBe('checkout_not_available')
    expect((await t.fastCheckout.getSimpleCheckoutOptions(M)).readiness).toBe('NOT_SIMPLIFIED')
  })

  it('rejects strangers, other businesses and people without a session', async () => {
    const t = await setup('manager')
    expect(await code(t.fastCheckout.billSimpleCheckout('mrc-someone-else', sale()))).toBe(
      'not_found',
    )
    t.store.endSession()
    expect(await code(t.fastCheckout.billSimpleCheckout(M, sale()))).toBe('unauthenticated')
    t.signInAs('suspended')
    expect(await code(t.fastCheckout.billSimpleCheckout(M, sale()))).toBe('not_found')
  })

  it('picks a single branch itself and requires a valid choice when there are several', async () => {
    const manager = await setup('manager')
    expect((await manager.fastCheckout.getSimpleCheckoutOptions(M)).branches).toHaveLength(1)

    const cashier = await setup('cashier')
    const options = await cashier.fastCheckout.getSimpleCheckoutOptions(M)
    expect(options.branches.map((b) => b.id).sort()).toEqual(
      [SAMPLE_BRANCH_IDS.remera, SAMPLE_BRANCH_IDS.cityCentre].sort(),
    )
    expect(await code(cashier.fastCheckout.billSimpleCheckout(M, sale()))).toBe('branch_required')
    expect(
      await code(
        cashier.fastCheckout.billSimpleCheckout(
          M,
          sale({ branchId: SAMPLE_BRANCH_IDS.nyamirambo }),
        ),
      ),
    ).toBe('branch_not_eligible')
    const ok = await cashier.fastCheckout.billSimpleCheckout(
      M,
      sale({ branchId: SAMPLE_BRANCH_IDS.cityCentre }),
    )
    expect(ok.branchId).toBe(SAMPLE_BRANCH_IDS.cityCentre)
  })

  it('explains the missing branch without creating or assigning anything', async () => {
    const t = await setup('owner')
    const options = await t.fastCheckout.getSimpleCheckoutOptions(M)
    expect(options).toMatchObject({ readiness: 'NO_BRANCH', branches: [] })
    const assignmentsBefore = t.store.loadBranchAssignments().length
    expect(await code(t.fastCheckout.billSimpleCheckout(M, sale()))).toBe('no_eligible_branch')
    expect(t.store.loadBranchAssignments()).toHaveLength(assignmentsBefore)
  })

  it('leaves nothing behind when no payment link can collect', async () => {
    const t = await setup('manager')
    t.ledger.paymentProfiles.save(
      t.ledger.paymentProfiles.load().map((p) => ({ ...p, status: 'INACTIVE' })),
    )
    expect((await t.fastCheckout.getSimpleCheckoutOptions(M)).readiness).toBe('NO_PAYMENT_LINK')
    const invoicesBefore = t.store.loadInvoices().length
    const requestsBefore = t.ledger.paymentRequests.load().length
    expect(await code(t.fastCheckout.billSimpleCheckout(M, sale()))).toBe('no_active_profile')
    expect(t.store.loadInvoices()).toHaveLength(invoicesBefore)
    expect(t.ledger.paymentRequests.load()).toHaveLength(requestsBefore)
  })

  it('repeating the same sale returns the same sale; another sale under the same id is refused', async () => {
    const t = await setup('manager')
    const first = sale({ amountRwf: 7_000 })
    const created = await t.fastCheckout.billSimpleCheckout(M, first)
    const invoicesAfterFirst = t.store.loadInvoices().length

    // Same ids (a lost response retried), and the same sale under a brand-new retry key.
    expect(await t.fastCheckout.billSimpleCheckout(M, first)).toEqual(created)
    const again = await t.fastCheckout.billSimpleCheckout(M, {
      ...first,
      idempotencyKey: 'another-key-1234',
    })
    expect(again.invoiceId).toBe(created.invoiceId)
    expect(again.paymentRequestId).toBe(created.paymentRequestId)
    expect(t.store.loadInvoices()).toHaveLength(invoicesAfterFirst)

    // A different sale with the same permanent id, or a different sale under the same retry key.
    expect(
      await code(
        t.fastCheckout.billSimpleCheckout(M, {
          ...first,
          amountRwf: 7_001,
          idempotencyKey: 'third-key-123456',
        }),
      ),
    ).toBe('client_request_id_reuse')
    expect(
      await code(
        t.fastCheckout.billSimpleCheckout(M, {
          ...sale({ amountRwf: 9_000 }),
          idempotencyKey: first.idempotencyKey,
        }),
      ),
    ).toBe('idempotency_key_reuse')
    expect(t.store.loadInvoices()).toHaveLength(invoicesAfterFirst)
  })

  it('shows a payment as confirmed only after the bank-verified event arrives', async () => {
    const t = await setup('manager')
    const input = sale({ amountRwf: 20_000 })
    const created = await t.fastCheckout.billSimpleCheckout(M, input)
    expect((await t.fastInvoices.getInvoice(M, created.invoiceId)).paymentStatus).toBe('UNPAID')

    await t.fastSimulator.simulateRequestPayment(created.publicReference, 'success')
    const invoice = await t.fastInvoices.getInvoice(M, created.invoiceId)
    expect(invoice.paymentStatus).toBe('PAID')
    const requests = await t.fastProfiles.listInvoicePaymentRequests(M, created.invoiceId)
    expect(requests[0]?.status).toBe('SETTLED')

    // The same sale retried afterwards reports its CURRENT state and opens nothing new.
    const requestsBefore = t.ledger.paymentRequests.load().length
    const retried = await t.fastCheckout.billSimpleCheckout(M, input)
    expect(retried.status).toBe('SETTLED')
    expect(retried.paymentRequestId).toBe(created.paymentRequestId)
    expect(t.ledger.paymentRequests.load()).toHaveLength(requestsBefore)
  })
})
