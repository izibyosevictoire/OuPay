import { Loader2, Plus, Trash2 } from 'lucide-react'
import { useDeferredValue, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { FormField } from '@/components/common/FormField'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input, Select } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useAuth } from '@/app/providers/AuthProvider'
import { PermissionGuard } from '@/features/auth/permissions/PermissionGuard'
import { useSelectedMerchantId } from '@/features/branches/useBranchQueries'
import { formatDateTime, formatRwf } from '@/lib/format'
import { PosServiceError } from '@/services/posService'
import { posService } from '@/services'
import type {
  PosCatalogItem,
  PosDraft,
  PosDraftSummary,
  PosOptions,
  PosPricedLine,
  PosProblem,
} from '@/types/pos'
import {
  useCreatePosDraft,
  useDiscardPosDraft,
  usePosDrafts,
  usePosItems,
  usePosOptions,
  usePosQuote,
  useUpdatePosDraft,
} from './posQueries'
import {
  acceptCurrentPrice,
  defaultChoice,
  describeStockCheck,
  describeStockInfo,
  packageChoice,
  payloadKeyOf,
  pricedLineFor,
  quantityProblem,
  toLineInput,
  unitSymbol,
  UNIT_NAMES,
  type CartLine,
  type StockDescription,
} from './posRules'
import { PosBillingReview, PosSalePanel } from './PosBilling'
import { FulfilmentExceptionsCard } from './PosFulfilment'
import { attemptFor, forgetAttempt, forgetSaleId, loadSaleId, rememberSaleId } from './posSession'

const linkClass = 'font-medium text-primary hover:underline'

const TONE_CLASS: Record<StockDescription['tone'], string> = {
  ok: 'text-success',
  warning: 'text-warning-foreground',
  neutral: 'text-muted-foreground',
}

/** Stock is shown with words, not only colour. It is informational: nothing is reserved or deducted. */
function StockBadge({ description }: { description: StockDescription }) {
  return (
    <span className={`text-xs font-medium ${TONE_CLASS[description.tone]}`}>
      {description.tone === 'warning' && <span aria-hidden="true">⚠ </span>}
      {description.text}
    </span>
  )
}

function SetupRequired({ options }: { options: PosOptions }) {
  const notBusiness = options.readiness === 'NOT_BUSINESS'
  return (
    <Card>
      <CardContent className="space-y-3 p-4 text-sm sm:p-6">
        <h2 className="text-base font-semibold">
          {notBusiness ? 'POS billing is for business mode' : 'You need a branch to prepare sales'}
        </h2>
        {notBusiness ? (
          <>
            <p>
              This business bills by amount only, so there is no catalog cart. Use Collect Payment
              instead.
            </p>
            <p>
              <Link to="/collect" className={linkClass}>
                Collect a payment
              </Link>
              . An owner can change the business mode in{' '}
              <Link to="/settings" className={linkClass}>
                Settings
              </Link>
              .
            </p>
          </>
        ) : (
          <>
            <p>
              Sales are prepared at a branch, by someone assigned to it, and you are not assigned to
              an active branch yet. Nothing is created for you automatically.
            </p>
            <PermissionGuard
              permission="branches:manage"
              fallback={<p>Ask your manager or the business owner to assign you to a branch.</p>}
            >
              <p>
                <Link to="/branches" className={linkClass}>
                  Review branches
                </Link>
                , then{' '}
                <Link to="/cashiers" className={linkClass}>
                  assign yourself to one
                </Link>
                .
              </p>
            </PermissionGuard>
          </>
        )}
      </CardContent>
    </Card>
  )
}

/** What a failed save means for the cashier, in plain words. */
function failureMessage(error: unknown): string {
  if (error instanceof PosServiceError) {
    if (error.code === 'service_unavailable') {
      return 'We could not confirm whether the draft was saved. Press Save draft again: the same cart is never saved twice.'
    }
    return error.message
  }
  return 'The draft could not be saved. Please try again.'
}

function ItemPicker({
  branchId,
  disabled,
  onAdd,
}: {
  branchId: string
  disabled: boolean
  onAdd: (item: PosCatalogItem) => void
}) {
  const [search, setSearch] = useState('')
  const deferred = useDeferredValue(search.trim())
  const items = usePosItems(branchId, deferred)

  return (
    <section aria-labelledby="pos-items-heading" className="space-y-3">
      <h2 id="pos-items-heading" className="text-base font-semibold">
        Goods and services
      </h2>
      <FormField label="Search goods and services" hint="By name or code.">
        {(control) => (
          <Input
            {...control}
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search by name or code"
          />
        )}
      </FormField>
      <QueryBoundary
        query={items}
        loadingFallback={<Skeleton className="h-40 w-full" />}
        errorMessage="The catalog could not be loaded."
      >
        {(data) =>
          data.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {deferred ? 'No active item matches that search.' : 'There are no active items yet.'}{' '}
              <PermissionGuard permission="catalog:view">
                <Link to="/catalog" className={linkClass}>
                  Open the catalog
                </Link>
              </PermissionGuard>
            </p>
          ) : (
            <ul aria-label="Catalog items" className="divide-y rounded-lg border">
              {data.map((item) => (
                <li key={item.itemId} className="flex items-center justify-between gap-3 p-3">
                  <div className="min-w-0 space-y-0.5">
                    <p className="truncate text-sm font-medium">
                      {item.name}
                      {item.code && (
                        <span className="font-normal text-muted-foreground"> · {item.code}</span>
                      )}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {formatRwf(item.pricePerSaleUnitRwf)} per {unitSymbol(item.saleUnit)}
                    </p>
                    <StockBadge description={describeStockInfo(item.stock)} />
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={disabled}
                    onClick={() => onAdd(item)}
                    aria-label={`Add ${item.name} to the cart`}
                  >
                    <Plus aria-hidden="true" />
                    Add
                  </Button>
                </li>
              ))}
            </ul>
          )
        }
      </QueryBoundary>
    </section>
  )
}

function CartLineRow({
  line,
  priced,
  problem,
  showErrors,
  onChange,
  onRemove,
}: {
  line: CartLine
  priced: PosPricedLine | undefined
  problem: PosProblem | undefined
  showErrors: boolean
  onChange: (line: CartLine) => void
  onRemove: () => void
}) {
  const local = quantityProblem(line)
  const quantityError = showErrors || line.quantity !== '' ? local : null
  const stock = priced?.stock
    ? describeStockCheck(priced.stock)
    : describeStockInfo(line.item.stock)
  return (
    <li className="space-y-3 p-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{line.item.name}</p>
          <p className="text-xs text-muted-foreground">
            {formatRwf(line.item.pricePerSaleUnitRwf)} per {unitSymbol(line.item.saleUnit)} (price
            version {line.item.priceVersion})
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={onRemove}
          aria-label={`Remove ${line.item.name} from the cart`}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField
          label={`Quantity of ${line.item.name}`}
          required
          error={quantityError ?? undefined}
        >
          {(control) => (
            <Input
              {...control}
              inputMode="decimal"
              autoComplete="off"
              value={line.quantity}
              onChange={(event) => onChange({ ...line, quantity: event.target.value })}
            />
          )}
        </FormField>
        <FormField label={`Unit for ${line.item.name}`} required>
          {(control) => (
            <Select
              {...control}
              value={line.choice}
              onChange={(event) => onChange({ ...line, choice: event.target.value })}
            >
              {line.item.units.map((unit) => (
                <option key={unit} value={unit}>
                  {UNIT_NAMES[unit]} ({unitSymbol(unit)})
                </option>
              ))}
              {line.item.packages.map((pack) => (
                <option key={pack.id} value={packageChoice(pack.id)}>
                  {pack.label} ({pack.quantityInSaleUnit} {unitSymbol(line.item.saleUnit)})
                </option>
              ))}
            </Select>
          )}
        </FormField>
      </div>
      {problem && (
        <div
          role="alert"
          className="space-y-2 rounded-md bg-danger-soft px-3 py-2 text-sm text-danger"
        >
          <p>{problem.message}</p>
          {problem.code === 'price_changed' && problem.currentPriceRwf !== null && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => onChange(acceptCurrentPrice(line, problem))}
            >
              Use the new price ({formatRwf(problem.currentPriceRwf)})
            </Button>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
        <StockBadge description={stock} />
        {priced && (
          <span className="font-medium">
            {priced.quantityInSaleUnit} {unitSymbol(priced.saleUnit)} ×{' '}
            {formatRwf(priced.unitPriceRwf)} = {formatRwf(priced.lineTotalRwf)}
          </span>
        )}
      </div>
    </li>
  )
}

function DraftsList({
  onOpen,
  openingId,
}: {
  onOpen: (summary: PosDraftSummary) => void
  openingId: string | null
}) {
  const { user } = useAuth()
  const drafts = usePosDrafts()
  const discard = useDiscardPosDraft()
  const [error, setError] = useState<string | null>(null)
  return (
    <section aria-labelledby="pos-drafts-heading" className="space-y-3">
      <h2 id="pos-drafts-heading" className="text-base font-semibold">
        Saved drafts
      </h2>
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <QueryBoundary
        query={drafts}
        loadingFallback={<Skeleton className="h-24 w-full" />}
        errorMessage="Saved drafts could not be loaded."
      >
        {(page) => {
          const open = page.items.filter((d) => d.status === 'DRAFT')
          if (open.length === 0) {
            return <p className="text-sm text-muted-foreground">No saved drafts yet.</p>
          }
          return (
            <ul aria-label="Saved drafts" className="divide-y rounded-lg border">
              {open.map((draft) => {
                const own = draft.createdByName === user?.fullName
                return (
                  <li
                    key={draft.id}
                    className="flex flex-wrap items-center justify-between gap-3 p-3"
                  >
                    <div className="min-w-0 text-sm">
                      <p className="font-medium">
                        {draft.lineCount} {draft.lineCount === 1 ? 'line' : 'lines'} ·{' '}
                        {formatRwf(draft.totalRwf)}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {draft.branchName} · {draft.createdByName} ·{' '}
                        {formatDateTime(draft.updatedAt)}
                      </p>
                    </div>
                    {own && (
                      <div className="flex gap-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={openingId !== null}
                          onClick={() => onOpen(draft)}
                        >
                          {openingId === draft.id && (
                            <Loader2 className="animate-spin" aria-hidden="true" />
                          )}
                          Open draft
                        </Button>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          disabled={discard.isPending}
                          onClick={() => {
                            setError(null)
                            discard.mutate(
                              { draftId: draft.id, expectedVersion: draft.version },
                              { onError: (e) => setError(failureMessage(e)) },
                            )
                          }}
                        >
                          Discard
                        </Button>
                      </div>
                    )}
                  </li>
                )
              })}
            </ul>
          )
        }}
      </QueryBoundary>
    </section>
  )
}

interface Editing {
  id: string
  version: number
}

function PosCart({ scope, options }: { scope: string; options: PosOptions }) {
  const merchantId = useSelectedMerchantId()
  const create = useCreatePosDraft()
  const update = useUpdatePosDraft()
  const inFlight = useRef(false)
  const nextKey = useRef(1)
  const [branchId, setBranchId] = useState(options.branches[0]?.id ?? '')
  const [lines, setLines] = useState<CartLine[]>([])
  const [note, setNote] = useState('')
  const [editing, setEditing] = useState<Editing | null>(null)
  const [showErrors, setShowErrors] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [saved, setSaved] = useState<PosDraft | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [openingId, setOpeningId] = useState<string | null>(null)
  // The cart on screen is exactly the saved draft (saved or reopened, and not changed since): only then can it be reviewed and billed.
  const [clean, setClean] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [saleId, setSaleId] = useState<string | null>(() => loadSaleId(scope))
  const markDirty = () => {
    setSaved(null)
    setClean(false)
  }

  const inputs = lines.map(toLineInput)
  const allValid = lines.length > 0 && lines.every((l) => quantityProblem(l) === null)
  const quote = usePosQuote(branchId, inputs, allValid)
  const quoteData = quote.data
  const priceable = allValid && quoteData !== undefined && !quote.isPlaceholderData
  const problems = priceable ? quoteData.problems : []
  const canSave = priceable && problems.length === 0 && !create.isPending && !update.isPending

  const addItem = (item: PosCatalogItem) => {
    markDirty()
    setFailure(null)
    setNotice(null)
    setLines((current) =>
      current.length >= options.maxLines
        ? current
        : [
            ...current,
            { key: `line-${nextKey.current++}`, item, quantity: '1', choice: defaultChoice(item) },
          ],
    )
  }

  const changeLine = (key: string, next: CartLine) => {
    markDirty()
    setFailure(null)
    setLines((current) => current.map((l) => (l.key === key ? next : l)))
  }

  const reset = () => {
    setLines([])
    setNote('')
    setEditing(null)
    markDirty()
    setFailure(null)
    setNotice(null)
    setShowErrors(false)
  }

  const submit = async () => {
    if (inFlight.current) return
    setShowErrors(true)
    setFailure(null)
    if (!canSave) return
    inFlight.current = true
    try {
      const draft = editing
        ? await update.mutateAsync({
            draftId: editing.id,
            expectedVersion: editing.version,
            note: note.trim() || undefined,
            lines: inputs,
          })
        : await create.mutateAsync({
            ...attemptFor(scope, payloadKeyOf(branchId, note, inputs)),
            branchId,
            note: note.trim() || undefined,
            lines: inputs,
          })
      forgetAttempt(scope)
      setSaved(draft)
      setClean(true)
      setEditing({ id: draft.id, version: draft.version })
      setNotice(null)
    } catch (error) {
      setFailure(failureMessage(error))
    } finally {
      inFlight.current = false
    }
  }

  /** Reopens a saved draft into the cart, at today's prices. Items no longer for sale are left out, and the cashier is told. */
  const openDraft = async (summary: PosDraftSummary) => {
    setOpeningId(summary.id)
    setFailure(null)
    try {
      const draft = await posService.getPosDraft(merchantId, summary.id)
      const found = new Map<string, PosCatalogItem>()
      for (const line of draft.lines) {
        if (found.has(line.itemId)) continue
        const matches = await posService.searchPosItems(
          merchantId,
          draft.branchId,
          line.code ?? line.name,
        )
        const match = matches.find((m) => m.itemId === line.itemId)
        if (match) found.set(line.itemId, match)
      }
      const reopened: CartLine[] = []
      let dropped = 0
      let repriced = 0
      for (const line of draft.lines) {
        const item = found.get(line.itemId)
        if (!item) {
          dropped += 1
          continue
        }
        if (item.priceVersion !== line.priceVersion) repriced += 1
        reopened.push({
          key: `line-${nextKey.current++}`,
          item,
          quantity: line.enteredQuantity,
          choice: line.packageId
            ? packageChoice(line.packageId)
            : (line.enteredUnit ?? item.saleUnit),
        })
      }
      setBranchId(draft.branchId)
      setLines(reopened)
      setNote(draft.note ?? '')
      setEditing({ id: draft.id, version: draft.version })
      markDirty()
      setShowErrors(false)
      const messages: string[] = []
      if (repriced > 0) messages.push('Prices were updated to the current catalog prices.')
      if (dropped > 0) {
        messages.push(
          `${dropped} ${dropped === 1 ? 'line' : 'lines'} could not be reopened because the item is no longer for sale.`,
        )
      }
      setClean(dropped === 0)
      setNotice(messages.length > 0 ? messages.join(' ') : null)
    } catch (error) {
      setFailure(failureMessage(error))
    } finally {
      setOpeningId(null)
    }
  }

  const branchName = options.branches.find((b) => b.id === branchId)?.name ?? ''
  const busy = create.isPending || update.isPending

  const startNewSale = () => {
    forgetSaleId(scope)
    setSaleId(null)
    setReviewing(false)
    reset()
  }
  if (saleId) {
    return <PosSalePanel saleId={saleId} onNewSale={startNewSale} onGone={startNewSale} />
  }
  if (reviewing && editing) {
    return (
      <PosBillingReview
        scope={scope}
        draftId={editing.id}
        onBack={() => setReviewing(false)}
        onBilled={(id) => {
          rememberSaleId(scope, id)
          setSaleId(id)
          setReviewing(false)
        }}
      />
    )
  }

  return (
    <div className="space-y-4">
      <div
        role="note"
        className="rounded-lg border border-info/20 bg-info-soft px-3 py-2 text-xs text-info"
      >
        <p>
          <strong className="font-semibold">A draft is not a sale.</strong> Saving it creates no
          invoice and no payment request, and it does not reserve or deduct stock.{' '}
          {options.stockNote}
        </p>
      </div>

      {options.branches.length > 1 ? (
        <div className="max-w-xs">
          <FormField label="Branch" required>
            {(control) => (
              <Select
                {...control}
                value={branchId}
                onChange={(event) => {
                  setBranchId(event.target.value)
                  setEditing(null)
                  markDirty()
                }}
              >
                {options.branches.map((branch) => (
                  <option key={branch.id} value={branch.id}>
                    {branch.name}
                  </option>
                ))}
              </Select>
            )}
          </FormField>
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">
          Branch: <span className="font-medium text-foreground">{branchName}</span>
        </p>
      )}

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
        <Card>
          <CardContent className="p-4 sm:p-6">
            <ItemPicker
              branchId={branchId}
              disabled={lines.length >= options.maxLines}
              onAdd={addItem}
            />
          </CardContent>
        </Card>

        <Card>
          <CardContent className="space-y-4 p-4 sm:p-6">
            <section aria-labelledby="pos-cart-heading" className="space-y-3">
              <h2 id="pos-cart-heading" className="text-base font-semibold">
                Cart{editing ? ' (saved draft)' : ''}
              </h2>
              {notice && (
                <p role="status" className="text-sm text-muted-foreground">
                  {notice}
                </p>
              )}
              {lines.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  The cart is empty. Add goods or services from the list.
                </p>
              ) : (
                <ul aria-label="Cart lines" className="divide-y rounded-lg border">
                  {lines.map((line, index) => (
                    <CartLineRow
                      key={line.key}
                      line={line}
                      priced={
                        priceable
                          ? pricedLineFor(quoteData.lines, quoteData.problems, index)
                          : undefined
                      }
                      problem={problems.find((p) => p.lineIndex === index)}
                      showErrors={showErrors}
                      onChange={(next) => changeLine(line.key, next)}
                      onRemove={() => {
                        markDirty()
                        setLines((current) => current.filter((l) => l.key !== line.key))
                      }}
                    />
                  ))}
                </ul>
              )}
              {quote.isError && (
                <p role="alert" className="text-sm text-danger">
                  {failureMessage(quote.error)}
                </p>
              )}
            </section>

            <div className="flex items-baseline justify-between border-t pt-3">
              <span className="text-sm font-medium">Provisional total</span>
              <span className="text-lg font-semibold" aria-live="polite">
                {priceable && problems.length === 0 ? formatRwf(quoteData.totalRwf) : '—'}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {priceable
                ? quoteData.taxNote
                : 'Provisional total: tax is not calculated or included.'}
            </p>

            <FormField label="Note" hint="Up to 200 characters.">
              {(control) => (
                <Input
                  {...control}
                  value={note}
                  maxLength={200}
                  onChange={(event) => {
                    markDirty()
                    setNote(event.target.value)
                  }}
                />
              )}
            </FormField>

            {failure && (
              <p role="alert" className="text-sm text-danger">
                {failure}
              </p>
            )}
            {saved && (
              <div
                role="status"
                className="rounded-md bg-success-soft px-3 py-2 text-sm text-success"
              >
                <p className="font-medium">
                  Draft saved: {formatRwf(saved.totalRwf)} (provisional, tax not included) at{' '}
                  {saved.branchName}.
                </p>
                <p>{saved.notice}</p>
                <p>{saved.taxNote}</p>
              </div>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                onClick={() => void submit()}
                disabled={busy || lines.length === 0}
              >
                {busy && <Loader2 className="animate-spin" aria-hidden="true" />}
                {editing ? 'Save changes' : 'Save draft'}
              </Button>
              {clean && editing && (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={() => setReviewing(true)}
                  disabled={busy}
                >
                  Review and bill
                </Button>
              )}
              <Button type="button" variant="outline" onClick={reset} disabled={busy}>
                Start a new cart
              </Button>
            </div>
            <p className="text-xs text-muted-foreground">
              Billing re-reads prices, tax and stock, and reserves the goods. It does not sell or
              deduct them, and nothing is paid until the bank confirms it.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardContent className="p-4 sm:p-6">
          <DraftsList onOpen={(d) => void openDraft(d)} openingId={openingId} />
        </CardContent>
      </Card>
    </div>
  )
}

function PosBody({ scope }: { scope: string }) {
  const options = usePosOptions()
  return (
    <QueryBoundary
      query={options}
      loadingFallback={<Skeleton className="h-72 w-full" />}
      errorMessage="POS billing could not be loaded."
    >
      {(data): ReactNode => (
        <div className="space-y-4">
          {data.readiness === 'READY' ? (
            <PosCart scope={scope} options={data} />
          ) : (
            <SetupRequired options={data} />
          )}
          {/* Owners see the paid sales that need a decision, whether or not they bill themselves. */}
          {data.readiness !== 'NOT_BUSINESS' && (
            <PermissionGuard permission="invoices:void">
              <FulfilmentExceptionsCard />
            </PermissionGuard>
          )}
        </div>
      )}
    </QueryBoundary>
  )
}

export function PosPage() {
  const merchantId = useSelectedMerchantId()
  const { user } = useAuth()
  // A remembered attempt belongs to one person in one business.
  const scope = `${merchantId}.${user?.id ?? 'anonymous'}`
  return (
    <div className="mx-auto max-w-6xl space-y-4">
      <PageHeader
        title="POS billing"
        description="Build a cart of goods and services at current catalog prices and save it as a draft."
      />
      {/* Keyed by business and person: switching either never shows another's cart. */}
      <PosBody key={scope} scope={scope} />
    </div>
  )
}
