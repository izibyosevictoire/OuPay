import {
  BarChart3,
  Boxes,
  Building2,
  CreditCard,
  Package,
  FileText,
  HandCoins,
  Hash,
  ShieldCheck,
  KeyRound,
  Landmark,
  LayoutDashboard,
  QrCode,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react'
import type { Permission } from '@/features/auth/permissions/permissionDefinitions'
import type { OperatingMode } from '@/types/merchant'

export interface NavigationItem {
  label: string
  /** Label for users whose permission scope is `limited` (assigned records only). */
  limitedLabel?: string
  path: string
  icon: LucideIcon
  description: string
  /** Capability needed to see this item and open its page. No permission = any member. */
  permission?: Permission
  /** Only shown when the current business works in this operating mode. No mode = every business. */
  requiresMode?: OperatingMode
}

export const PRIMARY_NAVIGATION: NavigationItem[] = [
  {
    label: 'Dashboard',
    path: '/',
    icon: LayoutDashboard,
    description: 'Business overview',
    permission: 'dashboard:view',
  },
  {
    label: 'Collect Payment',
    path: '/collect',
    icon: HandCoins,
    description: 'Bill an amount and show a QR code',
    permission: 'invoices:create',
    requiresMode: 'SIMPLIFIED',
  },
  {
    // For people who hold a collection code (the page explains when you hold none). Both operating modes.
    label: 'Code checkout',
    path: '/code-checkout',
    icon: Hash,
    description: 'Bill an amount through your collection code',
    permission: 'invoices:create',
  },
  {
    label: 'Invoices',
    limitedLabel: 'Assigned invoices',
    path: '/invoices',
    icon: FileText,
    description: 'Create and track invoices',
    permission: 'invoices:view',
  },
  {
    label: 'Catalog',
    path: '/catalog',
    icon: Package,
    description: 'Goods and services you sell',
    permission: 'catalog:view',
    requiresMode: 'BUSINESS',
  },
  {
    label: 'Inventory',
    path: '/inventory',
    icon: Boxes,
    description: 'Stock of goods by branch',
    permission: 'inventory:view',
    requiresMode: 'BUSINESS',
  },
  {
    label: 'Payments',
    limitedLabel: 'Payment confirmations',
    path: '/payments',
    icon: CreditCard,
    description: 'Payment verification',
    permission: 'payments:view_confirmations',
  },
  {
    label: 'Payment links',
    limitedLabel: 'My payment links',
    path: '/payment-links',
    icon: QrCode,
    description: 'QR codes and NFC payment links',
    permission: 'payment_profiles:view',
  },
  {
    // Every member gets this entry: owners and managers manage the registry, everyone else sees their own code. Both operating modes.
    label: 'Collection codes',
    path: '/collection-codes',
    icon: KeyRound,
    description: 'Payment collection codes and who holds them',
  },
  {
    label: 'Banking',
    path: '/banking',
    icon: Landmark,
    description: 'Bank connections and providers',
    permission: 'banking:manage',
  },
  {
    label: 'Cashiers',
    path: '/cashiers',
    icon: Users,
    description: 'Manage staff and branch assignments',
    permission: 'cashiers:manage',
  },
  {
    label: 'Branches',
    path: '/branches',
    icon: Building2,
    description: 'Manage branches',
    permission: 'branches:manage',
  },
  {
    label: 'Equity activation',
    path: '/equity-activation',
    icon: ShieldCheck,
    description: 'Prepare your Equity business application',
    permission: 'kyc:manage',
  },
  {
    label: 'Reports',
    path: '/reports',
    icon: BarChart3,
    description: 'Business reports',
    permission: 'reports:view',
  },
  // Account settings are personal, so every member gets them.
  { label: 'Settings', path: '/settings', icon: Settings, description: 'Account settings' },
]
