/**
 * The three public accounts of the demo experience (R9c). Fictional, with a public fake password that protects nothing. Kept in this small
 * file (no fixtures) so the sign-in screen can list them without pulling the demo data into any other build; the fixtures build their users
 * from it, so the two can never disagree.
 */
export const KIGALI_DEMO_PASSWORD = 'DemoPass123!'

export type DemoRoleKey = 'owner' | 'manager' | 'cashier'

export interface DemoAccount {
  key: DemoRoleKey
  name: string
  email: string
  phone: string
  role: 'Owner' | 'Manager' | 'Cashier'
  description: string
}

export const KIGALI_DEMO_ACCOUNTS: readonly DemoAccount[] = [
  { key: 'owner', name: 'Eric Habimana', email: 'demo.owner@oupay.demo', phone: '+250788100001', role: 'Owner', description: 'Sees all three branches and manages staff, catalog, stock and payment points.' },
  { key: 'manager', name: 'Diane Uwimana', email: 'demo.manager@oupay.demo', phone: '+250788100002', role: 'Manager', description: 'Works at Kigali Main and Remera; manages cashiers, stock and carts.' },
  { key: 'cashier', name: 'Patrick Nsengimana', email: 'demo.cashier@oupay.demo', phone: '+250788100003', role: 'Cashier', description: 'Works at Kigali Main; prepares carts and takes payments there.' },
]
