import { Landmark } from 'lucide-react'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import type { BankingConfiguration } from '@/types/merchant'

export function BankingConfigurationPlaceholder({
  status,
}: {
  status: BankingConfiguration['status']
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle>Banking and payment configuration</CardTitle>
        <CardDescription>Kept separate from your registration details.</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex items-start gap-3 rounded-md border border-dashed p-4">
          <Landmark className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
          <div className="text-sm">
            <p className="font-medium">
              {status === 'not_configured' ? 'Not configured' : 'Configured'}
            </p>
            <p className="mt-0.5 text-muted-foreground">
              Bank account linking will be available in a future release, once your business is
              verified. OuPay will never ask for your PIN or password here.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
