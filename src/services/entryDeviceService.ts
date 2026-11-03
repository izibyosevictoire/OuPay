import type {
  AssignEntryDeviceInput,
  BindEntryDeviceInput,
  EligibleEntrySale,
  EntryDevice,
  EntryDeviceAssignment,
  EntryDeviceBindingHistory,
  EntryDeviceOptions,
  EntryDeviceStatus,
  EntryDeviceStatusInput,
  EntryDeviceWriteResult,
  PublicEntry,
  RegisterEntryDeviceInput,
  UnbindEntryDeviceInput,
} from '@/types/entryDevices'

export type EntryDeviceServiceErrorCode =
  | 'unauthenticated'
  /** Also used for businesses and devices the caller may not see. */
  | 'not_found'
  | 'forbidden'
  | 'validation'
  | 'client_request_id_reuse'
  | 'device_name_taken'
  | 'branch_not_eligible'
  | 'cashier_not_eligible'
  | 'device_not_active'
  | 'device_revoked'
  | 'device_status_invalid'
  | 'no_change'
  | 'version_conflict'
  /** The sale belongs to another branch, or to another cashier than the device's. */
  | 'sale_branch_mismatch'
  | 'sale_agent_mismatch'
  | 'sale_not_bindable'
  | 'sale_already_bound'
  | 'device_has_open_bill'
  | 'no_open_bill'
  /** A customer is looking at the bill right now: closing it needs an explicit confirmation. */
  | 'customer_session_active'
  | 'service_unavailable'

export class EntryDeviceServiceError extends Error {
  readonly code: EntryDeviceServiceErrorCode

  constructor(code: EntryDeviceServiceErrorCode, message: string) {
    super(message)
    this.name = 'EntryDeviceServiceError'
    this.code = code
  }
}

/**
 * Persistent payment-entry devices. A device is a stable doorway to ONE prepared bill at a time. Nothing here creates a bill, records a
 * payment or marks anything paid: binding leads a device to a sale that already exists, and reconciliation stays the only authority on
 * money. The server (or the mock) is authoritative for every rule; the browser validates for convenience only.
 */
export interface EntryDeviceService {
  getOptions(merchantId: string): Promise<EntryDeviceOptions>
  listDevices(
    merchantId: string,
    filter?: { status?: EntryDeviceStatus; branchId?: string },
  ): Promise<EntryDevice[]>
  getDevice(merchantId: string, deviceId: string): Promise<EntryDevice>
  /** Idempotent by `clientRequestId`. */
  registerDevice(
    merchantId: string,
    input: RegisterEntryDeviceInput,
  ): Promise<EntryDeviceWriteResult>
  assignDevice(
    merchantId: string,
    deviceId: string,
    input: AssignEntryDeviceInput,
  ): Promise<EntryDevice>
  suspendDevice(
    merchantId: string,
    deviceId: string,
    input: EntryDeviceStatusInput,
  ): Promise<EntryDevice>
  reactivateDevice(
    merchantId: string,
    deviceId: string,
    input: EntryDeviceStatusInput,
  ): Promise<EntryDevice>
  /** Final: the URL stops working at once; sales and history stay as they were. */
  revokeDevice(
    merchantId: string,
    deviceId: string,
    input: EntryDeviceStatusInput,
  ): Promise<EntryDevice>
  listAssignments(merchantId: string, deviceId: string): Promise<EntryDeviceAssignment[]>
  listBindings(merchantId: string, deviceId: string): Promise<EntryDeviceBindingHistory[]>
  /** Prepared bills this device could lead to right now. */
  listEligibleSales(merchantId: string, deviceId: string): Promise<EligibleEntrySale[]>
  bindSale(merchantId: string, deviceId: string, input: BindEntryDeviceInput): Promise<EntryDevice>
  unbindSale(
    merchantId: string,
    deviceId: string,
    input: UnbindEntryDeviceInput,
  ): Promise<EntryDevice>
}

/**
 * The customer's side: anonymous. `resolve` only READS (a QR or NFC URL can be pre-fetched, so opening it never takes the device); taking
 * it is an explicit `claim`. The claim token is the customer's own session secret and is passed in a header, never in the URL.
 */
export interface PublicEntryService {
  resolve(token: string, claimToken?: string | null): Promise<PublicEntry>
  claim(token: string, claimToken?: string | null): Promise<PublicEntry>
  release(token: string, claimToken?: string | null): Promise<PublicEntry>
}
