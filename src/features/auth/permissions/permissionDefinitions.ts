import type { BusinessRole } from '@/types/auth'

/**
 * How much of a capability a role gets.
 * - `all`: every record in the business.
 * - `limited`: a reduced view. For invoices, transactions and payment confirmations this
 *   means only records assigned to the user; for the dashboard and profile it means a
 *   summary without business-wide figures or sensitive registration data.
 */
export type PermissionScope = 'all' | 'limited'

type RoleGrants = Record<BusinessRole, PermissionScope | null>

const ALL = 'all'
const LIMITED = 'limited'
const NONE = null

/**
 * The single source of truth for who may do what. Components must ask about a
 * permission, never compare roles directly. This is UX only: the backend must
 * enforce the same rules, because anything in the browser can be bypassed.
 */
export const PERMISSION_DEFINITIONS = {
  'dashboard:view': { OWNER: ALL, MANAGER: ALL, CASHIER: LIMITED },
  'profile:view': { OWNER: ALL, MANAGER: ALL, CASHIER: LIMITED },
  'profile:edit': { OWNER: ALL, MANAGER: NONE, CASHIER: NONE },
  'invoices:view': { OWNER: ALL, MANAGER: ALL, CASHIER: LIMITED },
  'invoices:create': { OWNER: ALL, MANAGER: ALL, CASHIER: ALL },
  // Voiding an issued invoice is a correction, so only owners may do it (see lib/invoiceLifecycle).
  'invoices:void': { OWNER: ALL, MANAGER: NONE, CASHIER: NONE },
  'transactions:view': { OWNER: ALL, MANAGER: ALL, CASHIER: LIMITED },
  'payments:view_confirmations': { OWNER: ALL, MANAGER: ALL, CASHIER: LIMITED },
  // Applying confirmed money to invoices and correcting allocations. Never confirms payments.
  'payments:reconcile': { OWNER: ALL, MANAGER: ALL, CASHIER: NONE },
  // Public payment links (QR/NFC). Cashiers see only links assigned to them.
  'payment_profiles:view': { OWNER: ALL, MANAGER: ALL, CASHIER: LIMITED },
  'payment_profiles:manage': { OWNER: ALL, MANAGER: ALL, CASHIER: NONE },
  'branches:manage': { OWNER: ALL, MANAGER: ALL, CASHIER: NONE },
  'cashiers:manage': { OWNER: ALL, MANAGER: ALL, CASHIER: NONE },
  'membership:manage': { OWNER: ALL, MANAGER: NONE, CASHIER: NONE },
  // The goods-and-services catalog (BUSINESS mode). Cashiers may read it (they will sell from it) but never change it.
  'catalog:view': { OWNER: ALL, MANAGER: ALL, CASHIER: ALL },
  'catalog:manage': { OWNER: ALL, MANAGER: ALL, CASHIER: NONE },
  // Branch-level stock of goods (BUSINESS mode). Viewing: owners and managers see every branch, a cashier only the branches
  // they are assigned to. Recording stock (`receive`, and `adjust` which also covers opening stock) is limited for a manager
  // to the branches they are assigned to, and never granted to cashiers.
  'inventory:view': { OWNER: ALL, MANAGER: ALL, CASHIER: LIMITED },
  'inventory:receive': { OWNER: ALL, MANAGER: LIMITED, CASHIER: NONE },
  'inventory:adjust': { OWNER: ALL, MANAGER: LIMITED, CASHIER: NONE },
  // The registry of merchant collection codes and who holds them (internal bookkeeping; it never approves a code). Viewing is
  // for owners and managers. Assigning agents is limited for a manager to codes of branches they work at. Requesting codes,
  // recording a bank request, suspending and deactivating are the owner's, like bank linkage. Anyone with an active membership
  // may see THEIR OWN code (no permission needed).
  'collection_codes:view': { OWNER: ALL, MANAGER: ALL, CASHIER: NONE },
  'collection_codes:assign': { OWNER: ALL, MANAGER: LIMITED, CASHIER: NONE },
  'collection_codes:manage': { OWNER: ALL, MANAGER: NONE, CASHIER: NONE },
  // Equity activation (KYC): the owner's alone. It holds a representative's identity details and the consent that covers them, so
  // neither managers nor cashiers may read or change any of it.
  'kyc:manage': { OWNER: ALL, MANAGER: NONE, CASHIER: NONE },
  'reports:view': { OWNER: ALL, MANAGER: ALL, CASHIER: NONE },
  'banking:manage': { OWNER: ALL, MANAGER: NONE, CASHIER: NONE },
} as const satisfies Record<string, RoleGrants>

export type Permission = keyof typeof PERMISSION_DEFINITIONS
