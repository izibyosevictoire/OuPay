import { customerStatusOf, isFinishedStatus } from '@/lib/codeSaleStatus'
import {
  attemptFor,
  forgetAttempt,
  forgetSale,
  loadSale,
  payloadKeyOf,
  rememberSale,
} from './codeCheckoutSession'

describe('customerStatusOf: paid only after verified money was applied to the sale', () => {
  it('maps the server status and stage', () => {
    expect(customerStatusOf('CREATED', 'AWAITING_PAYMENT')).toBe('AWAITING_PAYMENT')
    expect(customerStatusOf('AWAITING_PAYMENT', 'BANK_CONFIRMATION_PENDING')).toBe(
      'AWAITING_PAYMENT',
    )
    expect(customerStatusOf('PARTIALLY_SETTLED', 'PARTIALLY_SETTLED')).toBe('PARTIALLY_PAID')
    expect(customerStatusOf('SETTLED', 'CONFIRMED_AND_RECONCILED')).toBe('PAID')
    expect(customerStatusOf('EXPIRED', 'EXPIRED')).toBe('EXPIRED')
    expect(customerStatusOf('CANCELLED', 'CANCELLED')).toBe('CANCELLED')
  })

  it('never shows confirmed-but-unapplied or reversed money as paid', () => {
    expect(customerStatusOf('AWAITING_PAYMENT', 'CONFIRMED_UNMATCHED')).toBe(
      'REQUIRES_RECONCILIATION',
    )
    expect(customerStatusOf('SETTLED', 'CONFIRMED_UNMATCHED')).toBe('REQUIRES_RECONCILIATION')
    expect(customerStatusOf('SETTLED', 'REVERSED')).toBe('REQUIRES_RECONCILIATION')
  })

  it('knows which statuses are finished', () => {
    expect(isFinishedStatus('PAID')).toBe(true)
    expect(isFinishedStatus('EXPIRED')).toBe(true)
    expect(isFinishedStatus('AWAITING_PAYMENT')).toBe(false)
    expect(isFinishedStatus('PARTIALLY_PAID')).toBe(false)
    expect(isFinishedStatus('REQUIRES_RECONCILIATION')).toBe(false)
  })
})

describe('the remembered attempt and sale', () => {
  const scope = 'mrc-1.usr-1'

  it('gives the same sale the same ids, and a changed sale new ones', () => {
    const storage = window.sessionStorage
    storage.clear()
    const first = attemptFor(scope, payloadKeyOf(5_000, ' Lunch ', 'cc-1'), storage)
    expect(attemptFor(scope, payloadKeyOf(5_000, 'Lunch', 'cc-1'), storage)).toEqual(first)
    const changed = attemptFor(scope, payloadKeyOf(6_000, 'Lunch', 'cc-1'), storage)
    expect(changed.clientRequestId).not.toBe(first.clientRequestId)
    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey)
    forgetAttempt(scope, storage)
    expect(
      attemptFor(scope, payloadKeyOf(6_000, 'Lunch', 'cc-1'), storage).clientRequestId,
    ).not.toBe(changed.clientRequestId)
  })

  it('keeps only the sale id and reference, and nothing else', () => {
    const storage = window.sessionStorage
    storage.clear()
    rememberSale(
      scope,
      { saleId: 'pr-abcdef12', saleReference: 'OP-ABCDEF12', bankCode: 'EQ-1' } as never,
      storage,
    )
    expect(storage.getItem(`oupay.codeCheckout.sale.${scope}`)).not.toContain('EQ-1')
    expect(loadSale(scope, storage)).toEqual({
      saleId: 'pr-abcdef12',
      saleReference: 'OP-ABCDEF12',
    })
    forgetSale(scope, storage)
    expect(loadSale(scope, storage)).toBeUndefined()
  })

  it('rejects a tampered or malformed remembered sale', () => {
    const storage = window.sessionStorage
    storage.clear()
    for (const value of [
      '{"saleId":"x","saleReference":"OP-ABCDEF12"}',
      '{"saleId":"pr-abcdef12","saleReference":"javascript:alert(1)"}',
      '{"saleId":42,"saleReference":"OP-ABCDEF12"}',
      'not json',
      'null',
    ]) {
      storage.setItem(`oupay.codeCheckout.sale.${scope}`, value)
      expect(loadSale(scope, storage)).toBeUndefined()
    }
  })

  it('is scoped to the business and the person', () => {
    const storage = window.sessionStorage
    storage.clear()
    rememberSale(scope, { saleId: 'pr-abcdef12', saleReference: 'OP-ABCDEF12' }, storage)
    expect(loadSale('mrc-1.usr-2', storage)).toBeUndefined()
  })

  it('still works when storage is unavailable', () => {
    expect(() => attemptFor(scope, 'k', undefined)).not.toThrow()
    expect(loadSale(scope, undefined)).toBeUndefined()
  })
})
