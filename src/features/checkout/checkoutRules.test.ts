import { createMemoryStorage } from '@/test/merchantTestDouble'
import { describeSaleStatus, parseAmountInput } from './checkoutRules'
import { attemptFor, forgetAttempt, loadSale, payloadKeyOf, rememberSale } from './checkoutSession'
import type { SimpleCheckoutResult } from '@/types/checkout'
import type { InvoicePaymentStatus } from '@/types/invoice'

const MIN = 100
const MAX = 10_000_000

describe('parseAmountInput', () => {
  it.each([
    ['100', 100],
    ['25000', 25_000],
    ['25,000', 25_000],
    ['25 000', 25_000],
    [' 1 000 000 ', 1_000_000],
    ['10,000,000', 10_000_000],
    ['0100', 100],
  ])('accepts %s as %i francs', (raw, amount) => {
    expect(parseAmountInput(raw, MIN, MAX)).toEqual({ ok: true, amount })
  })

  it.each([
    ['', 'Enter the amount to collect.'],
    ['   ', 'Enter the amount to collect.'],
  ])('asks for an amount when %j is typed', (raw, message) => {
    expect(parseAmountInput(raw, MIN, MAX)).toEqual({ ok: false, message })
  })

  it.each(['12.5', '12,5.0', '-100', '+100', '1e3', '0x10', 'abc', '100 RWF', '١٠٠', '1_000'])(
    'refuses %j: whole francs only',
    (raw) => {
      const result = parseAmountInput(raw, MIN, MAX)
      expect(result.ok).toBe(false)
    },
  )

  it.each(['99', '0', '10000001', '99999999999999999999'])('refuses %s as out of range', (raw) => {
    const result = parseAmountInput(raw, MIN, MAX)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toContain('between RWF 100 and RWF 10,000,000')
  })
})

describe('describeSaleStatus: only server facts decide the outcome', () => {
  const invoice = (
    paymentStatus: InvoicePaymentStatus,
    status: 'ISSUED' | 'VOIDED' | 'CANCELLED' = 'ISSUED',
  ) => ({ status, paymentStatus })

  it('awaiting payment is the state of a request nobody has paid', () => {
    for (const request of ['CREATED', 'AWAITING_PAYMENT'] as const) {
      expect(describeSaleStatus(request, invoice('UNPAID'))).toMatchObject({
        stage: 'AWAITING_PAYMENT',
        isLive: true,
        isFinished: false,
      })
    }
    // Before the first read the answer to the bill alone is used.
    expect(describeSaleStatus('AWAITING_PAYMENT', undefined).stage).toBe('AWAITING_PAYMENT')
  })

  it('confirmed needs BOTH the settled request AND an invoice reconciled as paid', () => {
    expect(describeSaleStatus('SETTLED', invoice('PAID'))).toMatchObject({
      stage: 'CONFIRMED',
      label: 'Payment confirmed',
      isLive: false,
      isFinished: true,
    })
    // A settled request with an unreconciled invoice is never shown as success.
    expect(describeSaleStatus('SETTLED', invoice('UNPAID')).stage).toBe('NEEDS_ATTENTION')
    expect(describeSaleStatus('SETTLED', undefined).stage).toBe('NEEDS_ATTENTION')
  })

  it('partly paid stays live; partly paid then expired needs attention', () => {
    expect(describeSaleStatus('PARTIALLY_SETTLED', invoice('PARTIALLY_PAID'))).toMatchObject({
      stage: 'PARTIALLY_PAID',
      isLive: true,
    })
    expect(describeSaleStatus('EXPIRED', invoice('PARTIALLY_PAID')).stage).toBe('NEEDS_ATTENTION')
  })

  it('expired and cancelled finish the sale', () => {
    expect(describeSaleStatus('EXPIRED', invoice('UNPAID'))).toMatchObject({
      stage: 'EXPIRED',
      isLive: false,
      isFinished: true,
    })
    expect(describeSaleStatus('CANCELLED', invoice('UNPAID')).stage).toBe('CANCELLED')
    expect(describeSaleStatus('AWAITING_PAYMENT', invoice('UNPAID', 'VOIDED')).stage).toBe(
      'CANCELLED',
    )
  })

  it('a partly paid sale reports the exact figures the bank-reconciled invoice holds', () => {
    const status = describeSaleStatus('PARTIALLY_SETTLED', {
      status: 'ISSUED',
      paymentStatus: 'PARTIALLY_PAID',
      payment: {
        invoiceTotal: 20_000,
        allocatedAmount: 8_000,
        remainingBalance: 12_000,
        unappliedAmount: 0,
        paymentStatus: 'PARTIALLY_PAID',
      },
    })
    expect(status.detail).toBe('RWF 8,000 confirmed by the bank. RWF 12,000 is still due.')
  })

  it('a payment that is reversed after confirmation is no longer paid: only the latest reading counts', () => {
    expect(describeSaleStatus('SETTLED', invoice('PAID')).stage).toBe('CONFIRMED')
    expect(describeSaleStatus('AWAITING_PAYMENT', invoice('UNPAID')).stage).toBe('AWAITING_PAYMENT')
  })

  it('overpaid and refunded payments need attention', () => {
    expect(describeSaleStatus('SETTLED', invoice('OVERPAID')).stage).toBe('NEEDS_ATTENTION')
    expect(describeSaleStatus('SETTLED', invoice('REFUNDED')).stage).toBe('NEEDS_ATTENTION')
  })
})

describe('the billing attempt: the same sale keeps its ids, a different sale gets new ones', () => {
  const sale: SimpleCheckoutResult = {
    invoiceId: 'inv-1',
    invoiceNumber: 'INV-0001',
    paymentRequestId: 'pr-1',
    publicReference: 'OP-ABCDEFGH',
    amountRwf: 5_000,
    currency: 'RWF',
    description: 'Payment',
    status: 'AWAITING_PAYMENT',
    expiresAt: '2026-01-01T00:30:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    merchantDisplayName: 'Shop',
    branchId: 'b1',
    branchName: 'Main',
    profileToken: 'Rk4mQ8vTz2Xn',
    paymentPath: '/p/Rk4mQ8vTz2Xn/r/OP-ABCDEFGH',
  }

  it('reuses the ids for the same sale (a retry after a lost answer) and renews them for another', () => {
    const storage = createMemoryStorage() as unknown as Storage
    const key = payloadKeyOf(5_000, ' Moto ', 'b1')
    const first = attemptFor('m1', key, storage)
    expect(attemptFor('m1', payloadKeyOf(5_000, 'Moto', 'b1'), storage)).toEqual(first)
    const edited = attemptFor('m1', payloadKeyOf(5_500, 'Moto', 'b1'), storage)
    expect(edited.clientRequestId).not.toBe(first.clientRequestId)
    expect(edited.idempotencyKey).not.toBe(first.idempotencyKey)
  })

  it('forgets the attempt once the sale is done, so the next identical sale is a new one', () => {
    const storage = createMemoryStorage() as unknown as Storage
    const key = payloadKeyOf(5_000, '', 'b1')
    const first = attemptFor('m1', key, storage)
    forgetAttempt('m1', storage)
    expect(attemptFor('m1', key, storage).clientRequestId).not.toBe(first.clientRequestId)
  })

  it('keeps each business apart and works without any storage', () => {
    const storage = createMemoryStorage() as unknown as Storage
    const key = payloadKeyOf(5_000, '', 'b1')
    expect(attemptFor('m1', key, storage).clientRequestId).not.toBe(
      attemptFor('m2', key, storage).clientRequestId,
    )
    const first = attemptFor('m1', key, undefined)
    expect(first.clientRequestId).toMatch(/^[0-9a-f-]{36}$/)
    expect(loadSale('m1', undefined)).toBeUndefined()
    rememberSale('m1', sale, undefined)
  })

  it('refuses a remembered sale that was edited into something the server would never produce', () => {
    const storage = createMemoryStorage() as unknown as Storage
    for (const tampered of [
      { ...sale, profileToken: 'x/../admin' },
      { ...sale, publicReference: 'OP-1"><script>' },
      { ...sale, paymentPath: 'https://evil.example/pay' },
      { ...sale, amountRwf: 12.5 },
      { ...sale, currency: 'USD' },
      'not an object',
    ]) {
      storage.setItem('oupay.checkout.sale.m1.u1', JSON.stringify(tampered))
      expect(loadSale('m1.u1', storage)).toBeUndefined()
    }
    storage.setItem('oupay.checkout.sale.m1.u1', '{broken json')
    expect(loadSale('m1.u1', storage)).toBeUndefined()
  })

  it('keeps one persons sale from another person in the same business and tab', () => {
    const storage = createMemoryStorage() as unknown as Storage
    rememberSale('m1.alice', sale, storage)
    expect(loadSale('m1.bob', storage)).toBeUndefined()
    expect(loadSale('m1.alice', storage)).toEqual(sale)
  })

  it('remembers the sale on screen per business', () => {
    const storage = createMemoryStorage() as unknown as Storage
    rememberSale('m1', sale, storage)
    expect(loadSale('m1', storage)).toEqual(sale)
    expect(loadSale('m2', storage)).toBeUndefined()
  })
})
