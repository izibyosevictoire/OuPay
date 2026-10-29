import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2 } from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { useForm, useWatch } from 'react-hook-form'
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
import { unitSymbol } from '@/constants/catalog'
import { INVENTORY_MAX_REASON } from '@/constants/inventory'
import { useMeasurementUnits } from '@/features/catalog/catalogQueries'
import { InventoryServiceError } from '@/services/inventoryService'
import type { InventoryOptions } from '@/types/inventory'
import { useRecordStock, useStockableGoods } from './inventoryQueries'
import {
  STOCK_ENTRY_DEFAULTS,
  createStockEntrySchema,
  submissionSignature,
  toStockOperation,
  type StockEntryFormValues,
  type StockEntryKind,
} from './inventorySchemas'

const COPY: Record<
  StockEntryKind,
  { title: string; description: string; submit: string; pending: string; success: string }
> = {
  RECEIVE: {
    title: 'Receive stock',
    description: 'Record goods that arrived at a branch, for example from a delivery.',
    submit: 'Receive stock',
    pending: 'Recording…',
    success: 'Stock received.',
  },
  ADJUST: {
    title: 'Adjust stock',
    description:
      'Correct the stock of an item after a count, a loss or damage. Every adjustment needs a reason and is kept in the history.',
    submit: 'Record adjustment',
    pending: 'Recording…',
    success: 'Stock adjusted.',
  },
  OPENING: {
    title: 'Record opening stock',
    description:
      'The first stock of an item at a branch. It can be recorded once, before any other stock movement of that item there.',
    submit: 'Record opening stock',
    pending: 'Recording…',
    success: 'Opening stock recorded.',
  },
}

interface StockEntryDialogProps {
  kind: StockEntryKind
  open: boolean
  onOpenChange: (open: boolean) => void
  options: InventoryOptions
}

export function StockEntryDialog({ kind, open, onOpenChange, options }: StockEntryDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        {/* Mounted only while open: every opening starts with fresh values and a fresh operation identity. */}
        <StockEntryForm kind={kind} options={options} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  )
}

function StockEntryForm({
  kind,
  options,
  onDone,
}: {
  kind: StockEntryKind
  options: InventoryOptions
  onDone: () => void
}) {
  const copy = COPY[kind]
  const { notify } = useToast()
  const goodsQuery = useStockableGoods()
  const unitsQuery = useMeasurementUnits()
  const record = useRecordStock()
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [errorCode, setErrorCode] = useState<string | null>(null)

  const writableBranches = options.branches.filter((branch) => branch.writable)
  const goods = useMemo(() => goodsQuery.data ?? [], [goodsQuery.data])
  const schema = useMemo(() => createStockEntrySchema(kind, goods), [kind, goods])

  const form = useForm<StockEntryFormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      ...STOCK_ENTRY_DEFAULTS,
      branchId: writableBranches.length === 1 ? (writableBranches[0]?.id ?? '') : '',
    },
  })
  const {
    register,
    handleSubmit,
    setValue,
    control,
    formState: { errors, isSubmitting },
  } = form
  const itemId = useWatch({ control, name: 'itemId' })
  const entryMode = useWatch({ control, name: 'entryMode' })
  const unit = useWatch({ control, name: 'unit' })
  const direction = useWatch({ control, name: 'direction' })

  const item = goods.find((candidate) => candidate.id === itemId)
  const activePackages = item?.packages.filter((pkg) => pkg.active) ?? []
  const unitsForItem =
    unitsQuery.data?.find((option) => option.dimension === item?.measurementDimension)?.units ?? []
  const wholeOnly = item?.measurementDimension === 'COUNT'

  /**
   * ONE identity per submission. A retry of the very same request (after a network error, say) re-sends the same id, so the
   * server can never add the stock twice; changing anything the person entered is a different request and gets a new one.
   */
  const operation = useRef<{ id: string; signature: string } | null>(null)
  const operationIdFor = (values: StockEntryFormValues) => {
    const signature = submissionSignature(kind, values)
    if (!operation.current || operation.current.signature !== signature) {
      operation.current = { id: crypto.randomUUID(), signature }
    }
    return operation.current.id
  }

  const itemField = register('itemId', {
    onChange: (event: { target: { value: string } }) => {
      const chosen = goods.find((candidate) => candidate.id === event.target.value)
      setValue('entryMode', 'amount')
      setValue('unit', chosen?.saleUnit ?? '')
      setValue('packageId', '')
      setValue('packageCount', '')
    },
  })

  const onValid = async (values: StockEntryFormValues) => {
    setErrorMessage(null)
    setErrorCode(null)
    const id = operationIdFor(values)
    try {
      const result = await record.mutateAsync(toStockOperation(kind, values, id))
      notify(
        'success',
        result.replayed
          ? 'That was already recorded, so nothing was added again.'
          : `${copy.success} ${result.balance.itemName} at ${result.balance.branchName} is now ${result.balance.quantityOnHand} ${unitSymbol(result.balance.stockUnit)}.`,
      )
      onDone()
    } catch (error) {
      if (error instanceof InventoryServiceError) {
        setErrorCode(error.code)
        setErrorMessage(error.message)
      } else {
        setErrorMessage(
          'The stock could not be recorded. Nothing was lost: you can try again, and the same request will not be counted twice.',
        )
      }
    }
  }

  return (
    <form
      noValidate
      onSubmit={(event) => {
        void handleSubmit(onValid)(event)
      }}
      aria-label={copy.title}
      className="flex max-h-[90dvh] min-h-0 flex-col overflow-hidden"
    >
      <DialogHeader>
        <DialogTitle>{copy.title}</DialogTitle>
        <DialogDescription>{copy.description}</DialogDescription>
      </DialogHeader>
      <DialogBody className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain">
        <FormField label="Branch" required error={errors.branchId?.message}>
          {(field) => (
            <Select {...field} {...register('branchId')}>
              <option value="">Choose…</option>
              {writableBranches.map((branch) => (
                <option key={branch.id} value={branch.id}>
                  {branch.name} ({branch.code})
                </option>
              ))}
            </Select>
          )}
        </FormField>

        <FormField
          label="Item"
          required
          hint="Only goods hold stock. Services are not listed."
          error={errors.itemId?.message}
        >
          {(field) => (
            <Select {...field} disabled={goodsQuery.isPending} {...itemField}>
              <option value="">{goodsQuery.isPending ? 'Loading…' : 'Choose…'}</option>
              {goods.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                  {candidate.code ? ` (${candidate.code})` : ''}
                </option>
              ))}
            </Select>
          )}
        </FormField>
        {goodsQuery.isError && (
          <p role="alert" className="text-sm text-danger">
            The list of goods could not be loaded.{' '}
            <button type="button" className="underline" onClick={() => void goodsQuery.refetch()}>
              Try again
            </button>
          </p>
        )}

        {kind === 'ADJUST' && (
          <FormField label="Direction" required>
            {(field) => (
              <Select {...field} {...register('direction')}>
                <option value="IN">Add stock (in)</option>
                <option value="OUT">Remove stock (out)</option>
              </Select>
            )}
          </FormField>
        )}

        {item && activePackages.length > 0 && (
          <FormField
            label="Enter quantity as"
            required
            hint="A package is a multiple defined for this item in the catalog."
          >
            {(field) => (
              <Select {...field} {...register('entryMode')}>
                <option value="amount">An amount and a unit</option>
                <option value="package">A number of packages</option>
              </Select>
            )}
          </FormField>
        )}

        {entryMode === 'package' && item ? (
          <>
            <FormField label="Package" required error={errors.packageId?.message}>
              {(field) => (
                <Select {...field} {...register('packageId')}>
                  <option value="">Choose…</option>
                  {activePackages.map((pkg) => (
                    <option key={pkg.id} value={pkg.id}>
                      {pkg.label} ({pkg.quantityInSaleUnit} {unitSymbol(item.saleUnit)})
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
            <FormField
              label="Number of packages"
              required
              hint="A fraction is fine when the result is exact, for example 1.5."
              error={errors.packageCount?.message}
            >
              {(field) => (
                <Input
                  inputMode="decimal"
                  autoComplete="off"
                  {...field}
                  {...register('packageCount')}
                />
              )}
            </FormField>
          </>
        ) : (
          <>
            <FormField
              label="Quantity"
              required
              hint={
                wholeOnly
                  ? 'This item is counted in whole pieces.'
                  : item
                    ? 'A plain number. The stock is kept exactly, to six decimals in the smallest unit.'
                    : undefined
              }
              error={errors.amount?.message}
            >
              {(field) => (
                <Input inputMode="decimal" autoComplete="off" {...field} {...register('amount')} />
              )}
            </FormField>
            <FormField label="Unit" required error={errors.unit?.message}>
              {(field) => (
                <Select
                  key={`unit-${item?.id ?? 'none'}-${unitsForItem.length}`}
                  {...field}
                  disabled={!item}
                  {...register('unit')}
                >
                  <option value="">{item ? 'Choose…' : 'Choose an item first'}</option>
                  {unitsForItem.map((option) => (
                    <option key={option.code} value={option.code}>
                      {option.name} ({unitSymbol(option.code)})
                    </option>
                  ))}
                </Select>
              )}
            </FormField>
          </>
        )}
        {kind === 'ADJUST' && direction === 'OUT' && unit && (
          <p className="text-xs text-muted-foreground">
            Stock can never go below zero. If there is not enough, the adjustment is refused.
          </p>
        )}

        <FormField
          label="Reason"
          required={kind === 'ADJUST'}
          hint={
            kind === 'ADJUST'
              ? `Why the stock is changing, for example “Counted 3 fewer than recorded”. Up to ${INVENTORY_MAX_REASON} characters.`
              : undefined
          }
          error={errors.reason?.message}
        >
          {(field) => <Textarea rows={2} {...field} {...register('reason')} />}
        </FormField>
        <FormField
          label="Reference"
          hint="Optional, for example a delivery note number."
          error={errors.reference?.message}
        >
          {(field) => <Input autoComplete="off" {...field} {...register('reference')} />}
        </FormField>

        {errorMessage && (
          <div
            role="alert"
            className="space-y-1 rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
          >
            <p>{errorMessage}</p>
            {errorCode === 'insufficient_stock' && (
              <p className="text-xs">
                Nothing was changed. Lower the quantity or check the current stock.
              </p>
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
          {isSubmitting ? copy.pending : copy.submit}
        </Button>
      </DialogFooter>
    </form>
  )
}
