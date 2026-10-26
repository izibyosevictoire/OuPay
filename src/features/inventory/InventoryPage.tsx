import { Boxes, History, Loader2, Plus, SearchX } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/common/EmptyState'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, Select } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { STOCK_MOVEMENT_LABELS } from '@/constants/inventory'
import { PermissionGuard } from '@/features/auth/permissions/PermissionGuard'
import { usePermission } from '@/features/auth/permissions/usePermission'
import { useCurrentMerchant } from '@/features/merchants/useMerchantQueries'
import { formatDateTime } from '@/lib/format'
import { formatStockChange, formatStockQuantity } from '@/lib/formatStockQuantity'
import { cn } from '@/lib/utils'
import { InventoryServiceError } from '@/services/inventoryService'
import type {
  InventoryBalance,
  InventoryOptions,
  StockMovement,
  StockMovementType,
} from '@/types/inventory'
import { StockEntryDialog } from './StockEntryDialog'
import {
  useBalances,
  useInventoryOptions,
  useMovements,
  useStockableGoods,
} from './inventoryQueries'
import type { StockEntryKind } from './inventorySchemas'

type Tab = 'stock' | 'movements'

function ListSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2, 3].map((index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  )
}

/** The page shell: only a business in business mode has inventory. */
export function InventoryPage() {
  const merchant = useCurrentMerchant()
  if (merchant.isPending) {
    return (
      <div role="status" aria-live="polite">
        <span className="sr-only">Loading</span>
        <ListSkeleton />
      </div>
    )
  }
  if (merchant.data && merchant.data.operatingMode !== 'BUSINESS') {
    return <InventoryUnavailable />
  }
  return <InventoryContent />
}

function InventoryUnavailable() {
  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader title="Inventory" description="Stock of your goods, by branch." />
      <Card className="p-4 sm:p-5">
        <EmptyState
          icon={Boxes}
          title="Inventory is for businesses in business mode"
          description="This business works in simplified mode, which collects amounts only. An owner can change the mode in Settings."
        />
        <p className="pb-4 text-center text-sm">
          <Link to="/collect" className="font-medium text-primary hover:underline">
            Collect a payment
          </Link>
          {' · '}
          <Link to="/settings" className="font-medium text-primary hover:underline">
            Settings
          </Link>
        </p>
      </Card>
    </div>
  )
}

function useDebounced<T>(value: T, delayInMilliseconds: number): T {
  const [debounced, setDebounced] = useState(value)
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayInMilliseconds)
    return () => clearTimeout(timer)
  }, [value, delayInMilliseconds])
  return debounced
}

/** Dialogs are mounted only while open; this puts focus back on what opened one, so a keyboard user keeps their place. */
function useReturnFocus() {
  const returnTo = useRef<HTMLElement | null>(null)
  const remember = useCallback(() => {
    returnTo.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
  }, [])
  const restore = useCallback(
    () =>
      void setTimeout(() => {
        if (returnTo.current?.isConnected) returnTo.current.focus()
      }, 40),
    [],
  )
  return { remember, restore }
}

function InventoryContent() {
  const focus = useReturnFocus()
  const optionsQuery = useInventoryOptions()
  const receive = usePermission('inventory:receive')
  const adjust = usePermission('inventory:adjust')
  const [tab, setTab] = useState<Tab>('stock')
  const [entryKind, setEntryKind] = useState<StockEntryKind | null>(null)

  if (
    optionsQuery.error instanceof InventoryServiceError &&
    optionsQuery.error.code === 'inventory_unavailable'
  ) {
    return <InventoryUnavailable />
  }

  const canWriteSomewhere = optionsQuery.data?.branches.some((branch) => branch.writable) ?? false
  const open = (kind: StockEntryKind) => {
    focus.remember()
    setEntryKind(kind)
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title="Inventory"
        description="How much of each good you hold at each branch, and every movement that changed it."
        actions={
          canWriteSomewhere && (
            <div className="flex flex-wrap justify-end gap-2">
              <PermissionGuard permission="inventory:receive">
                <Button onClick={() => open('RECEIVE')}>
                  <Plus aria-hidden="true" />
                  Receive stock
                </Button>
              </PermissionGuard>
              <PermissionGuard permission="inventory:adjust">
                <Button variant="outline" onClick={() => open('ADJUST')}>
                  Adjust stock
                </Button>
                <Button variant="outline" onClick={() => open('OPENING')}>
                  Record opening stock
                </Button>
              </PermissionGuard>
            </div>
          )
        }
      />
      {optionsQuery.data && (!receive.isAllowed || !adjust.isAllowed || !canWriteSomewhere) && (
        <p role="note" className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          {receive.isAllowed || adjust.isAllowed
            ? 'You can record stock only at active branches you are assigned to.'
            : 'You can view stock. Owners and managers record it.'}
        </p>
      )}

      <QueryBoundary
        query={optionsQuery}
        loadingFallback={<ListSkeleton />}
        errorMessage="Inventory could not be loaded."
      >
        {(options) => (
          <Card className="p-4 sm:p-5">
            <div role="tablist" aria-label="Inventory views" className="mb-4 flex gap-1 border-b">
              <TabButton id="stock" selected={tab === 'stock'} onSelect={() => setTab('stock')}>
                <Boxes className="size-4" aria-hidden="true" /> Stock
              </TabButton>
              <TabButton
                id="movements"
                selected={tab === 'movements'}
                onSelect={() => setTab('movements')}
              >
                <History className="size-4" aria-hidden="true" /> Movements
              </TabButton>
            </div>
            <div
              role="tabpanel"
              id={`inventory-panel-${tab}`}
              aria-labelledby={`inventory-tab-${tab}`}
            >
              {tab === 'stock' ? (
                <StockTab options={options} />
              ) : (
                <MovementsTab options={options} />
              )}
            </div>
          </Card>
        )}
      </QueryBoundary>

      {entryKind && optionsQuery.data && (
        <StockEntryDialog
          kind={entryKind}
          open
          options={optionsQuery.data}
          onOpenChange={(isOpen) => {
            if (isOpen) return
            setEntryKind(null)
            focus.restore()
          }}
        />
      )}
    </div>
  )
}

function TabButton({
  id,
  selected,
  onSelect,
  children,
}: {
  id: Tab
  selected: boolean
  onSelect: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      role="tab"
      id={`inventory-tab-${id}`}
      aria-selected={selected}
      aria-controls={`inventory-panel-${id}`}
      onClick={onSelect}
      className={cn(
        '-mb-px inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium',
        selected
          ? 'border-primary text-primary'
          : 'border-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function BranchFilter({
  options,
  value,
  onChange,
}: {
  options: InventoryOptions
  value: string
  onChange: (value: string) => void
}) {
  return (
    <Select
      aria-label="Filter by branch"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      <option value="">All branches</option>
      {options.branches.map((branch) => (
        <option key={branch.id} value={branch.id}>
          {branch.name}
        </option>
      ))}
    </Select>
  )
}

function LoadMore({
  hasNextPage,
  isFetching,
  onClick,
}: {
  hasNextPage: boolean
  isFetching: boolean
  onClick: () => void
}) {
  if (!hasNextPage) return null
  return (
    <div className="mt-4 flex justify-center">
      <Button variant="outline" onClick={onClick} disabled={isFetching}>
        {isFetching && <Loader2 className="animate-spin" aria-hidden="true" />}
        Load more
      </Button>
    </div>
  )
}

// ---- Stock -----------------------------------------------------------------------------------------------------

function StockTab({ options }: { options: InventoryOptions }) {
  const [search, setSearch] = useState('')
  const [branchId, setBranchId] = useState('')
  const term = useDebounced(search.trim(), 250)
  const filters = useMemo(
    () => ({ q: term || undefined, branchId: branchId || undefined }),
    [term, branchId],
  )
  const query = useBalances(filters)
  const isFiltered = Boolean(filters.q || filters.branchId)

  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_14rem]">
        <Input
          type="search"
          aria-label="Search stock"
          placeholder="Search by item name or code"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <BranchFilter options={options} value={branchId} onChange={setBranchId} />
      </div>
      <QueryBoundary
        query={query}
        loadingFallback={<ListSkeleton />}
        errorMessage="The stock could not be loaded."
      >
        {(data) => {
          const rows = data.pages.flatMap((page) => page.items)
          if (rows.length === 0) {
            return isFiltered ? (
              <EmptyState
                icon={SearchX}
                title="No stock matches"
                description="Try a different search or branch."
              />
            ) : (
              <EmptyState
                icon={Boxes}
                title="No stock recorded yet"
                description="Record opening stock or receive goods to see them here."
              />
            )
          }
          return (
            <>
              <BalanceList rows={rows} />
              <LoadMore
                hasNextPage={Boolean(query.hasNextPage)}
                isFetching={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              />
            </>
          )
        }}
      </QueryBoundary>
    </>
  )
}

function BalanceList({ rows }: { rows: InventoryBalance[] }) {
  const inSaleUnit = (row: InventoryBalance) =>
    row.saleUnit === row.stockUnit
      ? null
      : formatStockQuantity(row.quantityInSaleUnit, row.saleUnit)
  return (
    <>
      {/* Phones: stacked cards instead of a wide table. */}
      <ul className="divide-y md:hidden" aria-label="Stock by branch">
        {rows.map((row) => (
          <li key={row.id} className="space-y-1 py-3">
            <p className="font-medium">{row.itemName}</p>
            <p className="text-xs text-muted-foreground">
              {row.itemCode ? `${row.itemCode} · ` : ''}
              {row.branchName}
            </p>
            <p className="text-sm tabular-nums">
              {formatStockQuantity(row.quantityOnHand, row.stockUnit)}
              {inSaleUnit(row) && (
                <span className="text-muted-foreground"> ({inSaleUnit(row)})</span>
              )}
            </p>
          </li>
        ))}
      </ul>

      <table className="hidden w-full text-left md:table">
        <caption className="sr-only">Stock by branch</caption>
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th scope="col" className="pb-2 font-medium">
              Item
            </th>
            <th scope="col" className="pb-2 font-medium">
              Code
            </th>
            <th scope="col" className="pb-2 font-medium">
              Branch
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              In stock
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              In selling unit
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr key={row.id}>
              <th scope="row" className="py-3 pr-2 font-medium">
                {row.itemName}
              </th>
              <td className="py-3 font-mono text-xs">{row.itemCode ?? '—'}</td>
              <td className="py-3 text-muted-foreground">{row.branchName}</td>
              <td className="py-3 text-right tabular-nums">
                {formatStockQuantity(row.quantityOnHand, row.stockUnit)}
              </td>
              <td className="py-3 text-right tabular-nums text-muted-foreground">
                {row.saleUnit === row.stockUnit
                  ? '—'
                  : formatStockQuantity(row.quantityInSaleUnit, row.saleUnit)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}

// ---- Movements -------------------------------------------------------------------------------------------------

const MOVEMENT_TONE: Record<StockMovementType, string> = {
  OPENING: 'bg-info-soft text-info',
  RECEIVE: 'bg-success-soft text-success',
  ADJUST_IN: 'bg-success-soft text-success',
  ADJUST_OUT: 'bg-warning-soft text-warning',
}

function MovementBadge({ type }: { type: StockMovementType }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
        MOVEMENT_TONE[type],
      )}
    >
      {STOCK_MOVEMENT_LABELS[type]}
    </span>
  )
}

function MovementsTab({ options }: { options: InventoryOptions }) {
  const goods = useStockableGoods()
  const [branchId, setBranchId] = useState('')
  const [itemId, setItemId] = useState('')
  const [type, setType] = useState<StockMovementType | ''>('')
  const filters = useMemo(
    () => ({
      branchId: branchId || undefined,
      itemId: itemId || undefined,
      type: type || undefined,
    }),
    [branchId, itemId, type],
  )
  const query = useMovements(filters)
  const isFiltered = Boolean(filters.branchId || filters.itemId || filters.type)

  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <BranchFilter options={options} value={branchId} onChange={setBranchId} />
        <Select
          aria-label="Filter by item"
          value={itemId}
          onChange={(event) => setItemId(event.target.value)}
        >
          <option value="">All items</option>
          {(goods.data ?? []).map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by type"
          value={type}
          onChange={(event) => setType(event.target.value as StockMovementType | '')}
        >
          <option value="">All types</option>
          {(Object.keys(STOCK_MOVEMENT_LABELS) as StockMovementType[]).map((key) => (
            <option key={key} value={key}>
              {STOCK_MOVEMENT_LABELS[key]}
            </option>
          ))}
        </Select>
      </div>
      <QueryBoundary
        query={query}
        loadingFallback={<ListSkeleton />}
        errorMessage="The stock history could not be loaded."
      >
        {(data) => {
          const rows = data.pages.flatMap((page) => page.items)
          if (rows.length === 0) {
            return isFiltered ? (
              <EmptyState
                icon={SearchX}
                title="No movements match"
                description="Try different filters."
              />
            ) : (
              <EmptyState
                icon={History}
                title="No stock movements yet"
                description="Every receipt and adjustment will be listed here."
              />
            )
          }
          return (
            <>
              <MovementList rows={rows} />
              <LoadMore
                hasNextPage={Boolean(query.hasNextPage)}
                isFetching={query.isFetchingNextPage}
                onClick={() => void query.fetchNextPage()}
              />
            </>
          )
        }}
      </QueryBoundary>
    </>
  )
}

const detailsOf = (row: StockMovement) =>
  [
    row.enteredAs && `Entered as ${row.enteredAs}`,
    row.reason,
    row.reference && `Ref ${row.reference}`,
  ]
    .filter(Boolean)
    .join(' · ')

function MovementList({ rows }: { rows: StockMovement[] }) {
  return (
    <>
      <ul className="divide-y md:hidden" aria-label="Stock movements">
        {rows.map((row) => (
          <li key={row.id} className="space-y-1 py-3">
            <div className="flex items-center justify-between gap-2">
              <p className="font-medium">{row.itemName}</p>
              <MovementBadge type={row.movementType} />
            </div>
            <p className="text-sm tabular-nums">
              {formatStockChange(row.quantityDelta, row.stockUnit)}
              <span className="text-muted-foreground">
                {' '}
                → {formatStockQuantity(row.balanceAfter, row.stockUnit)}
              </span>
            </p>
            <p className="text-xs text-muted-foreground">
              {row.branchName} · {row.actorName} · {formatDateTime(row.createdAt)}
            </p>
            {detailsOf(row) && <p className="text-xs text-muted-foreground">{detailsOf(row)}</p>}
          </li>
        ))}
      </ul>

      <table className="hidden w-full text-left md:table">
        <caption className="sr-only">Stock movements</caption>
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th scope="col" className="pb-2 font-medium">
              When
            </th>
            <th scope="col" className="pb-2 font-medium">
              Type
            </th>
            <th scope="col" className="pb-2 font-medium">
              Item
            </th>
            <th scope="col" className="pb-2 font-medium">
              Branch
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              Change
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              Balance after
            </th>
            <th scope="col" className="pb-2 pl-4 font-medium">
              Details
            </th>
            <th scope="col" className="pb-2 font-medium">
              By
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((row) => (
            <tr key={row.id}>
              <td className="py-3 pr-2 text-xs text-muted-foreground">
                {formatDateTime(row.createdAt)}
              </td>
              <td className="py-3">
                <MovementBadge type={row.movementType} />
              </td>
              <th scope="row" className="py-3 pr-2 font-medium">
                {row.itemName}
              </th>
              <td className="py-3 text-muted-foreground">{row.branchName}</td>
              <td className="py-3 text-right tabular-nums">
                {formatStockChange(row.quantityDelta, row.stockUnit)}
              </td>
              <td className="py-3 text-right tabular-nums">
                {formatStockQuantity(row.balanceAfter, row.stockUnit)}
              </td>
              <td className="py-3 pl-4 text-xs text-muted-foreground">{detailsOf(row) || '—'}</td>
              <td className="py-3 text-muted-foreground">{row.actorName}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
