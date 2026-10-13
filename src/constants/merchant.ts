import type { BusinessType, MerchantStatus } from '@/types/merchant'

export const BUSINESS_TYPE_LABELS: Record<BusinessType, string> = {
  registered_company: 'Registered company',
  cooperative: 'Cooperative',
  non_profit: 'Non-profit / association',
  sole_proprietor: 'Sole proprietor (individual business)',
  informal_vendor: 'Informal vendor or independent service provider',
}

export const BUSINESS_TYPES = Object.keys(BUSINESS_TYPE_LABELS) as BusinessType[]

/** Types that are normally registered with RDB, so a registration number is expected. */
export const BUSINESS_TYPES_REQUIRING_REGISTRATION: BusinessType[] = [
  'registered_company',
  'cooperative',
  'non_profit',
]

export const MERCHANT_STATUS_LABELS: Record<MerchantStatus, string> = {
  draft: 'Draft',
  pending_verification: 'Pending verification',
  active: 'Active',
  suspended: 'Suspended',
  rejected: 'Rejected',
}

export const MERCHANT_STATUS_DESCRIPTIONS: Record<MerchantStatus, string> = {
  draft: 'Registration has not been submitted yet.',
  pending_verification:
    'Your details were received and are waiting for review. The business is not verified or bank-approved yet.',
  active: 'This business has been verified and approved.',
  suspended: 'This business is suspended. Profile changes are disabled until it is reinstated.',
  rejected: 'The registration was not approved. Review the details and contact support.',
}

export const ONBOARDING_STEP_TITLES = ['Business', 'Location', 'Contact', 'Review'] as const
