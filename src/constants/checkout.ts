/**
 * Simplified checkout policy. These mirror the SERVER's rules so the form can guide people; the server
 * (and the mock standing in for it) always re-checks, and the live values come from the checkout options.
 */
export const SIMPLE_CHECKOUT_MIN_AMOUNT_RWF = 100
export const SIMPLE_CHECKOUT_MAX_AMOUNT_RWF = 10_000_000
export const SIMPLE_CHECKOUT_MAX_DESCRIPTION = 120
export const SIMPLE_CHECKOUT_DEFAULT_DESCRIPTION = 'Payment'
export const SIMPLE_CHECKOUT_LIFETIME_MINUTES = 30
export const WALK_IN_CUSTOMER_NAME = 'Walk-in customer'
