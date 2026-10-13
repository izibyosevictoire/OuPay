import type { CreateMerchantInput, Merchant, UpdateMerchantInput } from '@/types/merchant'

export type MerchantServiceErrorCode =
  | 'not_found'
  | 'duplicate_tin'
  | 'duplicate_registration_number'
  | 'profile_locked'
  | 'unauthenticated'
  | 'forbidden'
  | 'service_unavailable'

export class MerchantServiceError extends Error {
  readonly code: MerchantServiceErrorCode

  constructor(code: MerchantServiceErrorCode, message: string) {
    super(message)
    this.name = 'MerchantServiceError'
    this.code = code
  }
}

/**
 * Contract for merchant data. The mock implements it today; a real API client
 * can replace it without touching the UI. Access control belongs to that backend.
 */
export interface MerchantService {
  /** Registers a business. The result is always pending verification, never approved. */
  createMerchant(input: CreateMerchantInput): Promise<Merchant>
  getMerchantById(merchantId: string): Promise<Merchant>
  updateMerchant(merchantId: string, changes: UpdateMerchantInput): Promise<Merchant>
  listMerchantsForCurrentUser(): Promise<Merchant[]>
}
