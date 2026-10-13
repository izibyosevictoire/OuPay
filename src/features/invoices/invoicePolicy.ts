import { canAccessResource, hasPermission } from '@/features/auth/permissions/permissions'
import { isInvoiceEditable, isVoidAllowedByPolicy } from '@/lib/invoiceLifecycle'
import type { BusinessRole } from '@/types/auth'
import type { Invoice } from '@/types/invoice'

export type InvoiceAction = 'view' | 'edit_draft' | 'issue' | 'cancel_draft' | 'void'

type InvoiceFacts = Pick<Invoice, 'status' | 'paymentStatus' | 'assignedToUserId'>

/**
 * Who may do what to one invoice, built from the central permission table plus the
 * lifecycle rules:
 * - view: `invoices:view`. Owners and managers see every invoice of their business;
 *   cashiers only invoices assigned to them.
 * - edit/issue/cancel a DRAFT: anyone who can view it and holds `invoices:create`.
 * - void an issued, unpaid invoice: `invoices:void` (owners only).
 * The mock service calls this same function, and a real backend must enforce it itself.
 */
export function canPerformInvoiceAction(
  role: BusinessRole | null | undefined,
  userId: string | null | undefined,
  invoice: InvoiceFacts,
  action: InvoiceAction,
): boolean {
  const canView = canAccessResource(
    role,
    'invoices:view',
    { assignedUserId: invoice.assignedToUserId },
    userId,
  )
  if (!canView) return false
  switch (action) {
    case 'view':
      return true
    case 'edit_draft':
    case 'issue':
    case 'cancel_draft':
      return hasPermission(role, 'invoices:create') && isInvoiceEditable(invoice)
    case 'void':
      return hasPermission(role, 'invoices:void') && isVoidAllowedByPolicy(invoice)
  }
}
