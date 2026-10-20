import type {
  CreateMerchantInput,
  Merchant,
  MerchantSettings,
  UpdateMerchantInput,
  UpdateMerchantSettingsInput,
} from '@/types/merchant'

export type MerchantServiceErrorCode =
  | 'not_found'
  | 'duplicate_tin'
  | 'duplicate_registration_number'
  | 'profile_locked'
  | 'version_conflict'
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
  /** Any member may read the settings of their business. */
  getMerchantSettings(merchantId: string): Promise<MerchantSettings>
  /**
   * Owners only. Rejects with `version_conflict` when the settings changed since they were read.
   * Never deletes or alters historical records.
   */
  updateMerchantSettings(
    merchantId: string,
    changes: UpdateMerchantSettingsInput,
  ): Promise<MerchantSettings>
}
