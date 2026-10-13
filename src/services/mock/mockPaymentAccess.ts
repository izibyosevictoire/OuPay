import type { Permission } from '@/features/auth/permissions/permissionDefinitions'
import { OrganizationServiceError } from '@/services/organizationService'
import { PaymentServiceError } from '@/services/paymentServiceError'
import type { MockAuthStore } from './mockAuthStore'
import { requireActor, type Actor } from './mockOrganizationAccess'

/**
 * Resolves the signed-in ACTIVE member of a merchant (checking an optional permission) and
 * re-throws access failures as PaymentServiceError. Non-members get "not found", so another
 * business's data is indistinguishable from data that does not exist.
 */
export function requirePaymentActor(
  store: MockAuthStore,
  merchantId: string,
  permission?: Permission,
): Actor {
  try {
    return requireActor(store, merchantId, permission)
  } catch (error) {
    if (error instanceof OrganizationServiceError) {
      const code =
        error.code === 'unauthenticated'
          ? 'unauthenticated'
          : error.code === 'forbidden'
            ? 'forbidden'
            : 'not_found'
      throw new PaymentServiceError(code, error.message)
    }
    throw error
  }
}

/** The user ID a cashier's reads must be restricted to, or undefined for full-scope roles. */
export function scopeUserId(actor: Actor, fullScope: boolean): string | undefined {
  return fullScope ? undefined : actor.user.id
}
