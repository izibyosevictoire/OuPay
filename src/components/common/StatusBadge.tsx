import {
  AlertTriangle,
  CheckCircle2,
  Clock,
  HelpCircle,
  RotateCcw,
  Ban,
  MailOpen,
  PauseCircle,
  ShieldAlert,
  ShieldCheck,
  XCircle,
  FilePen,
  FileCheck2,
  CircleDollarSign,
  type LucideIcon,
} from 'lucide-react'
import { BRANCH_STATUS_LABELS } from '@/constants/branch'
import { CODE_PAYMENT_STAGE_LABELS } from '@/constants/codePayment'
import { BUSINESS_ROLE_LABELS, MEMBERSHIP_STATUS_LABELS } from '@/constants/auth'
import { MERCHANT_STATUS_LABELS } from '@/constants/merchant'
import { INVOICE_PAYMENT_STATUS_LABELS, INVOICE_STATUS_LABELS } from '@/constants/invoice'
import {
  BANK_CONNECTION_STATUS_LABELS,
  BANK_TRANSACTION_STATUS_LABELS,
  CUSTOMER_STAGE_LABELS,
  PAYMENT_PROFILE_STATUS_LABELS,
  RECONCILIATION_STATUS_LABELS,
} from '@/constants/payment'
import { cn } from '@/lib/utils'
import type { BankConnectionStatus } from '@/types/banking'
import type { CodePaymentStage } from '@/types/bankAttribution'
import type { BankTransactionStatus, ReconciliationStatus } from '@/types/payment'
import type { CustomerPaymentStage, PaymentProfileStatus } from '@/types/paymentProfile'
import type { InvoicePaymentStatus, InvoiceStatus } from '@/types/invoice'
import type { BusinessRole, MembershipStatus } from '@/types/auth'
import type { BranchStatus } from '@/types/branch'
import type { MerchantStatus } from '@/types/merchant'

type Tone = 'success' | 'warning' | 'danger' | 'info' | 'neutral'

const toneClassNames: Record<Tone, string> = {
  success: 'bg-success-soft text-success',
  warning: 'bg-warning-soft text-warning',
  danger: 'bg-danger-soft text-danger',
  info: 'bg-info-soft text-info',
  neutral: 'bg-neutral-soft text-neutral',
}

interface StatusAppearance {
  tone: Tone
  icon: LucideIcon
}

const BANK_STATUS_APPEARANCE: Record<BankTransactionStatus, StatusAppearance> = {
  CONFIRMED: { tone: 'success', icon: CheckCircle2 },
  PENDING: { tone: 'warning', icon: Clock },
  FAILED: { tone: 'danger', icon: XCircle },
  REVERSED: { tone: 'neutral', icon: RotateCcw },
}

const RECONCILIATION_APPEARANCE: Record<ReconciliationStatus, StatusAppearance> = {
  NOT_APPLICABLE: { tone: 'neutral', icon: Clock },
  UNMATCHED: { tone: 'info', icon: HelpCircle },
  COLLECTED: { tone: 'info', icon: CircleDollarSign },
  PARTIALLY_ALLOCATED: { tone: 'warning', icon: CircleDollarSign },
  FULLY_ALLOCATED: { tone: 'success', icon: CheckCircle2 },
  REVERSED: { tone: 'neutral', icon: RotateCcw },
}

const CODE_PAYMENT_STAGE_APPEARANCE: Record<CodePaymentStage, StatusAppearance> = {
  NOT_CONFIRMED: { tone: 'neutral', icon: Clock },
  AWAITING_MATCHING: { tone: 'info', icon: HelpCircle },
  CODE_RESOLVED: { tone: 'info', icon: ShieldCheck },
  SALE_MATCHED: { tone: 'info', icon: CheckCircle2 },
  ALLOCATED: { tone: 'warning', icon: CircleDollarSign },
  FULLY_PAID: { tone: 'success', icon: CheckCircle2 },
  CONFLICT: { tone: 'danger', icon: AlertTriangle },
}

const CONNECTION_APPEARANCE: Record<BankConnectionStatus, StatusAppearance> = {
  NOT_CONFIGURED: { tone: 'neutral', icon: PauseCircle },
  PENDING: { tone: 'warning', icon: Clock },
  CONNECTED: { tone: 'success', icon: CheckCircle2 },
  ERROR: { tone: 'danger', icon: AlertTriangle },
  DISABLED: { tone: 'neutral', icon: Ban },
}

const PROFILE_APPEARANCE: Record<PaymentProfileStatus, StatusAppearance> = {
  ACTIVE: { tone: 'success', icon: CheckCircle2 },
  INACTIVE: { tone: 'neutral', icon: PauseCircle },
  REVOKED: { tone: 'danger', icon: Ban },
}

const CUSTOMER_STAGE_APPEARANCE: Record<CustomerPaymentStage, StatusAppearance> = {
  AWAITING_PAYMENT: { tone: 'info', icon: Clock },
  BANK_CONFIRMATION_PENDING: { tone: 'warning', icon: Clock },
  CONFIRMED_AND_RECONCILED: { tone: 'success', icon: CheckCircle2 },
  CONFIRMED_UNMATCHED: { tone: 'success', icon: CheckCircle2 },
  PARTIALLY_SETTLED: { tone: 'warning', icon: CircleDollarSign },
  FAILED: { tone: 'danger', icon: XCircle },
  EXPIRED: { tone: 'neutral', icon: Clock },
  REVERSED: { tone: 'danger', icon: RotateCcw },
  CANCELLED: { tone: 'neutral', icon: Ban },
}

const INVOICE_STATUS_APPEARANCE: Record<InvoiceStatus, StatusAppearance> = {
  DRAFT: { tone: 'neutral', icon: FilePen },
  ISSUED: { tone: 'info', icon: FileCheck2 },
  CANCELLED: { tone: 'neutral', icon: XCircle },
  VOIDED: { tone: 'danger', icon: Ban },
}

const INVOICE_PAYMENT_APPEARANCE: Record<InvoicePaymentStatus, StatusAppearance> = {
  UNPAID: { tone: 'warning', icon: Clock },
  PARTIALLY_PAID: { tone: 'warning', icon: CircleDollarSign },
  PAID: { tone: 'success', icon: CheckCircle2 },
  OVERPAID: { tone: 'info', icon: CircleDollarSign },
  REFUNDED: { tone: 'neutral', icon: RotateCcw },
}

function Badge({ label, appearance }: { label: string; appearance: StatusAppearance }) {
  const Icon = appearance.icon
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        toneClassNames[appearance.tone],
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {label}
    </span>
  )
}

/** Where a code payment stands: its own wording, so it is never mistaken for the bank status or the reconciliation status. */
export function CodePaymentStageBadge({ stage }: { stage: CodePaymentStage }) {
  return (
    <Badge
      label={CODE_PAYMENT_STAGE_LABELS[stage]}
      appearance={CODE_PAYMENT_STAGE_APPEARANCE[stage]}
    />
  )
}

/** What the bank says about the money. */
export function BankTransactionStatusBadge({ status }: { status: BankTransactionStatus }) {
  return (
    <Badge
      label={BANK_TRANSACTION_STATUS_LABELS[status]}
      appearance={BANK_STATUS_APPEARANCE[status]}
    />
  )
}

/** What OuPay has done with confirmed money. */
export function ReconciliationStatusBadge({ status }: { status: ReconciliationStatus }) {
  return (
    <Badge
      label={RECONCILIATION_STATUS_LABELS[status]}
      appearance={RECONCILIATION_APPEARANCE[status]}
    />
  )
}

export function BankConnectionStatusBadge({ status }: { status: BankConnectionStatus }) {
  return (
    <Badge
      label={BANK_CONNECTION_STATUS_LABELS[status]}
      appearance={CONNECTION_APPEARANCE[status]}
    />
  )
}

export function PaymentProfileStatusBadge({ status }: { status: PaymentProfileStatus }) {
  return (
    <Badge label={PAYMENT_PROFILE_STATUS_LABELS[status]} appearance={PROFILE_APPEARANCE[status]} />
  )
}

export function CustomerStageBadge({ stage }: { stage: CustomerPaymentStage }) {
  return (
    <Badge label={CUSTOMER_STAGE_LABELS[stage]} appearance={CUSTOMER_STAGE_APPEARANCE[stage]} />
  )
}

/** Marks demo data so simulated money is never mistaken for a real bank payment. */
export function SimulatedBadge() {
  return <Badge label="Simulated" appearance={{ tone: 'info', icon: HelpCircle }} />
}

/** Lifecycle of the invoice document (not payment). */
export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  return (
    <Badge label={INVOICE_STATUS_LABELS[status]} appearance={INVOICE_STATUS_APPEARANCE[status]} />
  )
}

/** Bank-confirmed settlement state; read-only everywhere. */
export function InvoicePaymentStatusBadge({ status }: { status: InvoicePaymentStatus }) {
  return (
    <Badge
      label={INVOICE_PAYMENT_STATUS_LABELS[status]}
      appearance={INVOICE_PAYMENT_APPEARANCE[status]}
    />
  )
}

export function OverdueBadge() {
  return <Badge label="Overdue" appearance={{ tone: 'danger', icon: AlertTriangle }} />
}

const MERCHANT_STATUS_APPEARANCE: Record<MerchantStatus, StatusAppearance> = {
  draft: { tone: 'neutral', icon: FilePen },
  pending_verification: { tone: 'warning', icon: Clock },
  active: { tone: 'success', icon: ShieldCheck },
  suspended: { tone: 'danger', icon: ShieldAlert },
  rejected: { tone: 'danger', icon: XCircle },
}

export function MerchantStatusBadge({ status }: { status: MerchantStatus }) {
  return (
    <Badge label={MERCHANT_STATUS_LABELS[status]} appearance={MERCHANT_STATUS_APPEARANCE[status]} />
  )
}

const MEMBERSHIP_STATUS_APPEARANCE: Record<MembershipStatus, StatusAppearance> = {
  INVITED: { tone: 'info', icon: MailOpen },
  ACTIVE: { tone: 'success', icon: CheckCircle2 },
  SUSPENDED: { tone: 'warning', icon: PauseCircle },
  REVOKED: { tone: 'danger', icon: Ban },
}

export function MembershipStatusBadge({ status }: { status: MembershipStatus }) {
  return (
    <Badge
      label={MEMBERSHIP_STATUS_LABELS[status]}
      appearance={MEMBERSHIP_STATUS_APPEARANCE[status]}
    />
  )
}

const BRANCH_STATUS_APPEARANCE: Record<BranchStatus, StatusAppearance> = {
  ACTIVE: { tone: 'success', icon: CheckCircle2 },
  INACTIVE: { tone: 'neutral', icon: PauseCircle },
}

export function BranchStatusBadge({ status }: { status: BranchStatus }) {
  return (
    <Badge label={BRANCH_STATUS_LABELS[status]} appearance={BRANCH_STATUS_APPEARANCE[status]} />
  )
}

/** Plain text pill: role is conveyed by its label, not by colour. */
export function RoleBadge({ role }: { role: BusinessRole }) {
  return (
    <span className="inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium">
      {BUSINESS_ROLE_LABELS[role]}
    </span>
  )
}
