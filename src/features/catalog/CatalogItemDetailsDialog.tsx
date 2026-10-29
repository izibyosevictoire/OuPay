import { zodResolver } from '@hookform/resolvers/zod'
import { History, Loader2, PackagePlus, Pencil, Power, PowerOff } from 'lucide-react'
import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { DescriptionList } from '@/components/common/DescriptionList'
import { FormField } from '@/components/common/FormField'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { BranchStatusBadge } from '@/components/common/StatusBadge'
import { useToast } from '@/components/common/Toaster'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input, Select } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  CATALOG_ITEM_TYPE_LABELS,
  MEASUREMENT_DIMENSION_LABELS,
  PRICE_BASIS_EXPLANATION,
  unitSymbol,
} from '@/constants/catalog'
import { formatDateTime, formatRwf } from '@/lib/format'
import { CatalogServiceError } from '@/services/catalogService'
import { CatalogTaxSection } from './CatalogTaxSection'
import type { CatalogItem, CatalogPackage } from '@/types/catalog'
import {
  catalogPackageFormSchema,
  packageToFormValues,
  toPackageInput,
  type CatalogPackageFormValues,
} from './catalogSchemas'
import {
  useCatalogItem,
  useCreateCatalogPackage,
  useMeasurementUnits,
  usePriceHistory,
  useUpdateCatalogPackage,
} from './catalogQueries'

interface CatalogItemDetailsDialogProps {
  itemId: string
  canManage: boolean
  onClose: () => void
}

export function CatalogItemDetailsDialog({
  itemId,
  canManage,
  onClose,
}: CatalogItemDetailsDialogProps) {
  const itemQuery = useCatalogItem(itemId)
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{itemQuery.data?.name ?? 'Catalog item'}</DialogTitle>
          <DialogDescription>
            What this item is, how it is priced and how it is packaged.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="max-h-[75dvh] space-y-5 overflow-y-auto overscroll-contain">
          <QueryBoundary
            query={itemQuery}
            loadingFallback={<Skeleton className="h-40 w-full" />}
            errorMessage="This item could not be loaded."
          >
            {(item) => <ItemDetails item={item} canManage={canManage} />}
          </QueryBoundary>
        </DialogBody>
      </DialogContent>
    </Dialog>
  )
}

const quantityText = (pkg: CatalogPackage, item: CatalogItem) =>
  `${pkg.quantityInSaleUnit} ${unitSymbol(item.saleUnit)}`

function ItemDetails({ item, canManage }: { item: CatalogItem; canManage: boolean }) {
  const goods = item.itemType === 'GOODS'
  const per = goods ? unitSymbol(item.saleUnit) : 'service'
  return (
    <>
      <div className="rounded-lg border">
        <DescriptionList
          rows={[
            { label: 'Type', value: CATALOG_ITEM_TYPE_LABELS[item.itemType] },
            { label: 'Item code', value: item.code ?? undefined },
            { label: 'Description', value: item.description ?? undefined },
            ...(goods
              ? [
                  {
                    label: 'Measured in',
                    value: MEASUREMENT_DIMENSION_LABELS[item.measurementDimension],
                  },
                  {
                    label: 'Stock unit',
                    value: item.stockUnit ? unitSymbol(item.stockUnit) : undefined,
                  },
                  { label: 'Selling unit', value: unitSymbol(item.saleUnit) },
                ]
              : []),
            { label: 'Price', value: `${formatRwf(item.pricePerSaleUnitRwf)} per ${per}` },
            { label: 'Price version', value: String(item.priceVersion) },
          ]}
        />
        <div className="flex items-center gap-2 border-t px-4 py-2.5 text-sm">
          <span className="text-muted-foreground">Status</span>
          <BranchStatusBadge status={item.active ? 'ACTIVE' : 'INACTIVE'} />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">{PRICE_BASIS_EXPLANATION}</p>

      {goods ? (
        <PackagesSection item={item} canManage={canManage} />
      ) : (
        <p className="text-sm text-muted-foreground">Services do not have packages.</p>
      )}
      <CatalogTaxSection item={item} canManage={canManage} />
      <PriceHistorySection item={item} />
    </>
  )
}

// ---- packages ----------------------------------------------------------------------------------------------------

function PackagesSection({ item, canManage }: { item: CatalogItem; canManage: boolean }) {
  const [editing, setEditing] = useState<CatalogPackage | 'new' | null>(null)
  const updatePackage = useUpdateCatalogPackage(item.id)
  const { notify } = useToast()
  const [error, setError] = useState<string | null>(null)

  const toggle = async (pkg: CatalogPackage) => {
    setError(null)
    try {
      await updatePackage.mutateAsync({
        packageId: pkg.id,
        expectedVersion: pkg.version,
        label: pkg.label,
        contentsAmount: pkg.quantityInSaleUnit,
        contentsUnit: item.saleUnit,
        active: !pkg.active,
      })
      notify('success', `${pkg.label} was ${pkg.active ? 'deactivated' : 'activated'}.`)
    } catch (caught) {
      setError(
        caught instanceof CatalogServiceError
          ? caught.message
          : 'The package could not be changed.',
      )
    }
  }

  return (
    <section aria-labelledby={`packages-${item.id}`} className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id={`packages-${item.id}`} className="text-sm font-semibold">
          Packages
        </h2>
        {canManage && editing === null && (
          <Button variant="outline" size="sm" onClick={() => setEditing('new')}>
            <PackagePlus aria-hidden="true" />
            Add package
          </Button>
        )}
      </div>
      <p className="text-xs text-muted-foreground">
        A package is defined for this item only, for example a carton of 24 or a bag of 25 kg. It
        has no price of its own: it is a multiple of the selling unit.
      </p>
      {item.packages.length === 0 && editing === null && (
        <p className="text-sm text-muted-foreground">No packages defined.</p>
      )}
      {item.packages.length > 0 && (
        <ul className="divide-y rounded-lg border">
          {item.packages.map((pkg) => (
            <li
              key={pkg.id}
              className="flex flex-wrap items-center justify-between gap-2 px-4 py-2.5"
            >
              <div className="min-w-0 text-sm">
                <p className="font-medium">
                  {pkg.label}
                  {!pkg.active && (
                    <span className="ml-2 text-xs font-normal text-muted-foreground">
                      (inactive)
                    </span>
                  )}
                </p>
                <p className="text-xs text-muted-foreground">
                  {quantityText(pkg, item)} · {pkg.quantityPerPackage}{' '}
                  {unitSymbol(pkg.canonicalUnit)} in stock
                </p>
              </div>
              {canManage && (
                <div className="flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing(pkg)}
                    aria-label={`Edit package ${pkg.label}`}
                  >
                    <Pencil aria-hidden="true" />
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={updatePackage.isPending}
                    onClick={() => void toggle(pkg)}
                    aria-label={`${pkg.active ? 'Deactivate' : 'Activate'} package ${pkg.label}`}
                  >
                    {pkg.active ? <PowerOff aria-hidden="true" /> : <Power aria-hidden="true" />}
                    {pkg.active ? 'Deactivate' : 'Activate'}
                  </Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {canManage && editing !== null && (
        <PackageForm
          // A fresh form (and fresh defaults) for every package or "new" target.
          key={editing === 'new' ? 'new' : `${editing.id}-${editing.version}`}
          item={item}
          pkg={editing === 'new' ? undefined : editing}
          onDone={() => setEditing(null)}
        />
      )}
    </section>
  )
}

function PackageForm({
  item,
  pkg,
  onDone,
}: {
  item: CatalogItem
  pkg?: CatalogPackage
  onDone: () => void
}) {
  const { notify } = useToast()
  const unitsQuery = useMeasurementUnits()
  const createPackage = useCreateCatalogPackage(item.id)
  const updatePackage = useUpdateCatalogPackage(item.id)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const units = unitsQuery.data?.find((o) => o.dimension === item.measurementDimension)?.units ?? []

  const form = useForm<CatalogPackageFormValues>({
    resolver: zodResolver(catalogPackageFormSchema),
    defaultValues: pkg
      ? packageToFormValues(pkg, item)
      : { label: '', contentsAmount: '', contentsUnit: item.saleUnit },
  })
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = form

  const submit = handleSubmit(async (values) => {
    setErrorMessage(null)
    try {
      if (pkg) {
        await updatePackage.mutateAsync({
          packageId: pkg.id,
          expectedVersion: pkg.version,
          active: pkg.active,
          ...toPackageInput(values),
        })
        notify('success', `${values.label} was updated.`)
      } else {
        await createPackage.mutateAsync(toPackageInput(values))
        notify('success', `${values.label} was added.`)
      }
      onDone()
    } catch (error) {
      setErrorMessage(
        error instanceof CatalogServiceError ? error.message : 'The package could not be saved.',
      )
    }
  })

  return (
    <form
      noValidate
      onSubmit={submit}
      aria-label={pkg ? `Edit package ${pkg.label}` : 'Add package'}
      className="space-y-3 rounded-lg border bg-muted/40 p-4"
    >
      <FormField
        label="Package label"
        required
        hint="For example Carton, Bag or Bottle."
        error={errors.label?.message}
      >
        {(field) => <Input {...field} {...register('label')} />}
      </FormField>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          label="One package holds"
          required
          hint="A plain number, for example 24 or 0.75."
          error={errors.contentsAmount?.message}
        >
          {(field) => (
            <Input
              inputMode="decimal"
              autoComplete="off"
              {...field}
              {...register('contentsAmount')}
            />
          )}
        </FormField>
        <FormField label="Unit" required error={errors.contentsUnit?.message}>
          {(field) => (
            <Select key={`pkg-unit-${units.length}`} {...field} {...register('contentsUnit')}>
              {units.map((unit) => (
                <option key={unit.code} value={unit.code}>
                  {unit.name} ({unitSymbol(unit.code)})
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </div>
      {errorMessage && (
        <p role="alert" className="text-sm text-danger">
          {errorMessage}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onDone} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={isSubmitting} aria-busy={isSubmitting}>
          {isSubmitting && <Loader2 className="animate-spin" aria-hidden="true" />}
          {pkg ? 'Save package' : 'Add package'}
        </Button>
      </div>
    </form>
  )
}

// ---- price history -----------------------------------------------------------------------------------------------

function PriceHistorySection({ item }: { item: CatalogItem }) {
  const [shown, setShown] = useState(false)
  const history = usePriceHistory(item.id, shown)
  return (
    <section aria-labelledby={`history-${item.id}`} className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <h2 id={`history-${item.id}`} className="text-sm font-semibold">
          Price history
        </h2>
        <Button
          variant="outline"
          size="sm"
          aria-expanded={shown}
          onClick={() => setShown((value) => !value)}
        >
          <History aria-hidden="true" />
          {shown ? 'Hide price history' : 'Show price history'}
        </Button>
      </div>
      {shown && (
        <QueryBoundary
          query={history}
          loadingFallback={<Skeleton className="h-16 w-full" />}
          errorMessage="The price history could not be loaded."
        >
          {(versions) => (
            <ul className="divide-y rounded-lg border" aria-label="Price versions">
              {versions.map((version) => (
                <li key={version.version} className="space-y-0.5 px-4 py-2.5 text-sm">
                  <p className="font-medium">
                    Version {version.version}: {formatRwf(version.pricePerSaleUnitRwf)} per{' '}
                    {item.itemType === 'GOODS' ? unitSymbol(version.saleUnit) : 'service'}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    From {formatDateTime(version.effectiveAt)}
                    {version.reason ? ` · ${version.reason}` : ''}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </QueryBoundary>
      )}
      <p className="text-xs text-muted-foreground">
        Price versions never change. Invoices will keep the price they were issued at.
      </p>
    </section>
  )
}
