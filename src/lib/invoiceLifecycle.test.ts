import type { InvoicePaymentStatus, InvoiceStatus } from '@/types/invoice'
import {
  canTransitionInvoice,
  INVOICE_STATUS_TRANSITIONS,
  isInvoiceEditable,
  isInvoiceOverdue,
  isVoidAllowedByPolicy,
  todayInKigali,
} from './invoiceLifecycle'

const STATUSES: InvoiceStatus[] = ['DRAFT', 'ISSUED', 'CANCELLED', 'VOIDED']

describe('invoice lifecycle', () => {
  it('allows exactly the documented transitions', () => {
    const allowed = new Set(['DRAFT>ISSUED', 'DRAFT>CANCELLED', 'ISSUED>VOIDED'])
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        expect(canTransitionInvoice(from, to)).toBe(allowed.has(`${from}>${to}`))
      }
    }
  })

  it('treats cancelled and voided invoices as final', () => {
    expect(INVOICE_STATUS_TRANSITIONS.CANCELLED).toEqual([])
    expect(INVOICE_STATUS_TRANSITIONS.VOIDED).toEqual([])
  })

  it('does not let an issued invoice be cancelled or returned to draft', () => {
    expect(canTransitionInvoice('ISSUED', 'CANCELLED')).toBe(false)
    expect(canTransitionInvoice('ISSUED', 'DRAFT')).toBe(false)
  })

  it('only lets drafts change content', () => {
    expect(STATUSES.filter((status) => isInvoiceEditable({ status }))).toEqual(['DRAFT'])
  })

  it('voids only issued invoices with no payment activity', () => {
    const payments: InvoicePaymentStatus[] = [
      'UNPAID',
      'PARTIALLY_PAID',
      'PAID',
      'OVERPAID',
      'REFUNDED',
    ]
    for (const paymentStatus of payments) {
      expect(isVoidAllowedByPolicy({ status: 'ISSUED', paymentStatus })).toBe(
        paymentStatus === 'UNPAID',
      )
      expect(isVoidAllowedByPolicy({ status: 'DRAFT', paymentStatus })).toBe(false)
    }
  })
})

describe('overdue is derived, never stored', () => {
  const today = '2026-10-12'
  const base = { status: 'ISSUED', paymentStatus: 'UNPAID', dueAt: '2026-10-11' } as const

  it('flags issued, unsettled invoices past due', () => {
    expect(isInvoiceOverdue(base, today)).toBe(true)
    expect(isInvoiceOverdue({ ...base, paymentStatus: 'PARTIALLY_PAID' }, today)).toBe(true)
  })

  it('does not flag the due date itself, settled, draft or closed invoices', () => {
    expect(isInvoiceOverdue({ ...base, dueAt: today }, today)).toBe(false)
    expect(isInvoiceOverdue({ ...base, paymentStatus: 'PAID' }, today)).toBe(false)
    for (const status of ['DRAFT', 'CANCELLED', 'VOIDED'] as const) {
      expect(isInvoiceOverdue({ ...base, status }, today)).toBe(false)
    }
  })

  it('reads today in Rwanda time, not UTC', () => {
    // 23:30 UTC on the 11th is already 01:30 on the 12th in Kigali (UTC+2).
    expect(todayInKigali(new Date('2026-10-11T23:30:00Z'))).toBe('2026-10-12')
  })
})
