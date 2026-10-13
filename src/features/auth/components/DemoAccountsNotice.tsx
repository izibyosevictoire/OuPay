import { FlaskConical } from 'lucide-react'
import { DEMO_ACCOUNT_DESCRIPTIONS } from '@/services/mock/sampleAccounts'
import { DEMO_PASSWORD } from '@/services/mock/sampleAccounts'

/** Makes the mock nature of sign-in unmistakable and lists the public demo accounts. */
export function DemoAccountsNotice() {
  return (
    <details className="rounded-lg border border-info/20 bg-info-soft text-sm text-info">
      <summary className="flex min-h-10 cursor-pointer items-center gap-2 px-3 font-medium">
        <FlaskConical className="size-4 shrink-0" aria-hidden="true" />
        Demo mode: use a sample account
      </summary>
      <div className="space-y-2 px-3 pb-3">
        <p>
          Sign-in is simulated for development. These are public demo accounts, not real
          credentials. Password for all of them:{' '}
          <code className="rounded bg-card px-1 font-mono">{DEMO_PASSWORD}</code>
        </p>
        <ul className="space-y-1">
          {DEMO_ACCOUNT_DESCRIPTIONS.map(({ email, description }) => (
            <li key={email}>
              <code className="font-mono">{email}</code> <span aria-hidden="true">·</span>{' '}
              {description}
            </li>
          ))}
        </ul>
      </div>
    </details>
  )
}
