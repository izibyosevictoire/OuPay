/**
 * Lifecycle of a business registration.
 * A newly created merchant is only ever `pending_verification`; `active` must be
 * granted by a future back-office review, never by the frontend or the mock service.
 */
export type MerchantStatus = 'draft' | 'pending_verification' | 'active' | 'suspended' | 'rejected'

/** Informal and individual traders are first-class: they need no company registration. */
export type BusinessType =
  'registered_company' | 'cooperative' | 'non_profit' | 'sole_proprietor' | 'informal_vendor'

/**
 * How a business works in OuPay. Unrelated to `BusinessType`, which is the legal form.
 * - `BUSINESS`: full business capabilities.
 * - `SIMPLIFIED`: streamlined, amount-only payment collection.
 * Businesses that existed before modes were introduced are `BUSINESS`.
 */
export type OperatingMode = 'BUSINESS' | 'SIMPLIFIED'

export type CountryCode = 'RW'

/** Official registration details. Kept apart from banking/payment configuration. */
export interface BusinessRegistration {
  /** Company/cooperative registration number. Absent for informal traders. */
  registrationNumber?: string
  /** Rwanda Revenue Authority Taxpayer Identification Number (9 digits). */
  tin?: string
}

export interface BusinessLocation {
  country: CountryCode
  province: string
  district: string
  sector: string
  physicalAddress: string
}

export interface PrimaryContact {
  fullName: string
  email: string
  /** Normalised international format, e.g. +250788123456. */
  phoneNumber: string
}

/**
 * Placeholder for future bank/payment setup. It deliberately holds no account
 * numbers, PINs, passwords or credentials; those never belong in the frontend model.
 */
export interface BankingConfiguration {
  status: 'not_configured'
}

export interface Merchant {
  id: string
  /** Simulated owner until real authentication exists. */
  ownerUserId: string
  legalName: string
  tradingName?: string
  businessType: BusinessType
  status: MerchantStatus
  operatingMode: OperatingMode
  registration: BusinessRegistration
  location: BusinessLocation
  contact: PrimaryContact
  bankingConfiguration: BankingConfiguration
  createdAt: string
  updatedAt: string
}

/** Everything the registration flow collects, before the service assigns ID, owner and status. */
export type CreateMerchantInput = Pick<
  Merchant,
  'legalName' | 'tradingName' | 'businessType' | 'registration' | 'location' | 'contact'
> & {
  /** Optional for compatibility: absent means BUSINESS. */
  operatingMode?: OperatingMode
}

/** A business's settings. Reading follows profile visibility; changing is for owners. */
export interface MerchantSettings {
  merchantId: string
  operatingMode: OperatingMode
  /** Absent until the settings are first changed. */
  updatedAt?: string
  /** Send back as `expectedVersion` so a change made elsewhere is never silently overwritten. */
  version: number
}

export interface UpdateMerchantSettingsInput {
  operatingMode: OperatingMode
  expectedVersion: number
}

/** Fields a merchant may change after registering; identity and registration data are locked. */
export interface UpdateMerchantInput {
  tradingName?: string
  physicalAddress: string
  contact: PrimaryContact
}

/** Domain records that belong to exactly one merchant (invoices, transactions, branches, cashiers). */
export interface MerchantOwned {
  merchantId: string
}
