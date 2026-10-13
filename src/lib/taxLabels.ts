import { effectiveRateBp } from '@/lib/invoiceCalculations'
import { formatBasisPoints } from '@/lib/format'
import type { TaxRate } from '@/types/invoice'

/** "No VAT", "VAT-exempt", "Zero-rated", or "VAT 18%". */
export function describeTaxRate(taxRate: TaxRate): string {
  switch (taxRate.category) {
    case 'NOT_APPLICABLE':
      return 'No VAT'
    case 'EXEMPT':
      return 'VAT-exempt'
    case 'ZERO_RATED':
      return 'Zero-rated'
    case 'STANDARD':
      return `VAT ${formatBasisPoints(effectiveRateBp(taxRate))}`
  }
}
