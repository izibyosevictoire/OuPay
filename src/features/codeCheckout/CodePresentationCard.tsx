import { Info } from 'lucide-react'
import { CODE_DEMO_NOTICE } from '@/constants/codeCheckout'
import type { CodePresentation } from '@/types/codeCheckout'

interface CodePresentationCardProps {
  code: CodePresentation
  /** Wording Equity has confirmed. Empty until it exists: none is ever invented here. */
  instructions?: string[]
  saleReference: string
}

/**
 * What the customer pays with. A LIVE sale shows the bank-approved code; a DEMONSTRATION shows a prominent statement that nothing
 * can be paid, and OuPay's internal reference is labelled as NOT a payment code. The sale reference is always shown.
 */
export function CodePresentationCard({
  code,
  instructions = [],
  saleReference,
}: CodePresentationCardProps) {
  const demo = code.mode === 'DEMONSTRATION'
  return (
    <section aria-labelledby="code-card-heading" className="space-y-3">
      <h2 id="code-card-heading" className="text-sm font-medium">
        {demo ? 'Demonstration code' : 'Pay with this code'}
      </h2>
      {demo && (
        <div
          role="note"
          className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning-soft px-3 py-2 text-sm font-medium text-warning"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <p>{code.notice ?? CODE_DEMO_NOTICE}</p>
        </div>
      )}
      <div className="rounded-lg border bg-muted/40 px-4 py-3 text-center">
        <p className="text-xs text-muted-foreground">{code.label}</p>
        {demo ? (
          <p className="mt-1 text-sm font-medium text-foreground">
            Not payable: this is a simulated code, not a bank payment code.
            {code.demoReference && (
              <span className="mt-1 block text-xs font-normal text-muted-foreground">
                Internal reference{' '}
                <span className="font-mono font-semibold text-foreground">
                  {code.demoReference}
                </span>{' '}
                (not a payment code)
              </span>
            )}
          </p>
        ) : (
          <p
            className="mt-1 break-all font-mono text-3xl font-semibold tracking-wide tabular-nums"
            aria-label={`Merchant code ${code.bankCode ?? ''}`}
          >
            {code.bankCode}
          </p>
        )}
        <p className="mt-3 text-xs text-muted-foreground">Sale reference</p>
        <p className="font-mono text-xl font-semibold tracking-wide">{saleReference}</p>
      </div>
      {!demo && instructions.length > 0 && (
        <ol className="list-decimal space-y-1 pl-5 text-sm">
          {instructions.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ol>
      )}
      <p className="text-xs text-muted-foreground">
        OuPay never asks for a PIN, password or one-time code.
      </p>
    </section>
  )
}
