/**
 * Code checkout policy. These mirror the SERVER's rules so the form can guide people; the server (and the mock standing in for
 * it) always re-checks, and the live values come from the code checkout options.
 */
export const CODE_CHECKOUT_MIN_AMOUNT_RWF = 100
export const CODE_CHECKOUT_MAX_AMOUNT_RWF = 10_000_000
export const CODE_CHECKOUT_MAX_DESCRIPTION = 120
export const CODE_CHECKOUT_LIFETIME_MINUTES = 30
export const CODE_CHECKOUT_DEFAULT_DESCRIPTION = 'Payment'

/** Shown wherever a demonstration sale is shown. A simulated code can never take a real payment. */
export const CODE_DEMO_NOTICE =
  'DEMONSTRATION ONLY. This is a simulated code: no real bank payment can be made with it.'
