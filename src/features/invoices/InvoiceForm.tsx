import { zodResolver } from '@hookform/resolvers/zod'
import { Loader2, Plus, Save, Send, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useFieldArray, useForm, useWatch, type Resolver } from 'react-hook-form'
import { Link, useNavigate } from 'react-router-dom'
import { ConfirmDialog } from '@/components/common/ConfirmDialog'
import { FormField } from '@/components/common/FormField'
import { useToast } from '@/components/common/Toaster'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Input, Select, Textarea } from '@/components/ui/input'
import { TAX_CHOICE_OPTIONS, TAX_MODE_HINTS, TAX_MODE_LABELS } from '@/constants/invoice'
import { formatRwf } from '@/lib/format'
import { calculateInvoice } from '@/lib/invoiceCalculations'
import { InvoiceServiceError } from '@/services/invoiceService'
import type { Invoice, InvoiceFormOptions } from '@/types/invoice'
import { InvoiceTotalsBlock } from './InvoiceTotals'
import {
  defaultInvoiceFormValues,
  draftInvoiceSchema,
  EMPTY_ITEM,
  invoiceToFormValues,
  issueInvoiceSchema,
  itemsForPreview,
  toDraftInput,
  type InvoiceFormValues,
} from './invoiceSchemas'
import { useCreateDraft, useIssueInvoice, useUpdateDraft } from './useInvoiceQueries'

type Intent = 'draft' | 'issue'

interface InvoiceFormProps {
  options: InvoiceFormOptions
  /** Present when editing an existing draft. */
  invoice?: Invoice
  /** Cashiers always act for themselves; the assignee is fixed to this user. */
  fixedAssigneeUserId?: string
}

/**
 * A draft keeps the branch and cashier it was written with, but those may no longer be
 * eligible (branch deactivated, cashier reassigned). Blank them so the user must choose again.
 */
function withEligibleChoices(
  values: InvoiceFormValues,
  options: InvoiceFormOptions,
): InvoiceFormValues {
  const branchOk = options.branches.some((branch) => branch.id === values.branchId)
  const assigneeOk = options.assignees.some(
    (assignee) =>
      assignee.userId === values.assignedToUserId && assignee.branchIds.includes(values.branchId),
  )
  return {
    ...values,
    branchId: branchOk ? values.branchId : '',
    assignedToUserId: branchOk && assigneeOk ? values.assignedToUserId : '',
  }
}

const errorText = (error: unknown) =>
  error instanceof InvoiceServiceError ? error.message : 'Something went wrong. Please try again.'

export function InvoiceForm({ options, invoice, fixedAssigneeUserId }: InvoiceFormProps) {
  const navigate = useNavigate()
  const { notify } = useToast()
  const createDraft = useCreateDraft()
  const updateDraft = useUpdateDraft()
  const issueInvoice = useIssueInvoice()

  /** Which button was pressed decides how strictly the form is validated. */
  const intent = useRef<Intent>('draft')
  /** Remembers a draft created by this form, so a retry updates it instead of duplicating it. */
  const persisted = useRef<{ id: string; version: number } | null>(
    invoice ? { id: invoice.id, version: invoice.version } : null,
  )
  const isBusyRef = useRef(false)
  const [isBusy, setIsBusy] = useState(false)
  const [activeAction, setActiveAction] = useState<Intent | null>(null)
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [confirmValues, setConfirmValues] = useState<InvoiceFormValues | null>(null)

  const resolver: Resolver<InvoiceFormValues> = (values, context, resolverOptions) =>
    zodResolver(intent.current === 'issue' ? issueInvoiceSchema : draftInvoiceSchema)(
      values,
      context,
      resolverOptions,
    ) as ReturnType<Resolver<InvoiceFormValues>>

  const form = useForm<InvoiceFormValues>({
    resolver,
    defaultValues: invoice
      ? withEligibleChoices(invoiceToFormValues(invoice), options)
      : { ...defaultInvoiceFormValues(), assignedToUserId: fixedAssigneeUserId ?? '' },
    mode: 'onTouched',
  })
  const {
    register,
    control,
    handleSubmit,
    setValue,
    getValues,
    formState: { errors },
  } = form
  const { fields, append, remove } = useFieldArray({ control, name: 'items' })

  const items = useWatch({ control, name: 'items' })
  const taxMode = useWatch({ control, name: 'taxMode' })
  const branchId = useWatch({ control, name: 'branchId' })
  const assignedToUserId = useWatch({ control, name: 'assignedToUserId' })

  const preview = useMemo(
    () => calculateInvoice(itemsForPreview(items ?? []), taxMode),
    [items, taxMode],
  )

  // Only people actively assigned to the chosen branch can be the seller.
  const eligibleAssignees = useMemo(
    () => options.assignees.filter((assignee) => assignee.branchIds.includes(branchId)),
    [options.assignees, branchId],
  )

  // Keep the assignee valid as the branch changes; a cashier is always themselves.
  useEffect(() => {
    if (!branchId) return
    const stillEligible = eligibleAssignees.some((a) => a.userId === assignedToUserId)
    if (stillEligible) return
    // A cashier is always the seller. Anyone else must choose again, so the assignee never changes silently.
    const next =
      fixedAssigneeUserId && eligibleAssignees.some((a) => a.userId === fixedAssigneeUserId)
        ? fixedAssigneeUserId
        : ''
    if (next !== assignedToUserId) setValue('assignedToUserId', next)
  }, [branchId, eligibleAssignees, assignedToUserId, fixedAssigneeUserId, setValue])

  /** Saves the form as a draft (creating it once, then updating it). */
  const persistDraft = async (values: InvoiceFormValues) => {
    const input = toDraftInput(values)
    if (persisted.current) {
      const saved = await updateDraft.mutateAsync({
        invoiceId: persisted.current.id,
        input,
        version: persisted.current.version,
      })
      persisted.current = { id: saved.id, version: saved.version }
      return saved
    }
    const created = await createDraft.mutateAsync(input)
    persisted.current = { id: created.id, version: created.version }
    return created
  }

  const run = async (action: Intent, work: () => Promise<void>) => {
    if (isBusyRef.current) return // duplicate-submission guard
    isBusyRef.current = true
    setIsBusy(true)
    setActiveAction(action)
    setErrorMessage(null)
    try {
      await work()
    } catch (error) {
      setErrorMessage(errorText(error))
    } finally {
      isBusyRef.current = false
      setIsBusy(false)
    }
  }

  const saveDraft = (values: InvoiceFormValues) =>
    run('draft', async () => {
      const saved = await persistDraft(values)
      notify('success', `Draft ${saved.invoiceNumber} saved.`)
      navigate(`/invoices/${saved.id}`)
    })

  const issueNow = (values: InvoiceFormValues) =>
    run('issue', async () => {
      const saved = await persistDraft(values)
      try {
        const issued = await issueInvoice.mutateAsync({
          invoiceId: saved.id,
          version: saved.version,
        })
        notify('success', `Invoice ${issued.invoiceNumber} issued.`)
        navigate(`/invoices/${issued.id}`)
      } catch (error) {
        // The draft is safe. Say so, and keep the form so the problem can be fixed and retried.
        throw new InvoiceServiceError(
          error instanceof InvoiceServiceError ? error.code : 'service_unavailable',
          `${saved.invoiceNumber} was saved as a draft but could not be issued: ${errorText(error)}`,
        )
      } finally {
        setConfirmValues(null)
      }
    })

  const onSaveDraft = () => {
    intent.current = 'draft'
    void handleSubmit(saveDraft)()
  }

  const onIssue = () => {
    intent.current = 'issue'
    // Issuing is validated strictly, then confirmed, because issued invoices cannot be edited.
    void handleSubmit((values) => setConfirmValues(values))()
  }

  const addItem = () => append({ ...EMPTY_ITEM })
  const itemError = (index: number, field: keyof typeof EMPTY_ITEM) =>
    errors.items?.[index]?.[field]?.message

  return (
    <form
      noValidate
      onSubmit={(event) => event.preventDefault()}
      aria-label={invoice ? 'Edit draft invoice' : 'New invoice'}
    >
      <div className="grid grid-cols-1 gap-4 sm:gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-4 sm:space-y-6">
          <Card>
            <CardHeader>
              <CardTitle>Customer</CardTitle>
              <CardDescription>
                Saved on the invoice as written, not linked to a customer record.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="sm:col-span-2">
                <FormField label="Customer name" required error={errors.customerName?.message}>
                  {(field) => <Input autoComplete="off" {...field} {...register('customerName')} />}
                </FormField>
              </div>
              <FormField label="Email" error={errors.customerEmail?.message}>
                {(field) => (
                  <Input
                    type="email"
                    autoComplete="off"
                    {...field}
                    {...register('customerEmail')}
                  />
                )}
              </FormField>
              <FormField label="Phone number" error={errors.customerPhone?.message}>
                {(field) => (
                  <Input type="tel" autoComplete="off" {...field} {...register('customerPhone')} />
                )}
              </FormField>
              <FormField
                label="Customer TIN"
                hint="9 digits, if the customer has one."
                error={errors.customerTin?.message}
              >
                {(field) => (
                  <Input
                    inputMode="numeric"
                    maxLength={9}
                    {...field}
                    {...register('customerTin')}
                  />
                )}
              </FormField>
              <FormField label="Address" error={errors.customerAddress?.message}>
                {(field) => (
                  <Input autoComplete="off" {...field} {...register('customerAddress')} />
                )}
              </FormField>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Branch and cashier</CardTitle>
              <CardDescription>
                Only active branches, and people currently assigned to the branch, can be chosen.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <FormField label="Branch" required error={errors.branchId?.message}>
                {(field) => (
                  <Select {...field} {...register('branchId')}>
                    <option value="">Select a branch</option>
                    {options.branches.map((branch) => (
                      <option key={branch.id} value={branch.id}>
                        {branch.name} ({branch.code})
                      </option>
                    ))}
                  </Select>
                )}
              </FormField>
              <FormField
                label="Assigned cashier"
                required
                hint={fixedAssigneeUserId ? 'Invoices you create are assigned to you.' : undefined}
                error={errors.assignedToUserId?.message}
              >
                {(field) =>
                  fixedAssigneeUserId ? (
                    <>
                      {/* A disabled control would make the form drop the value, so it is read-only text. */}
                      <Input
                        {...field}
                        readOnly
                        aria-readonly="true"
                        value={
                          options.assignees.find((a) => a.userId === fixedAssigneeUserId)
                            ?.fullName ?? ''
                        }
                      />
                      <input type="hidden" {...register('assignedToUserId')} />
                    </>
                  ) : (
                    <Select {...field} {...register('assignedToUserId')}>
                      <option value="">
                        {branchId ? 'Select a cashier' : 'Choose a branch first'}
                      </option>
                      {eligibleAssignees.map((assignee) => (
                        <option key={assignee.userId} value={assignee.userId}>
                          {assignee.fullName}
                        </option>
                      ))}
                    </Select>
                  )
                }
              </FormField>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Line items</CardTitle>
              <CardDescription>
                Amounts are whole RWF. Tax is only added where you choose it.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <FormField label="Prices" required hint={TAX_MODE_HINTS[taxMode]}>
                {(field) => (
                  <Select {...field} {...register('taxMode')}>
                    <option value="EXCLUSIVE">{TAX_MODE_LABELS.EXCLUSIVE}</option>
                    <option value="INCLUSIVE">{TAX_MODE_LABELS.INCLUSIVE}</option>
                  </Select>
                )}
              </FormField>

              {typeof errors.items?.message === 'string' && (
                <p role="alert" className="text-sm font-medium text-danger">
                  {errors.items.message}
                </p>
              )}
              {typeof errors.items?.root?.message === 'string' && (
                <p role="alert" className="text-sm font-medium text-danger">
                  {errors.items.root.message}
                </p>
              )}

              <ol className="space-y-4">
                {fields.map((field, index) => {
                  const lineTotal = preview.items[index]?.lineTotal ?? 0
                  const isCustomRate = items?.[index]?.taxChoice === 'CUSTOM'
                  return (
                    <li key={field.id}>
                      <fieldset className="space-y-3 rounded-lg border p-3 sm:p-4">
                        <legend className="px-1 text-sm font-semibold">Item {index + 1}</legend>
                        <FormField
                          label="Description"
                          required
                          error={itemError(index, 'description')}
                        >
                          {(control) => (
                            <Input {...control} {...register(`items.${index}.description`)} />
                          )}
                        </FormField>
                        <div className="grid gap-3 sm:grid-cols-3">
                          <FormField label="Quantity" required error={itemError(index, 'quantity')}>
                            {(control) => (
                              <Input
                                inputMode="decimal"
                                {...control}
                                {...register(`items.${index}.quantity`)}
                              />
                            )}
                          </FormField>
                          <FormField
                            label="Unit price (RWF)"
                            required
                            error={itemError(index, 'unitPrice')}
                          >
                            {(control) => (
                              <Input
                                inputMode="numeric"
                                {...control}
                                {...register(`items.${index}.unitPrice`)}
                              />
                            )}
                          </FormField>
                          <FormField label="Discount (RWF)" error={itemError(index, 'discount')}>
                            {(control) => (
                              <Input
                                inputMode="numeric"
                                {...control}
                                {...register(`items.${index}.discount`)}
                              />
                            )}
                          </FormField>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-3">
                          <FormField label="Tax" required>
                            {(control) => (
                              <Select {...control} {...register(`items.${index}.taxChoice`)}>
                                {TAX_CHOICE_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                              </Select>
                            )}
                          </FormField>
                          {isCustomRate && (
                            <FormField
                              label="Custom rate (%)"
                              required
                              error={itemError(index, 'customRatePercent')}
                            >
                              {(control) => (
                                <Input
                                  inputMode="decimal"
                                  {...control}
                                  {...register(`items.${index}.customRatePercent`)}
                                />
                              )}
                            </FormField>
                          )}
                          <div className="flex items-end justify-between gap-3 sm:col-start-3">
                            <p className="text-sm">
                              <span className="block text-xs text-muted-foreground">
                                Line total
                              </span>
                              <span className="font-semibold tabular-nums">
                                {formatRwf(lineTotal)}
                              </span>
                            </p>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              onClick={() => remove(index)}
                              disabled={fields.length === 1}
                            >
                              <Trash2 aria-hidden="true" />
                              Remove<span className="sr-only"> item {index + 1}</span>
                            </Button>
                          </div>
                        </div>
                      </fieldset>
                    </li>
                  )
                })}
              </ol>
              <Button type="button" variant="outline" onClick={addItem}>
                <Plus aria-hidden="true" />
                Add item
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Due date and notes</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <FormField label="Due date" required error={errors.dueAt?.message}>
                {(field) => <Input type="date" {...field} {...register('dueAt')} />}
              </FormField>
              <FormField label="Currency">
                {(field) => (
                  <Input {...field} value="RWF (Rwandan franc)" readOnly aria-readonly="true" />
                )}
              </FormField>
              <div className="sm:col-span-2">
                <FormField label="Notes" hint="Shown on the invoice." error={errors.notes?.message}>
                  {(field) => <Textarea {...field} {...register('notes')} />}
                </FormField>
              </div>
            </CardContent>
          </Card>
        </div>

        <aside aria-label="Invoice summary" className="space-y-4 lg:sticky lg:top-20 lg:self-start">
          <Card>
            <CardHeader>
              <CardTitle>Summary</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <InvoiceTotalsBlock totals={preview} taxMode={taxMode} />
              {errorMessage && !confirmValues && (
                <p
                  role="alert"
                  className="rounded-md border border-danger/30 bg-danger-soft px-3 py-2 text-sm text-danger"
                >
                  {errorMessage}
                </p>
              )}
              <div className="flex flex-col gap-2">
                <Button type="button" onClick={onIssue} disabled={isBusy} aria-busy={isBusy}>
                  {isBusy && activeAction === 'issue' ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Send aria-hidden="true" />
                  )}
                  Issue invoice
                </Button>
                <Button
                  type="button"
                  variant="outline"
                  onClick={onSaveDraft}
                  disabled={isBusy}
                  aria-busy={isBusy}
                >
                  {isBusy && activeAction === 'draft' ? (
                    <Loader2 className="animate-spin" aria-hidden="true" />
                  ) : (
                    <Save aria-hidden="true" />
                  )}
                  Save draft
                </Button>
                <Button asChild variant="ghost">
                  <Link to={invoice ? `/invoices/${invoice.id}` : '/invoices'}>Cancel</Link>
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Issuing creates the invoice for the customer. It does not mean it has been paid.
              </p>
            </CardContent>
          </Card>
        </aside>
      </div>

      <ConfirmDialog
        open={confirmValues !== null}
        onOpenChange={(open) => !open && !isBusy && setConfirmValues(null)}
        title="Issue this invoice?"
        description={`Total ${formatRwf(preview.grandTotal)}. Once issued, its amounts and customer details can no longer be edited. It will show as unpaid until a bank-confirmed payment is recorded.`}
        confirmLabel="Issue invoice"
        isPending={isBusy}
        onConfirm={() => confirmValues && void issueNow(getValues())}
      />
    </form>
  )
}
