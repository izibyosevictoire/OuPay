import type { PublicCodeSale } from './codeCheckout'

/**
 * Payment-entry devices: a static QR code, an NFC tag or an NFC bracelet. A device is only a stable doorway (one permanent URL). It holds
 * no bank detail, no amount and no person, and it never says anything is paid: the bill it leads to is an ordinary code sale.
 */
export type EntryDeviceType = 'STATIC_QR' | 'NFC_TAG' | 'NFC_BRACELET'
export type EntryDeviceStatus = 'ACTIVE' | 'SUSPENDED' | 'REVOKED'

export const ENTRY_DEVICE_TYPES: readonly EntryDeviceType[] = [
  'STATIC_QR',
  'NFC_TAG',
  'NFC_BRACELET',
]

/** The prepared bill a device currently leads to. `saleStatus` is the bank-verified customer status, never one the screen sets. */
export interface EntryDeviceBinding {
  id: string
  saleId: string
  saleReference: string
  amountRwf: number
  description: string
  presentationMode: 'LIVE' | 'DEMONSTRATION'
  agentName: string
  boundAt: string
  saleExpiresAt: string
  saleStatus: string
  /** A customer holds the device right now (their short session has not run out). */
  customerSessionActive: boolean
  sessionExpiresAt: string | null
}

export interface EntryDevice {
  id: string
  deviceType: EntryDeviceType
  displayName: string
  /** The permanent path, `/e/{token}`. The browser prefixes the customer-facing domain. */
  entryPath: string
  branchId: string
  branchName: string
  assignedCashierUserId: string | null
  assignedCashierName: string | null
  status: EntryDeviceStatus
  statusReason: string | null
  createdAt: string
  updatedAt: string
  version: number
  binding: EntryDeviceBinding | null
}

export interface EntryDeviceBranchOption {
  id: string
  name: string
  code: string
}

export interface EntryDeviceCashierOption {
  userId: string
  fullName: string
  role: string
  branchIds: string[]
}

export interface EntryDeviceOptions {
  branches: EntryDeviceBranchOption[]
  cashiers: EntryDeviceCashierOption[]
}

export interface EntryDeviceAssignment {
  id: string
  branchId: string
  branchName: string
  assignedCashierUserId: string | null
  assignedCashierName: string | null
  validFrom: string
  validTo: string | null
  assignedBy: string
  reason: string | null
}

export interface EntryDeviceBindingHistory {
  id: string
  saleReference: string
  amountRwf: number
  agentName: string
  boundBy: string
  boundAt: string
  endedAt: string | null
  endReason: string | null
}

export interface EligibleEntrySale {
  saleId: string
  saleReference: string
  amountRwf: number
  description: string
  presentationMode: 'LIVE' | 'DEMONSTRATION'
  agentName: string
  expiresAt: string
  createdAt: string
  status: string
}

export interface RegisterEntryDeviceInput {
  /** A stable id for this attempt: a retry returns the same device. */
  clientRequestId: string
  deviceType: EntryDeviceType
  displayName: string
  branchId: string
  assignedCashierUserId: string | null
}

export interface AssignEntryDeviceInput {
  expectedVersion: number
  branchId: string
  assignedCashierUserId: string | null
  reason: string | null
  /** Closing a bill a customer is looking at right now needs this explicit confirmation. */
  confirmActiveSession: boolean
}

export interface EntryDeviceStatusInput {
  expectedVersion: number
  reason: string
}

export interface BindEntryDeviceInput {
  saleId: string
  expectedVersion: number
}

export interface UnbindEntryDeviceInput {
  reason: string
  confirmActiveSession: boolean
}

export interface EntryDeviceWriteResult {
  device: EntryDevice
  replayed: boolean
}

// ---- the customer's side -------------------------------------------------------------------------

/**
 * UNAVAILABLE is one answer for an unknown, suspended or revoked token. READY and BUSY carry no amount, reference or code: the bill is
 * shown only to the customer who took it.
 */
export type PublicEntryState =
  'UNAVAILABLE' | 'IDLE' | 'READY' | 'BUSY' | 'CLAIMED' | 'SESSION_ENDED'

export interface PublicEntryClaim {
  active: boolean
  expiresAt: string
  endReason: string | null
  /** Present only in the answer that creates the claim; the browser keeps it for this session only. */
  claimToken: string | null
}

export interface PublicEntry {
  state: PublicEntryState
  message: string
  merchantDisplayName: string | null
  sale: PublicCodeSale | null
  claim: PublicEntryClaim | null
}
