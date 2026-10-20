import { Building2, Loader2 } from 'lucide-react'
import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/common/EmptyState'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { useToast } from '@/components/common/Toaster'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Skeleton } from '@/components/ui/skeleton'
import { OPERATING_MODE_DETAILS } from '@/constants/merchant'
import { usePermission } from '@/features/auth/permissions/usePermission'
import { formatDateTime } from '@/lib/format'
import { MerchantServiceError } from '@/services/merchantService'
import type { MerchantSettings, OperatingMode } from '@/types/merchant'
import { OperatingModeOptions } from '../OperatingModeOptions'
import {
  useCurrentMerchant,
  useMerchantSettings,
  useUpdateMerchantSettings,
} from '../useMerchantQueries'

function SettingsSkeleton() {
  return <Skeleton className="h-64 w-full" />
}

function OperatingModeCard({
  merchantId,
  settings,
}: {
  merchantId: string
  settings: MerchantSettings
}) {
  const { isAllowed: canChange } = usePermission('profile:edit')
  const { notify } = useToast()
  const update = useUpdateMerchantSettings(merchantId)
  // What the user picked but has not saved yet; null means "show what the server says".
  const [draft, setDraft] = useState<OperatingMode | null>(null)
  const [problem, setProblem] = useState<string | null>(null)

  const selected = draft ?? settings.operatingMode
  const hasChange = selected !== settings.operatingMode

  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!hasChange || update.isPending) return
    setProblem(null)
    try {
      const saved = await update.mutateAsync({
        operatingMode: selected,
        expectedVersion: settings.version,
      })
      setDraft(null)
      notify(
        'success',
        `Operating mode is now ${OPERATING_MODE_DETAILS[saved.operatingMode].label}.`,
      )
    } catch (error) {
      if (error instanceof MerchantServiceError && error.code === 'version_conflict') {
        // The latest settings are being reloaded; drop the stale choice so nothing is overwritten by accident.
        setDraft(null)
      }
      setProblem(
        error instanceof MerchantServiceError
          ? error.message
          : 'Something went wrong while saving. Please try again.',
      )
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Operating mode</CardTitle>
        <p className="text-sm text-muted-foreground">
          How your business uses OuPay. Changing it never removes invoices, payments, staff or
          reports.
        </p>
      </CardHeader>
      <CardContent className="p-4 pt-2 sm:p-5 sm:pt-2">
        <form noValidate onSubmit={(event) => void save(event)} className="space-y-4">
          <OperatingModeOptions
            legend="How should this business work?"
            value={selected}
            onChange={setDraft}
            disabled={!canChange || update.isPending}
          />
          {!canChange && (
            <p className="rounded-md bg-muted px-3 py-2 text-sm">
              Only the business owner can change the operating mode.
            </p>
          )}
          {problem && (
            <p
              role="alert"
              className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
            >
              {problem}
            </p>
          )}
          {settings.updatedAt && (
            <p className="text-xs text-muted-foreground">
              Last changed {formatDateTime(settings.updatedAt)}
            </p>
          )}
          {canChange && (
            <div className="flex justify-end">
              <Button
                type="submit"
                disabled={!hasChange || update.isPending}
                aria-busy={update.isPending}
              >
                {update.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
                {update.isPending ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          )}
        </form>
      </CardContent>
    </Card>
  )
}

function SettingsForBusiness({ merchantId }: { merchantId: string }) {
  const settingsQuery = useMerchantSettings(merchantId)
  return (
    <QueryBoundary
      query={settingsQuery}
      loadingFallback={<SettingsSkeleton />}
      errorMessage="Your business settings could not be loaded."
    >
      {(settings) => (
        // Keyed by business so an unsaved choice never carries over to another business.
        <OperatingModeCard key={merchantId} merchantId={merchantId} settings={settings} />
      )}
    </QueryBoundary>
  )
}

export function MerchantSettingsPage() {
  const merchantQuery = useCurrentMerchant()

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader title="Settings" description="How your business works in OuPay." />
      <QueryBoundary
        query={merchantQuery}
        loadingFallback={<SettingsSkeleton />}
        errorMessage="Your business could not be loaded."
      >
        {(merchant) =>
          merchant === null ? (
            <Card>
              <EmptyState
                icon={Building2}
                title="No business registered yet"
                description="Register your business to choose how it works in OuPay."
              />
              <div className="flex justify-center pb-8">
                <Button asChild>
                  <Link to="/onboarding">Register a business</Link>
                </Button>
              </div>
            </Card>
          ) : (
            <SettingsForBusiness merchantId={merchant.id} />
          )
        }
      </QueryBoundary>
    </div>
  )
}
