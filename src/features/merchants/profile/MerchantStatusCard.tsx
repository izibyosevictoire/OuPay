import { MerchantStatusBadge } from '@/components/common/StatusBadge'
import { Card } from '@/components/ui/card'
import { MERCHANT_STATUS_DESCRIPTIONS } from '@/constants/merchant'
import { formatDate } from '@/lib/format'
import type { Merchant } from '@/types/merchant'

export function MerchantStatusCard({ merchant }: { merchant: Merchant }) {
  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="truncate text-section-title">
            {merchant.tradingName ?? merchant.legalName}
          </h2>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Merchant ID: <span className="font-mono text-foreground">{merchant.id}</span>
          </p>
          <p className="text-xs text-muted-foreground">
            Registered {formatDate(merchant.createdAt)} · Updated {formatDate(merchant.updatedAt)}
          </p>
        </div>
        <div className="shrink-0">
          <p className="mb-1 text-xs text-muted-foreground">Verification status</p>
          <MerchantStatusBadge status={merchant.status} />
        </div>
      </div>
      <p className="mt-3 rounded-md bg-muted px-3 py-2 text-sm">
        {MERCHANT_STATUS_DESCRIPTIONS[merchant.status]}
      </p>
    </Card>
  )
}
