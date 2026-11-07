import { FlaskConical, LogOut, RotateCcw } from 'lucide-react'
import { useState } from 'react'
import { useAuth } from '@/app/providers/AuthProvider'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { Button } from '@/components/ui/button'
import { DEMO_BANNER_TEXT } from '@/lib/demoExperience'
import { clearDemoBrowserState } from '@/services/mock/demoData'

interface DemoModeBannerProps {
  /** What follows a reset. The default reloads the demo, which loads the original examples again. Overridable in tests. */
  onReset?: () => void
}

const reloadDemo = () => window.location.assign('/')

/**
 * The statement shown on EVERY screen of the demo experience, signed in or not, including the customer payment pages: nothing in it is real.
 * It also offers the two demo-only controls: switch to another example role, and restore the original examples (after a confirmation).
 */
export function DemoModeBanner({ onReset = reloadDemo }: DemoModeBannerProps) {
  const { status, user, logout } = useAuth()
  const [confirmingReset, setConfirmingReset] = useState(false)
  const [switching, setSwitching] = useState(false)

  const switchRole = async () => {
    setSwitching(true)
    try {
      await logout()
    } finally {
      setSwitching(false)
    }
  }

  const reset = () => {
    clearDemoBrowserState({ local: window.localStorage, session: window.sessionStorage })
    setConfirmingReset(false)
    onReset()
  }

  return (
    <>
      <div
        role="region"
        aria-label="Demo mode"
        className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-b border-warning/30 bg-warning-soft px-4 py-1.5 text-sm text-warning print:hidden"
      >
        <p className="flex items-center gap-2 font-semibold">
          <FlaskConical className="size-4 shrink-0" aria-hidden="true" />
          <span>{DEMO_BANNER_TEXT}</span>
        </p>
        <div className="flex flex-wrap items-center gap-2">
          {status === 'authenticated' && user && (
            <span className="text-xs" data-testid="demo-signed-in-as">
              Signed in as {user.fullName}
            </span>
          )}
          {status === 'authenticated' && (
            <Button type="button" variant="ghost" size="sm" onClick={() => void switchRole()} disabled={switching}>
              <LogOut aria-hidden="true" />
              Switch role
            </Button>
          )}
          <Button type="button" variant="ghost" size="sm" onClick={() => setConfirmingReset(true)}>
            <RotateCcw aria-hidden="true" />
            Reset demo data
          </Button>
        </div>
      </div>
      <ConfirmDialog
        open={confirmingReset}
        onOpenChange={setConfirmingReset}
        title="Reset demo data?"
        description="This puts back the original Kigali Demo Supermarket examples and removes everything you added or changed in this demo. Nothing outside the demo is affected, and no real data exists here."
        confirmLabel="Reset demo data"
        isDestructive
        onConfirm={reset}
      />
    </>
  )
}
