import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { INVENTORY_PAGE_SIZE } from '@/constants/inventory'
import { useSelectedMerchantId } from '@/features/branches/useBranchQueries'
import { catalogService, inventoryService } from '@/services'
import type {
  AdjustStockInput,
  ListBalancesQuery,
  ListMovementsQuery,
  OpeningStockInput,
  ReceiveStockInput,
} from '@/types/inventory'

export const inventoryKeys = {
  all: (merchantId: string) => ['inventory', merchantId] as const,
  options: (merchantId: string) => ['inventory', merchantId, 'options'] as const,
  balances: (merchantId: string, filters: Omit<ListBalancesQuery, 'cursor'>) =>
    ['inventory', merchantId, 'balances', filters] as const,
  movements: (merchantId: string, filters: Omit<ListMovementsQuery, 'cursor'>) =>
    ['inventory', merchantId, 'movements', filters] as const,
  goods: (merchantId: string) => ['inventory', merchantId, 'goods'] as const,
}

/** The branches the person may view, and where they may record stock. */
export function useInventoryOptions() {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: inventoryKeys.options(merchantId),
    queryFn: () => inventoryService.getOptions(merchantId),
    // A business without inventory (mode, permission) will not gain it on retry.
    retry: false,
  })
}

export function useBalances(filters: Omit<ListBalancesQuery, 'cursor'>) {
  const merchantId = useSelectedMerchantId()
  return useInfiniteQuery({
    queryKey: inventoryKeys.balances(merchantId, filters),
    queryFn: ({ pageParam }) =>
      inventoryService.listBalances(merchantId, {
        ...filters,
        limit: INVENTORY_PAGE_SIZE,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    retry: false,
  })
}

export function useMovements(filters: Omit<ListMovementsQuery, 'cursor'>, enabled = true) {
  const merchantId = useSelectedMerchantId()
  return useInfiniteQuery({
    queryKey: inventoryKeys.movements(merchantId, filters),
    queryFn: ({ pageParam }) =>
      inventoryService.listMovements(merchantId, {
        ...filters,
        limit: INVENTORY_PAGE_SIZE,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    enabled,
    retry: false,
  })
}

/**
 * The GOODS that can hold stock: active goods from the catalog. Services are never offered (they have no stock), and the
 * server refuses them anyway.
 */
export function useStockableGoods() {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: inventoryKeys.goods(merchantId),
    queryFn: async () =>
      (await catalogService.listItems(merchantId, { type: 'GOODS', active: true, limit: 200 }))
        .items,
    retry: false,
  })
}

export type StockOperation =
  | { kind: 'OPENING'; input: OpeningStockInput }
  | { kind: 'RECEIVE'; input: ReceiveStockInput }
  | { kind: 'ADJUST'; input: AdjustStockInput }

export function useRecordStock() {
  const merchantId = useSelectedMerchantId()
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (operation: StockOperation) => {
      switch (operation.kind) {
        case 'OPENING':
          return inventoryService.recordOpening(merchantId, operation.input)
        case 'RECEIVE':
          return inventoryService.receiveStock(merchantId, operation.input)
        case 'ADJUST':
          return inventoryService.adjustStock(merchantId, operation.input)
      }
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: inventoryKeys.all(merchantId) }),
  })
}
