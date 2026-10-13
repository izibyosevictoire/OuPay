import type { InvoiceFormOptions } from '@/types/invoice'

/** An invoice needs at least one active branch with a cashier assigned to it. */
export const hasEligibleSeller = (options: InvoiceFormOptions) =>
  options.branches.length > 0 && options.assignees.length > 0
