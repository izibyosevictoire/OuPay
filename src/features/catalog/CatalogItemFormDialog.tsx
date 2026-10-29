import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'
import { useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
import { CheckboxField } from '@/components/common/CheckboxField'
import { FormField } from '@/components/common/FormField'
import { useToast } from '@/components/common/Toaster'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input, Select, Textarea } from '@/components/ui/input'
import {
  CATALOG_ITEM_TYPE_LABELS,
  MEASUREMENT_DIMENSION_LABELS,
  PRICE_BASIS_EXPLANATION,
  unitSymbol,
} from '@/constants/catalog'
import { catalogService } from '@/services'
import { CatalogServiceError } from '@/services/catalogService'
import type { CatalogItem, MeasurementDimension } from '@/types/catalog'
import {
  CATALOG_ITEM_FORM_DEFAULTS,
  catalogItemFormSchema,
  itemToFormValues,
  toCreateItemInput,
  toUpdateItemInput,
  type CatalogItemFormValues,
} from './catalogSchemas'
import { useCreateCatalogItem, useMeasurementUnits, useUpdateCatalogItem } from './catalogQueries'
import { useSelectedMerchantId } from '@/features/branches/useBranchQueries'

interface CatalogItemFormDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Present when editing; absent when creating. */
  item?: CatalogItem
}

export function CatalogItemFormDialog({ open, onOpenChange, item }: CatalogItemFormDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Mounted only while open, so every opening starts from fresh values. */}
        <CatalogItemForm item={item} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function CatalogItemForm({ item, onDone }: { item?: CatalogItem; onDone: () => void }) {
  const merchantId = useSelectedMerchantId()
  const { notify } = useToast()
  const unitsQuery = useMeasurementUnits()
  const createItem = useCreateCatalogItem()
  // The version the form is editing. A conflict lets the person reload the latest one without closing the form.
  const [current, setCurrent] = useState<CatalogItem | undefined>(item)
  const updateItem = useUpdateCatalogItem(item?.id ?? '')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [conflict, setConflict] = useState(false)
  const [isReloading, setIsReloading] = useState(false)
  const isEditing = Boolean(item)

  const form = useForm<CatalogItemFormValues>({
    resolver: zodResolver(catalogItemFormSchema),
    defaultValues: item ? itemToFormValues(item) : CATALOG_ITEM_FORM_DEFAULTS,
  })
  const {
    register,
    handleSubmit,
    setError,
    setValue,
    reset,
    control,
    formState: { errors, isSubmitting },
  } = form
  const itemType = useWatch({ control, name: 'itemType' })
  const dimension = useWatch({ control, name: 'measurementDimension' })
  const saleUnit = useWatch({ control, name: 'saleUnit' })
  const price = useWatch({ control, name: 'price' })

  const options = unitsQuery.data ?? []
  const unitsForDimension = options.find((option) => option.dimension === dimension)?.units ?? []
  const isGoods = itemType === 'GOODS'
  const unitName = unitsForDimension.find((unit) => unit.code === saleUnit)?.name.toLowerCase()
  const priceChanged =
    isEditing &&
    current !== undefined &&
    (price !== String(current.pricePerSaleUnitRwf) || (isGoods && saleUnit !== current.saleUnit))

  const submit = handleSubmit(async (values) => {
    setErrorMessage(null)
    setConflict(false)
    try {
      if (current) {
        await updateItem.mutateAsync(toUpdateItemInput(values, current.version))
        notify('success', `${values.name} was updated.`)
      } else {
        await createItem.mutateAsync(toCreateItemInput(values))
        notify('success', `${values.name} was added to the catalog.`)
      }
      onDone()
    } catch (error) {
      if (error instanceof CatalogServiceError && error.code === 'duplicate_code') {
        setError('code', { message: error.message }, { shouldFocus: true })
      } else if (error instanceof CatalogServiceError && error.code === 'version_conflict') {
        setConflict(true)
        setErrorMessage(error.message)
      } else {
        setErrorMessage(
          error instanceof CatalogServiceError
            ? error.message
            : 'The item could not be saved. Please try again.',
        )
      }
    }
  })

  const reloadLatest = async () => {
    if (!item) return
    setIsReloading(true)
    try {
      const latest = await catalogService.getItem(merchantId, item.id)
      setCurrent(latest)
      reset(itemToFormValues(latest))
      setConflict(false)
      setErrorMessage(null)
    } catch (error) {
      setErrorMessage(
        error instanceof CatalogServiceError
          ? error.message
          : 'The latest version could not be loaded.',
      )
    } finally {
      setIsReloading(false)
    }
  }

  const dimensionField = register('measurementDimension', {
    onChange: () => setValue('saleUnit', '', { shouldValidate: false }),
  })

  return (
    <form
      noValidate
      onSubmit={submit}
      aria-label={isEditing ? 'Edit catalog item' : 'Add catalog item'}
      className="flex max-h-[90dvh] min-h-0 flex-col overflow-hidden"
    >
      <DialogHeader>
        <DialogTitle>{isEditing ? 'Edit catalog item' : 'Add a catalog item'}</DialogTitle>
        <DialogDescription>
          {isEditing
            ? 'Update the details or the price. The type and what it is measured in cannot change.'
            : 'Goods are sold by a measured unit. A service is priced per service.'}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain">
        <FormField
          label="Type"
          required
          hint={isEditing ? 'The type is fixed once the item exists.' : undefined}
          error={errors.itemType?.message}
        >
          {(field) => (
            <Select {...field} disabled={isEditing} {...register('itemType')}>
              <option value="GOODS">{CATALOG_ITEM_TYPE_LABELS.GOODS}</option>
              <option value="SERVICE">{CATALOG_ITEM_TYPE_LABELS.SERVICE}</option>
            </Select>
          )}
        </FormField>
        <FormField label="Name" required error={errors.name?.message}>
          {(field) => <Input {...field} {...register('name')} />}
        </FormField>
        <FormField
          label="Item code"
          hint="Your own code or SKU. Unique in your business; capitals are applied."
          error={errors.code?.message}
        >
          {(field) => <Input autoCapitalize="characters" {...field} {...register('code')} />}
        </FormField>
        <FormField label="Description" error={errors.description?.message}>
          {(field) => <Textarea {...field} {...register('description')} />}
        </FormField>

        {isGoods ? (
          <>
            {unitsQuery.isError && (
              <p
                role="alert"
                className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
              >
                The list of units could not be loaded.{' '}
                <button
                  type="button"
                  className="underline"
                  onClick={() => void unitsQuery.refetch()}
                >
                  Try again
                </button>
              </p>
            )}
            <FormField
              label="Measured in"
              required
              hint={
                isEditing && current?.stockUnit
                  ? `Stock is kept in ${unitSymbol(current.stockUnit)}. This cannot change.`
                  : 'What the item is measured by. It cannot be changed later.'
              }
              error={errors.measurementDimension?.message}
            >
              {(field) => (
                // Remounted when the options arrive, so an already-chosen value is shown by the native select.
                <Select
                  key={`dimension-${options.length}`}
                  {...field}
                  disabled={isEditing || unitsQuery.isPending}
                  {...dimensionField}
                >
                  <option value="">{unitsQuery.isPending ? 'Loading…' : 'Choose…'}</option>
                  {options.map((option) => (
                    <option key={option.dimension} value={option.dimension}>
                      {MEASUREMENT_DIMENSION_LABELS[option.dimension as MeasurementDimension]}
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField
              label="Selling unit"
              required
              hint="The unit customers buy it by. Its units come from the measurement type."
              error={errors.saleUnit?.message}
            >
              {(field) => (
                <Select
                  key={`unit-${dimension}-${options.length}`}
                  {...field}
                  disabled={!dimension}
                  {...register('saleUnit')}
                >
                  <option value="">
                    {dimension ? 'Choose…' : 'Choose what it is measured in first'}
                  </option>
                  {unitsForDimension.map((unit) => (
                    <option key={unit.code} value={unit.code}>
                      {unit.name} ({unitSymbol(unit.code)})
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
          </>
        ) : (
          <p className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
            A service is priced per service. It has no stock and no selling unit to choose.
          </p>
        )}

        <FormField
          label="Price (RWF)"
          required
          hint={`Price of one ${isGoods ? (unitName ?? 'selling unit') : 'service'}, in whole francs.`}
          error={errors.price?.message}
        >
          {(field) => (
            <Input inputMode="numeric" autoComplete="off" {...field} {...register('price')} />
          )}
        </FormField>
        <p className="text-xs text-muted-foreground">{PRICE_BASIS_EXPLANATION}</p>

        {isEditing && priceChanged && (
          <FormField
            label="Reason for the change"
            hint="Saved with the new price version in the price history."
            error={errors.priceChangeReason?.message}
          >
            {(field) => <Input {...field} {...register('priceChangeReason')} />}
          </FormField>
        )}

        {!isEditing && <CheckboxField label="Active (available to sell)" {...register('active')} />}

        {errorMessage && (
          <div
            role="alert"
            className="space-y-2 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
          >
            <p>{errorMessage}</p>
            {conflict && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => void reloadLatest()}
                disabled={isReloading}
              >
                {isReloading && <Loader2 className="animate-spin" aria-hidden="true" />}
                Reload the latest version
              </Button>
            )}
          </div>
        )}
      </DialogBody>
      <DialogFooter className="shrink-0">
        <Button type="button" variant="outline" onClick={onDone} disabled={isSubmitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={isSubmitting} aria-busy={isSubmitting}>
          {isSubmitting && <Loader2 className="animate-spin" aria-hidden="true" />}
          {isSubmitting ? 'Saving…' : isEditing ? 'Save changes' : 'Add item'}
        </Button>
      </DialogFooter>
    </form>
  )
}
