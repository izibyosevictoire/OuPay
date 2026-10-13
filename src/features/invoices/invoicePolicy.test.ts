import type { BusinessRole } from '@/types/auth'
import type { InvoicePaymentStatus, InvoiceStatus } from '@/types/invoice'
import { canPerformInvoiceAction, type InvoiceAction } from './invoicePolicy'

const invoice = (
  status: InvoiceStatus,
  assignedToUserId = 'cashier-1',
  paymentStatus: InvoicePaymentStatus = 'UNPAID',
) => ({ status, paymentStatus, assignedToUserId })

const can = (
  role: BusinessRole | null,
  userId: string,
  inv: ReturnType<typeof invoice>,
  action: InvoiceAction,
) => canPerformInvoiceAction(role, userId, inv, action)

describe('who may act on an invoice', () => {
  it('lets owners and managers view any invoice, cashiers only their own', () => {
    expect(can('OWNER', 'o', invoice('ISSUED'), 'view')).toBe(true)
    expect(can('MANAGER', 'm', invoice('ISSUED'), 'view')).toBe(true)
    expect(can('CASHIER', 'cashier-1', invoice('ISSUED'), 'view')).toBe(true)
    expect(can('CASHIER', 'cashier-2', invoice('ISSUED'), 'view')).toBe(false)
    expect(can(null, 'x', invoice('ISSUED'), 'view')).toBe(false)
  })

  it('limits draft edits, issuing and cancelling to drafts the person can see', () => {
    for (const action of ['edit_draft', 'issue', 'cancel_draft'] as const) {
      expect(can('OWNER', 'o', invoice('DRAFT'), action)).toBe(true)
      expect(can('MANAGER', 'm', invoice('DRAFT'), action)).toBe(true)
      expect(can('CASHIER', 'cashier-1', invoice('DRAFT'), action)).toBe(true)
      expect(can('CASHIER', 'cashier-2', invoice('DRAFT'), action)).toBe(false)
      for (const status of ['ISSUED', 'CANCELLED', 'VOIDED'] as const) {
        expect(can('OWNER', 'o', invoice(status), action)).toBe(false)
      }
    }
  })

  it('lets only owners void, and only unpaid issued invoices', () => {
    expect(can('OWNER', 'o', invoice('ISSUED'), 'void')).toBe(true)
    expect(can('MANAGER', 'm', invoice('ISSUED'), 'void')).toBe(false)
    expect(can('CASHIER', 'cashier-1', invoice('ISSUED'), 'void')).toBe(false)
    expect(can('OWNER', 'o', invoice('ISSUED', 'x', 'PAID'), 'void')).toBe(false)
    expect(can('OWNER', 'o', invoice('DRAFT'), 'void')).toBe(false)
  })
})
