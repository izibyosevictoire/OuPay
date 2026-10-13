import { PaymentServiceError } from '@/services/paymentServiceError'
import type { NotificationService } from '@/services/notificationService'
import { createMockAuthStore, type MockAuthStore } from './mockAuthStore'
import { createLedgerStore, type LedgerStore } from './ledger/mockLedgerStore'
import { createOperationRunner } from './mockOrganizationAccess'
import { requirePaymentActor } from './mockPaymentAccess'

interface MockNotificationServiceOptions {
  authStore?: MockAuthStore
  ledger?: LedgerStore
  delayInMilliseconds?: number
}

export function createMockNotificationService(
  options: MockNotificationServiceOptions = {},
): NotificationService {
  const store = options.authStore ?? createMockAuthStore()
  const ledger = options.ledger ?? createLedgerStore(store)
  const run = createOperationRunner(options.delayInMilliseconds ?? 250)

  return {
    listNotifications: (merchantId) =>
      run(() => {
        const { user } = requirePaymentActor(store, merchantId)
        return ledger.notifications
          .load()
          .filter((n) => n.merchantId === merchantId && n.recipientUserId === user.id)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      }),

    markAsRead: (merchantId, notificationId) =>
      run(() => {
        const { user } = requirePaymentActor(store, merchantId)
        const all = ledger.notifications.load()
        // Only your own: someone else's notification looks like it does not exist.
        const target = all.find(
          (n) =>
            n.id === notificationId && n.merchantId === merchantId && n.recipientUserId === user.id,
        )
        if (!target)
          throw new PaymentServiceError('not_found', 'This notification could not be found.')
        const read = target.readAt ? target : { ...target, readAt: new Date().toISOString() }
        ledger.notifications.save(all.map((n) => (n.id === read.id ? read : n)))
        return read
      }),

    markAllAsRead: (merchantId) =>
      run(() => {
        const { user } = requirePaymentActor(store, merchantId)
        const readAt = new Date().toISOString()
        ledger.notifications.save(
          ledger.notifications
            .load()
            .map((n) =>
              n.merchantId === merchantId && n.recipientUserId === user.id && !n.readAt
                ? { ...n, readAt }
                : n,
            ),
        )
      }),
  }
}
