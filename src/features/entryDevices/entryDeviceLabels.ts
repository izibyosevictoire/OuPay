import type { EntryDeviceStatus, EntryDeviceType } from '@/types/entryDevices'

export const DEVICE_TYPE_LABELS: Record<EntryDeviceType, string> = {
  STATIC_QR: 'Static QR code',
  NFC_TAG: 'NFC tag or card',
  NFC_BRACELET: 'NFC bracelet',
}

export const DEVICE_TYPE_HELP: Record<EntryDeviceType, string> = {
  STATIC_QR: 'A printed code at the counter. It never changes between customers.',
  NFC_TAG: 'A sticker, card or tag. Tapping it opens the same permanent link.',
  NFC_BRACELET: 'Worn by one cashier, so it always belongs to a person.',
}

export const DEVICE_STATUS_LABELS: Record<EntryDeviceStatus, string> = {
  ACTIVE: 'Active',
  SUSPENDED: 'Suspended',
  REVOKED: 'Revoked',
}

export const DEVICE_STATUS_STYLES: Record<EntryDeviceStatus, string> = {
  ACTIVE: 'bg-success-soft text-success',
  SUSPENDED: 'bg-warning-soft text-warning',
  REVOKED: 'bg-muted text-muted-foreground',
}

/** Why a bill stopped leading from a device, in words the counter understands. */
export const BINDING_END_LABELS: Record<string, string> = {
  UNBOUND: 'Closed by staff',
  SALE_PAID: 'Bill was paid',
  SALE_EXPIRED: 'Bill expired',
  SALE_CANCELLED: 'Bill was cancelled',
  DEVICE_REVOKED: 'Device revoked',
  DEVICE_REASSIGNED: 'Device reassigned',
}

export const SALE_STATUS_LABELS: Record<string, string> = {
  AWAITING_PAYMENT: 'Awaiting payment',
  PARTIALLY_PAID: 'Partly paid',
  PAID: 'Paid (bank-confirmed)',
  EXPIRED: 'Expired',
  CANCELLED: 'Cancelled',
  REQUIRES_RECONCILIATION: 'Needs reconciliation',
  UNKNOWN: 'Unknown',
}

export const MAX_DEVICE_NAME = 60
export const MAX_REASON = 200
