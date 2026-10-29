import { KeyRound, Loader2, Plus, SearchX } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { EmptyState } from '@/components/common/EmptyState'
import { PageHeader } from '@/components/common/PageHeader'
import { QueryBoundary } from '@/components/common/QueryBoundary'
import { Button } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Input, Select } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { COLLECTION_CODE_STATUS_LABELS, INTERNAL_REF_LABEL } from '@/constants/collectionCodes'
import { usePermission } from '@/features/auth/permissions/usePermission'
import type { CollectionCode, CollectionCodeStatus } from '@/types/collectionCodes'
import { CodeDetailsDialog } from './CodeDetailsDialog'
import { RequestCodeDialog } from './CodeDialogs'
import { AssigneeAttention, CodeStatusBadge } from './CodeParts'
import { assigneeLabel } from './codeLabels'
import { MyCodeCard } from './MyCodeCard'
import { useCollectionCodeOptions, useCollectionCodes } from './collectionCodeQueries'

function ListSkeleton() {
  return (
    <div className="space-y-3">
      {[0, 1, 2].map((index) => (
        <Skeleton key={index} className="h-14 w-full" />
      ))}
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

/**
 * The page shell. People who may view the registry (owners, managers) manage it; everyone else with an active membership sees only
 * their own code. This is presentation: the server enforces who may see and do what.
 */
export function CollectionCodesPage() {
  const view = usePermission('collection_codes:view')
  return view.isAllowed ? <ManagementView /> : <MyCodeView />
}

function MyCodeView() {
  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title="My collection code"
        description="The collection code you hold, and whether it is approved by the bank."
      />
      <MyCodeCard />
    </div>
  )
}

function ManagementView() {
  const focus = useReturnFocus()
  const manage = usePermission('collection_codes:manage')
  const optionsQuery = useCollectionCodeOptions()
  const [requesting, setRequesting] = useState(false)
  const [openCodeId, setOpenCodeId] = useState<string | null>(null)

  return (
    <div className="space-y-4 sm:space-y-6">
      <PageHeader
        title="Collection codes"
        description="The codes your agents and collection points collect payments with, and who holds each one."
        actions={
          manage.isAllowed && optionsQuery.data ? (
            <Button
              onClick={() => {
                focus.remember()
                setRequesting(true)
              }}
            >
              <Plus aria-hidden="true" />
              Request a code
            </Button>
          ) : null
        }
      />
      <p role="note" className="rounded-md bg-muted px-3 py-2 text-sm text-muted-foreground">
        Collection codes are issued by Equity. OuPay records your requests and who holds each code,
        but it never creates a bank code. A code is not a payment instruction until the bank has
        provisioned it and it is eligible for collection now.
      </p>
      <MyCodeCard onlyWhenAssigned />
      <Card className="p-4 sm:p-5">
        <CodeList
          onOpen={(id) => {
            focus.remember()
            setOpenCodeId(id)
          }}
          canRequest={manage.isAllowed && Boolean(optionsQuery.data)}
          onRequest={() => {
            focus.remember()
            setRequesting(true)
          }}
          branches={optionsQuery.data?.branches ?? []}
        />
      </Card>

      {requesting && optionsQuery.data && (
        <RequestCodeDialog
          open
          options={optionsQuery.data}
          onOpenChange={(open) => {
            if (open) return
            setRequesting(false)
            focus.restore()
          }}
        />
      )}
      {openCodeId && (
        <CodeDetailsDialog
          codeId={openCodeId}
          options={optionsQuery.data}
          onClose={() => {
            setOpenCodeId(null)
            focus.restore()
          }}
        />
      )}
    </div>
  )
}

const STATUS_OPTIONS = Object.keys(COLLECTION_CODE_STATUS_LABELS) as CollectionCodeStatus[]

function CodeList({
  onOpen,
  canRequest,
  onRequest,
  branches,
}: {
  onOpen: (id: string) => void
  canRequest: boolean
  onRequest: () => void
  branches: { id: string; name: string }[]
}) {
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState<CollectionCodeStatus | ''>('')
  const [branchId, setBranchId] = useState('')
  const term = useDebounced(search.trim(), 250)
  const filters = useMemo(
    () => ({ q: term || undefined, status: status || undefined, branchId: branchId || undefined }),
    [term, status, branchId],
  )
  const query = useCollectionCodes(filters)
  const isFiltered = Boolean(filters.q || filters.status || filters.branchId)

  return (
    <>
      <div className="mb-4 grid gap-3 sm:grid-cols-[1fr_12rem_12rem]">
        <Input
          type="search"
          aria-label="Search collection codes"
          placeholder="Search by label or reference"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        <Select
          aria-label="Filter by status"
          value={status}
          onChange={(event) => setStatus(event.target.value as CollectionCodeStatus | '')}
        >
          <option value="">All statuses</option>
          {STATUS_OPTIONS.map((value) => (
            <option key={value} value={value}>
              {COLLECTION_CODE_STATUS_LABELS[value]}
            </option>
          ))}
        </Select>
        <Select
          aria-label="Filter by branch"
          value={branchId}
          onChange={(event) => setBranchId(event.target.value)}
        >
          <option value="">All branches</option>
          {branches.map((branch) => (
            <option key={branch.id} value={branch.id}>
              {branch.name}
            </option>
          ))}
        </Select>
      </div>
      <QueryBoundary
        query={query}
        loadingFallback={<ListSkeleton />}
        errorMessage="The collection codes could not be loaded."
      >
        {(data) => {
          const rows = data.pages.flatMap((page) => page.items)
          if (rows.length === 0) {
            return isFiltered ? (
              <EmptyState
                icon={SearchX}
                title="No codes match"
                description="Try a different search, status or branch."
              />
            ) : (
              <div>
                <EmptyState
                  icon={KeyRound}
                  title="No collection codes yet"
                  description={
                    canRequest
                      ? 'Request a code for a branch or collection point. Nothing is sent to Equity until you ask the bank yourself.'
                      : 'Your owner requests codes. They will appear here.'
                  }
                />
                {canRequest && (
                  <div className="flex justify-center pb-4">
                    <Button onClick={onRequest}>
                      <Plus aria-hidden="true" />
                      Request a code
                    </Button>
                  </div>
                )}
              </div>
            )
          }
          return (
            <>
              <CodeRows rows={rows} onOpen={onOpen} />
              {query.hasNextPage && (
                <div className="mt-4 flex justify-center">
                  <Button
                    variant="outline"
                    onClick={() => void query.fetchNextPage()}
                    disabled={query.isFetchingNextPage}
                  >
                    {query.isFetchingNextPage && (
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
    </>
  )
}

function codeValueLabel(code: CollectionCode) {
  return code.externalCodeState === 'BANK_APPROVED' && code.externalCode
    ? `Bank-issued code ${code.externalCode}${code.simulated ? ' (simulated)' : ''}`
    : 'Equity-issued code: none yet'
}

function CodeRows({ rows, onOpen }: { rows: CollectionCode[]; onOpen: (id: string) => void }) {
  return (
    <>
      {/* Phones: stacked cards instead of a wide table. */}
      <ul className="divide-y md:hidden" aria-label="Collection codes">
        {rows.map((code) => (
          <li key={code.id} className="space-y-1 py-3">
            <div className="flex items-start justify-between gap-2">
              <p className="font-medium">{code.displayLabel}</p>
              <CodeStatusBadge status={code.status} />
            </div>
            <p className="text-xs text-muted-foreground">
              {INTERNAL_REF_LABEL} <span className="font-mono">{code.internalRef}</span>
            </p>
            <p className="text-xs text-muted-foreground">
              {codeValueLabel(code)} ·{' '}
              {code.payable ? 'Eligible for collection now' : 'Not eligible for collection now'}
            </p>
            <p className="text-sm">{assigneeLabel(code.currentAssignment)}</p>
            <p className="text-xs text-muted-foreground">
              {code.branchName ?? 'No specific branch'} · {code.settlementAccountLabel}{' '}
              {code.settlementAccountMasked}
            </p>
            <AssigneeAttention assignment={code.currentAssignment} />
            <Button
              variant="outline"
              size="sm"
              aria-label={`View ${code.displayLabel}`}
              onClick={() => onOpen(code.id)}
            >
              View
            </Button>
          </li>
        ))}
      </ul>

      <table className="hidden w-full text-left md:table">
        <caption className="sr-only">Collection codes</caption>
        <thead className="text-xs text-muted-foreground">
          <tr className="border-b">
            <th scope="col" className="pb-2 font-medium">
              Code
            </th>
            <th scope="col" className="pb-2 font-medium">
              Status
            </th>
            <th scope="col" className="pb-2 font-medium">
              Held by
            </th>
            <th scope="col" className="pb-2 font-medium">
              Branch
            </th>
            <th scope="col" className="pb-2 font-medium">
              Settlement account
            </th>
            <th scope="col" className="pb-2 text-right font-medium">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {rows.map((code) => (
            <tr key={code.id} className="align-top">
              <th scope="row" className="py-3 pr-2 font-medium">
                <span className="block">{code.displayLabel}</span>
                <span className="block text-xs font-normal text-muted-foreground">
                  {INTERNAL_REF_LABEL} <span className="font-mono">{code.internalRef}</span>
                </span>
                <span className="block text-xs font-normal text-muted-foreground">
                  {codeValueLabel(code)} ·{' '}
                  {code.payable ? 'Eligible for collection now' : 'Not eligible for collection now'}
                </span>
              </th>
              <td className="py-3 pr-2">
                <CodeStatusBadge status={code.status} />
              </td>
              <td className="py-3 pr-2">
                {assigneeLabel(code.currentAssignment)}
                <AssigneeAttention assignment={code.currentAssignment} />
              </td>
              <td className="py-3 pr-2 text-muted-foreground">
                {code.branchName ?? 'No specific branch'}
              </td>
              <td className="py-3 pr-2 text-muted-foreground">
                {code.settlementAccountLabel} {code.settlementAccountMasked}
              </td>
              <td className="py-3 text-right">
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`View ${code.displayLabel}`}
                  onClick={() => onOpen(code.id)}
                >
                  View
                </Button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  )
}
