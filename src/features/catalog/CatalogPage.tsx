import {
  Loader2,
  MoreHorizontal,
  Package,
  Pencil,
  Plus,
  Power,
  PowerOff,
  SearchX,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { EmptyState } from '@/components/common/EmptyState'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { BranchStatusBadge } from '@/components/common/StatusBadge'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input, Select } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { CATALOG_ITEM_TYPE_LABELS, unitSymbol } from '@/constants/catalog'
import { PermissionGuard } from '@/features/auth/permissions/PermissionGuard'
import { usePermission } from '@/features/auth/permissions/usePermission'
import { useCurrentMerchant } from '@/features/merchants/useMerchantQueries'
import { formatRwf } from '@/lib/format'
import { CatalogServiceError } from '@/services/catalogService'
import type { CatalogItem, CatalogItemType } from '@/types/catalog'
import { CatalogItemDetailsDialog } from './CatalogItemDetailsDialog'
import { CatalogItemFormDialog } from './CatalogItemFormDialog'
import { CatalogStatusDialog } from './CatalogStatusDialog'
import { useCatalogItems } from './catalogQueries'

type TypeFilter = 'ALL' | CatalogItemType
type StatusFilter = 'ALL' | 'ACTIVE' | 'INACTIVE'

const priceText = (item: CatalogItem) =>
  `${formatRwf(item.pricePerSaleUnitRwf)} / ${item.itemType === 'GOODS' ? unitSymbol(item.saleUnit) : 'service'}`

function CatalogSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2, 3].map((index) => (
        <Skeleton key={index} className="h-12 w-full" />
      ))}
    </div>
  )
}

/** The page shell: only a business in business mode has a catalog. */
export function CatalogPage() {
  const merchant = useCurrentMerchant()
  if (merchant.isPending) {
    return (
      <div role="status" aria-live="polite">
        <span className="sr-only">Loading</span>
        <CatalogSkeleton />
      </div>
    )
  }
  if (merchant.data && merchant.data.operatingMode !== 'BUSINESS') {
    return <CatalogUnavailable />
  }
  return <CatalogContent />
}

function CatalogUnavailable() {
  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader title="Catalog" description="The goods and services your business sells." />
      <Card className="p-4 sm:p-5">
        <EmptyState
          icon={Package}
          title="The catalog is for businesses in business mode"
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

/**
 * The dialogs are mounted only while open, so the browser would drop focus on the page when one closes. This remembers
 * what opened the dialog and puts focus back there, so a keyboard or screen-reader user keeps their place.
 */
function useReturnFocus() {
  const returnTo = useRef<() => void>(() => {})
  const remember = useCallback((rowActionLabel?: string) => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    returnTo.current = rowActionLabel
      ? () => {
          for (const button of document.querySelectorAll<HTMLElement>('button')) {
            if (button.getAttribute('aria-label') !== rowActionLabel) continue
            button.focus()
            if (document.activeElement === button) return
          }
        }
      : () => {
          if (opener?.isConnected) opener.focus()
        }
  }, [])
  // After the dialog's own focus handling has finished.
  const restore = useCallback(() => void setTimeout(() => returnTo.current(), 40), [])
  return { remember, restore }
}

function CatalogContent() {
  const focus = useReturnFocus()
  const { isAllowed: canManage } = usePermission('catalog:manage')
  const [search, setSearch] = useState('')
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL')
  const [formTarget, setFormTarget] = useState<{ item?: CatalogItem } | null>(null)
  const [statusTarget, setStatusTarget] = useState<CatalogItem | null>(null)
  const [detailsId, setDetailsId] = useState<string | null>(null)

  const term = useDebounced(search.trim(), 250)
  const filters = useMemo(
    () => ({
      q: term || undefined,
      type: typeFilter === 'ALL' ? undefined : typeFilter,
      active: statusFilter === 'ALL' ? undefined : statusFilter === 'ACTIVE',
    }),
    [term, typeFilter, statusFilter],
  )
  const itemsQuery = useCatalogItems(filters)
  const isFiltered = Boolean(filters.q || filters.type || filters.active !== undefined)

  const unavailable =
    itemsQuery.error instanceof CatalogServiceError &&
    itemsQuery.error.code === 'catalog_unavailable'
  if (unavailable) return <CatalogUnavailable />

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title="Catalog"
        description="The goods and services your business sells, with their selling units and prices."
        actions={
          <PermissionGuard permission="catalog:manage">
            <Button
              onClick={() => {
                focus.remember()
                setFormTarget({})
              }}
            >
              <Plus aria-hidden="true" />
              Add item
            </Button>
          </PermissionGuard>
        }
      />
      {!canManage && (
        <p role="note" className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
          You can view the catalog. Owners and managers can change it.
        </p>
      )}

      <Card className="p-4 sm:p-5">
        <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_10rem_10rem]">
          <Input
            type="search"
            aria-label="Search catalog"
            placeholder="Search by name or code"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <Select
            aria-label="Filter by type"
            value={typeFilter}
            onChange={(event) => setTypeFilter(event.target.value as TypeFilter)}
          >
            <option value="ALL">All types</option>
            <option value="GOODS">Goods</option>
            <option value="SERVICE">Services</option>
          </Select>
          <Select
            aria-label="Filter by status"
            value={statusFilter}
            onChange={(event) => setStatusFilter(event.target.value as StatusFilter)}
          >
            <option value="ALL">All statuses</option>
            <option value="ACTIVE">Active</option>
            <option value="INACTIVE">Inactive</option>
          </Select>
        </div>

        <QueryBoundary
          query={itemsQuery}
          loadingFallback={<CatalogSkeleton />}
          errorMessage="The catalog could not be loaded."
        >
          {(data) => {
            const items = data.pages.flatMap((page) => page.items)
            if (items.length === 0) {
              return isFiltered ? (
                <EmptyState
                  icon={SearchX}
                  title="No items match"
                  description="Try a different search or clear the filters."
                />
              ) : (
                <EmptyState
                  icon={Package}
                  title="No items yet"
                  description={
                    canManage
                      ? 'Add your first good or service to start building the catalog.'
                      : 'Nothing has been added to the catalog yet.'
                  }
                />
              )
            }
            return (
              <>
                <CatalogList
                  items={items}
                  canManage={canManage}
                  onOpen={(item) => {
                    focus.remember()
                    setDetailsId(item.id)
                  }}
                  onEdit={(item) => {
                    focus.remember(`Actions for ${item.name}`)
                    setFormTarget({ item })
                  }}
                  onChangeStatus={(item) => {
                    focus.remember(`Actions for ${item.name}`)
                    setStatusTarget(item)
                  }}
                />
                {itemsQuery.hasNextPage && (
                  <div className="mt-4 flex justify-center">
                    <Button
                      variant="outline"
                      onClick={() => void itemsQuery.fetchNextPage()}
                      disabled={itemsQuery.isFetchingNextPage}
                    >
                      {itemsQuery.isFetchingNextPage && (
                        <Loader2 className="animate-spin" aria-hidden="true" />
                      )}
                      Load more
                    </Button>
                  </div>
                )}
              </>
            )
          }}
        </QueryBoundary>
      </Card>

      {formTarget && (
        <CatalogItemFormDialog
          open
          item={formTarget.item}
          onOpenChange={(open) => {
            if (open) return
            setFormTarget(null)
            focus.restore()
          }}
        />
      )}
      {statusTarget && (
        <CatalogStatusDialog
          open
          item={statusTarget}
          onOpenChange={(open) => {
            if (open) return
            setStatusTarget(null)
            focus.restore()
          }}
        />
      )}
      {detailsId && (
        <CatalogItemDetailsDialog
          itemId={detailsId}
          canManage={canManage}
          onClose={() => {
            setDetailsId(null)
            focus.restore()
          }}
        />
      )}
    </div>
  )
}

interface CatalogListProps {
  items: CatalogItem[]
  canManage: boolean
  onOpen: (item: CatalogItem) => void
  onEdit: (item: CatalogItem) => void
  onChangeStatus: (item: CatalogItem) => void
}

function RowActions({
  item,
  onEdit,
  onChangeStatus,
}: {
  item: CatalogItem
  onEdit: (item: CatalogItem) => void
  onChangeStatus: (item: CatalogItem) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Actions for ${item.name}`}>
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => onEdit(item)}>
          <Pencil aria-hidden="true" /> Edit
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onChangeStatus(item)}>
          {item.active ? <PowerOff aria-hidden="true" /> : <Power aria-hidden="true" />}
          {item.active ? 'Deactivate' : 'Activate'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

function ItemName({ item, onOpen }: { item: CatalogItem; onOpen: (item: CatalogItem) => void }) {
  return (
    <button
      type="button"
      onClick={() => onOpen(item)}
      className="rounded-sm text-left font-medium text-primary hover:underline"
    >
      {item.name}
    </button>
  )
}

function CatalogList({ items, canManage, onOpen, onEdit, onChangeStatus }: CatalogListProps) {
  return (
    <>
      {/* Phones: stacked cards instead of a wide table. */}
      <ul className="divide-y md:hidden" aria-label="Catalog items">
        {items.map((item) => (
          <li key={item.id} className="flex items-start justify-between gap-2 py-3">
            <div className="min-w-0 space-y-1">
              <ItemName item={item} onOpen={onOpen} />
              <p className="text-xs text-muted-foreground">
                {CATALOG_ITEM_TYPE_LABELS[item.itemType]}
                {item.code ? ` · ${item.code}` : ''}
              </p>
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                <BranchStatusBadge status={item.active ? 'ACTIVE' : 'INACTIVE'} />
                <span>{priceText(item)}</span>
              </div>
            </div>
            {canManage && (
              <RowActions item={item} onEdit={onEdit} onChangeStatus={onChangeStatus} />
            )}
          </li>
        ))}
      </ul>

      <table className="hidden w-full text-left md:table">
        <caption className="sr-only">Catalog items</caption>
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th scope="col" className="pb-2 font-medium">
              Item
            </th>
            <th scope="col" className="pb-2 font-medium">
              Code
            </th>
            <th scope="col" className="pb-2 font-medium">
              Type
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              Price
            </th>
            <th scope="col" className="pb-2 pl-4 font-medium">
              Status
            </th>
            {canManage && (
              <th scope="col" className="pb-2 text-right font-medium">
                <span className="sr-only">Actions</span>
              </th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y">
          {items.map((item) => (
            <tr key={item.id}>
              <th scope="row" className="py-3 pr-2 font-medium">
                <ItemName item={item} onOpen={onOpen} />
              </th>
              <td className="py-3 font-mono text-xs">{item.code ?? '—'}</td>
              <td className="py-3 text-muted-foreground">
                {CATALOG_ITEM_TYPE_LABELS[item.itemType]}
              </td>
              <td className="py-3 text-right tabular-nums">{priceText(item)}</td>
              <td className="py-3 pl-4">
                <BranchStatusBadge status={item.active ? 'ACTIVE' : 'INACTIVE'} />
              </td>
              {canManage && (
                <td className="py-3 text-right">
                  <RowActions item={item} onEdit={onEdit} onChangeStatus={onChangeStatus} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
