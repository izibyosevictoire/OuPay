import {
  BarChart3,
  Building2,
  CreditCard,
  FileText,
  Landmark,
  LayoutDashboard,
  QrCode,
  Receipt,
  Settings,
  Users,
  type LucideIcon,
} from 'lucide-react'
import type { Permission } from '@/features/auth/permissions/permissionDefinitions'

export interface NavigationItem {
  label: string
  /** Label for users whose permission scope is `limited` (assigned records only). */
  limitedLabel?: string
  path: string
  icon: LucideIcon
  description: string
  /** Capability needed to see this item and open its page. No permission = any member. */
  permission?: Permission
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
    label: 'Invoices',
    limitedLabel: 'Assigned invoices',
    path: '/invoices',
    icon: FileText,
    description: 'Create and track invoices',
    permission: 'invoices:view',
  },
  {
    label: 'Transactions',
    limitedLabel: 'My transactions',
    path: '/transactions',
    icon: Receipt,
    description: 'Review transactions',
    permission: 'transactions:view',
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
    label: 'Reports',
    path: '/reports',
    icon: BarChart3,
    description: 'Business reports',
    permission: 'reports:view',
  },
  // Account settings are personal, so every member gets them.
  { label: 'Settings', path: '/settings', icon: Settings, description: 'Account settings' },
]
