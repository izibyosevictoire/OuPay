import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { FormField } from '@/components/common/FormField'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { useToast } from '@/components/common/Toaster'
import { Button } from '@/components/ui/button'
import { Input, Select } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { CatalogServiceError } from '@/services/catalogService'
import type { CatalogItem, ItemTax, ItemTaxCategory } from '@/types/catalog'
import { useItemTax, useSetItemTax } from './catalogQueries'

const CATEGORY_LABELS: Record<ItemTaxCategory, string> = {
  NOT_APPLICABLE: 'Not applicable',
  EXEMPT: 'Exempt',
  ZERO_RATED: 'Zero-rated',
  STANDARD: 'Standard rate',
}

const describe = (tax: ItemTax) =>
  !tax.configured || !tax.taxCategory
    ? 'No tax treatment is set. This item cannot be billed at a POS until one is.'
    : `${CATEGORY_LABELS[tax.taxCategory]}${
        tax.taxCategory === 'STANDARD' && tax.taxRateBp !== null
          ? ` ${(tax.taxRateBp / 100).toFixed(2)}%`
          : ''
      }${tax.approvedForPos ? '' : ' (not approved for POS billing yet)'}`

function TaxForm({
  item,
  tax,
  canManage,
}: {
  item: CatalogItem
  tax: ItemTax
  canManage: boolean
}) {
  const { notify } = useToast()
  const save = useSetItemTax(item.id)
  const [category, setCategory] = useState<ItemTaxCategory | ''>(tax.taxCategory ?? '')
  const [rate, setRate] = useState(
    tax.taxRateBp !== null && tax.taxCategory === 'STANDARD'
      ? (tax.taxRateBp / 100).toFixed(2)
      : '',
  )
  const [error, setError] = useState<string | null>(null)

  const submit = async () => {
    setError(null)
    if (!category) {
      setError('Choose a tax treatment. Nothing is assumed.')
      return
    }
    let basisPoints = 0
    if (category === 'STANDARD') {
      // Percent text to basis points, exactly (no floating point): "18" and "18.5" are fine, "18.555" is not.
      const match = /^([0-9]{1,3})(?:\.([0-9]{1,2}))?$/.exec(rate.trim())
      if (!match) {
        setError(
          'Enter the rate as a percentage with at most two decimals, for example 18 or 18.5.',
        )
        return
      }
      basisPoints = Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0'))
    }
    try {
      await save.mutateAsync({
        expectedVersion: tax.version,
        taxCategory: category,
        taxRateBp: basisPoints,
      })
      notify('success', 'Tax treatment saved.')
    } catch (e) {
      setError(
        e instanceof CatalogServiceError ? e.message : 'The tax treatment could not be saved.',
      )
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm" data-configured={tax.configured}>
        {describe(tax)}
      </p>
      {canManage && (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Tax treatment" required>
            {(control) => (
              <Select
                {...control}
                value={category}
                onChange={(event) => setCategory(event.target.value as ItemTaxCategory | '')}
              >
                <option value="">Choose a treatment</option>
                {(Object.keys(CATEGORY_LABELS) as ItemTaxCategory[]).map((c) => (
                  <option key={c} value={c}>
                    {CATEGORY_LABELS[c]}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
          {category === 'STANDARD' && (
            <FormField label="Rate (%)" required>
              {(control) => (
                <Input
                  {...control}
                  inputMode="decimal"
                  value={rate}
                  onChange={(event) => setRate(event.target.value)}
                />
              )}
            </FormField>
          )}
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {canManage && (
        <Button type="button" size="sm" onClick={() => void submit()} disabled={save.isPending}>
          {save.isPending && <Loader2 className="animate-spin" aria-hidden="true" />}
          Save tax treatment
        </Button>
      )}
      <p className="text-xs text-muted-foreground">
        Used when this item is billed at a POS. A bill keeps the treatment it was billed with. OuPay
        does not decide what is taxable and makes no claim of tax compliance: confirm it with your
        tax adviser.
      </p>
    </div>
  )
}

/** The tax treatment of one catalog item: explicit, never defaulted, and a missing one blocks POS billing. */
export function CatalogTaxSection({ item, canManage }: { item: CatalogItem; canManage: boolean }) {
  const query = useItemTax(item.id)
  return (
    <section aria-labelledby={`tax-${item.id}`} className="space-y-3">
      <h3 id={`tax-${item.id}`} className="text-sm font-semibold">
        Tax treatment
      </h3>
      <QueryBoundary
        query={query}
        loadingFallback={<Skeleton className="h-16 w-full" />}
        errorMessage="The tax treatment could not be loaded."
      >
        {(tax) => <TaxForm key={tax.version} item={item} tax={tax} canManage={canManage} />}
      </QueryBoundary>
    </section>
  )
}
