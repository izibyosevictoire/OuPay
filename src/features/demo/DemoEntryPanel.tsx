import { FlaskConical, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useAuth } from '@/app/providers/AuthProvider'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { KIGALI_DEMO_ACCOUNTS, KIGALI_DEMO_PASSWORD, type DemoAccount } from '@/lib/demoAccounts'
import { DEMO_BANNER_TEXT } from '@/lib/demoExperience'
import { AuthServiceError } from '@/services/authService'

/**
 * The front door of the demo experience: choose a person and you are in Kigali Demo Supermarket, already filled with examples. The three
 * accounts are fictional and the password is public: signing in is simulated and unlocks nothing real.
 */
export function DemoEntryPanel() {
  const { login } = useAuth()
  const [pending, setPending] = useState<DemoAccount['key'] | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const enter = async (account: DemoAccount) => {
    setPending(account.key)
    setErrorMessage(null)
    try {
      // Remembered, so the demo (and what you add to it) is still there after a refresh or a restart of the browser.
      await login({ email: account.email, password: KIGALI_DEMO_PASSWORD }, { rememberMe: true })
    } catch (error) {
      setErrorMessage(error instanceof AuthServiceError ? error.message : 'We could not open the demo. Please try again.')
      setPending(null)
    }
  }

  return (
    <Card>
      <CardContent className="space-y-4 p-5 sm:p-6">
        <div>
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-warning">
            <FlaskConical className="size-4" aria-hidden="true" />
            {DEMO_BANNER_TEXT}
          </p>
          <h1 className="mt-2 text-section-title">Try OuPay Business</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Open <strong>Kigali Demo Supermarket</strong>, a fictional shop with three branches, products, stock, sample carts, payment points and simulated
            payments, and learn the screens by using them. Add, edit and manage anything: it stays in this browser, and you can reset it at any time.
          </p>
        </div>

        {errorMessage && (
          <p role="alert" className="rounded-md bg-danger-soft px-3 py-2 text-sm text-danger">
            {errorMessage}
          </p>
        )}

        <ul className="space-y-2">
          {KIGALI_DEMO_ACCOUNTS.map((account) => (
            <li key={account.key} className="flex flex-col gap-2 rounded-lg border p-3 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-sm font-medium">
                  {account.name} <span className="font-normal text-muted-foreground">· {account.role}</span>
                </p>
                <p className="text-xs text-muted-foreground">{account.description}</p>
              </div>
              <Button type="button" onClick={() => void enter(account)} disabled={pending !== null} aria-label={`Enter the demo as ${account.role}`}>
                {pending === account.key && <Loader2 className="animate-spin" aria-hidden="true" />}
                Enter as {account.role}
              </Button>
            </li>
          ))}
        </ul>

        <p className="text-xs text-muted-foreground">
          These are public demo accounts. No real money moves, no real bank is contacted, and you will never be asked for a PIN, a one-time code or bank
          details.
        </p>
      </CardContent>
    </Card>
  )
}
