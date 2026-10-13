import type { AppNotification } from '@/types/notification'

/**
 * In-app notifications for the signed-in user in one business. Notifications are created by
 * the trusted event processor (never by the UI) and routed to the responsible cashier and
 * authorised managers. Each person only ever receives their own.
 */
export interface NotificationService {
  /** Newest first. Only the caller's own notifications for this merchant. */
  listNotifications(merchantId: string): Promise<AppNotification[]>
  markAsRead(merchantId: string, notificationId: string): Promise<AppNotification>
  markAllAsRead(merchantId: string): Promise<void>
}
