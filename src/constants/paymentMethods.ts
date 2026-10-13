import type { PaymentMethodDefinition } from '@/types/paymentProfile'

/**
 * Payment methods OuPay knows about. Whether one is USABLE is decided per merchant from the
 * provider's capabilities and the merchant's banking configuration, never from this list.
 */
export const PAYMENT_METHODS: PaymentMethodDefinition[] = [
  { id: 'EQUITY_MERCHANT', label: 'Equity Bank merchant payment', providerId: 'EQUITY_MOCK' },
  { id: 'MTN_MOMO', label: 'MTN MoMo', providerId: 'MTN_MOMO' },
  { id: 'AIRTEL_MONEY', label: 'Airtel Money', providerId: 'AIRTEL_MONEY' },
]

export const MINIMUM_OPEN_PAYMENT_AMOUNT = 100
export const MAXIMUM_OPEN_PAYMENT_AMOUNT = 10_000_000
/** How long an open payment request stays payable. */
export const OPEN_REQUEST_LIFETIME_MINUTES = 30
/** How long an invoice payment request stays payable. */
export const INVOICE_REQUEST_LIFETIME_DAYS = 7
