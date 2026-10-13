import { Bell } from 'lucide-react'
import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { SimulatedBadge } from '@/components/common/StatusBadge'
import { Button } from '@/components/ui/button'
import { NOTIFICATION_KIND_LABELS } from '@/constants/payment'
import {
  useMarkAllNotificationsRead,
  useMarkNotificationRead,
  useNotifications,
} from '@/features/payments/paymentQueries'
import { formatDateTime } from '@/lib/format'
import type { AppNotification } from '@/types/notification'

/** Where a notification leads: the transaction when there is one, otherwise the invoice. */
const targetOf = (notification: AppNotification) =>
  notification.relatedBankTransactionId
    ? `/transactions/${notification.relatedBankTransactionId}`
    : notification.relatedInvoiceId
      ? `/invoices/${notification.relatedInvoiceId}`
      : '/payments'

/**
 * The header bell: a disclosure panel (not an ARIA menu, because it holds readable content
 * and buttons rather than menu items). Escape and an outside click close it.
 */
export function NotificationButton() {
  const panelId = useId()
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const [isOpen, setIsOpen] = useState(false)
  const notificationsQuery = useNotifications()
  const markRead = useMarkNotificationRead()
  const markAllRead = useMarkAllNotificationsRead()
  const notifications = notificationsQuery.data ?? []
  const unreadCount = notifications.filter((n) => !n.readAt).length

  useEffect(() => {
    if (!isOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setIsOpen(false)
        triggerRef.current?.focus()
      }
    }
    const onPointerDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('mousedown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('mousedown', onPointerDown)
    }
  }, [isOpen])

  return (
    <div ref={containerRef} className="relative">
      <Button
        ref={triggerRef}
        variant="ghost"
        size="icon"
        aria-label={unreadCount > 0 ? `Notifications, ${unreadCount} unread` : 'Notifications'}
        aria-expanded={isOpen}
        aria-controls={isOpen ? panelId : undefined}
        className="relative"
        onClick={() => setIsOpen((open) => !open)}
      >
        <Bell className="size-5" aria-hidden="true" />
        {unreadCount > 0 && (
          <span
            data-testid="unread-count"
            aria-hidden="true"
            className="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-destructive px-1 text-[10px] font-semibold leading-4 text-destructive-foreground"
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </Button>
      {isOpen && (
        <section
          id={panelId}
          aria-label="Notifications"
          className="fixed inset-x-3 top-14 z-50 max-h-[70vh] overflow-y-auto rounded-lg border bg-popover text-popover-foreground shadow-popover sm:absolute sm:inset-x-auto sm:right-0 sm:top-full sm:mt-2 sm:w-80"
        >
          <div className="flex items-center justify-between gap-2 px-3 py-2">
            <h2 className="text-sm font-semibold">Notifications</h2>
            {unreadCount > 0 && (
              <Button
                variant="ghost"
                size="sm"
                disabled={markAllRead.isPending}
                onClick={() => markAllRead.mutate()}
              >
                Mark all as read
              </Button>
            )}
          </div>
          {notificationsQuery.isError ? (
            <p role="alert" className="px-3 pb-3 text-xs text-danger">
              Notifications could not be loaded.
            </p>
          ) : notifications.length === 0 ? (
            <p className="px-3 pb-3 text-xs text-muted-foreground">
              You are all caught up. Payment alerts will appear here.
            </p>
          ) : (
            <ul className="divide-y border-t">
              {notifications.map((notification) => (
                <li key={notification.id} className="px-3 py-2.5">
                  <p className="text-sm font-medium">
                    {!notification.readAt && (
                      <span
                        className="mr-1.5 inline-block size-2 rounded-full bg-primary align-middle"
                        aria-hidden="true"
                      />
                    )}
                    {notification.title}
                    {!notification.readAt && <span className="sr-only"> (unread)</span>}
                  </p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{notification.body}</p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                    <span className="text-muted-foreground">
                      {NOTIFICATION_KIND_LABELS[notification.kind]} ·{' '}
                      {formatDateTime(notification.createdAt)}
                    </span>
                    {notification.isSimulated && <SimulatedBadge />}
                  </div>
                  <div className="mt-1.5 flex gap-3 text-xs font-medium">
                    <Link
                      to={targetOf(notification)}
                      className="rounded-sm text-primary hover:underline"
                      onClick={() => {
                        if (!notification.readAt) markRead.mutate(notification.id)
                        setIsOpen(false)
                      }}
                    >
                      Open<span className="sr-only"> {notification.title}</span>
                    </Link>
                    {!notification.readAt && (
                      <button
                        type="button"
                        className="rounded-sm text-primary hover:underline"
                        onClick={() => markRead.mutate(notification.id)}
                      >
                        Mark as read<span className="sr-only"> {notification.title}</span>
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  )
}
