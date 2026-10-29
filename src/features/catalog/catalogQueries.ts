import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useSelectedMerchantId } from '@/features/branches/useBranchQueries'
import { CATALOG_PAGE_SIZE } from '@/constants/catalog'
import { catalogService } from '@/services'
import type {
  ChangeCatalogItemStatusInput,
  CreateCatalogItemInput,
  CreateCatalogPackageInput,
  ListCatalogItemsQuery,
  SetItemTaxInput,
  UpdateCatalogItemInput,
  UpdateCatalogPackageInput,
} from '@/types/catalog'

export const catalogKeys = {
  all: (merchantId: string) => ['catalog', merchantId] as const,
  units: (merchantId: string) => ['catalog', merchantId, 'units'] as const,
  list: (merchantId: string, filters: Omit<ListCatalogItemsQuery, 'cursor'>) =>
    ['catalog', merchantId, 'list', filters] as const,
  item: (merchantId: string, itemId: string) => ['catalog', merchantId, 'item', itemId] as const,
  history: (merchantId: string, itemId: string) =>
    ['catalog', merchantId, 'history', itemId] as const,
  tax: (merchantId: string, itemId: string) => ['catalog', merchantId, 'tax', itemId] as const,
}

/** The units come from the service: the browser never decides which units exist or belong together. */
export function useMeasurementUnits() {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: catalogKeys.units(merchantId),
    queryFn: () => catalogService.listMeasurementUnits(merchantId),
    staleTime: Infinity,
  })
}

export function useCatalogItems(filters: Omit<ListCatalogItemsQuery, 'cursor'>) {
  const merchantId = useSelectedMerchantId()
  return useInfiniteQuery({
    queryKey: catalogKeys.list(merchantId, filters),
    queryFn: ({ pageParam }) =>
      catalogService.listItems(merchantId, {
        ...filters,
        limit: CATALOG_PAGE_SIZE,
        cursor: pageParam,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (page) => page.nextCursor ?? undefined,
    // A missing catalog (business mode, permission) will not appear on retry.
    retry: false,
  })
}

export function useCatalogItem(itemId: string) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: catalogKeys.item(merchantId, itemId),
    queryFn: () => catalogService.getItem(merchantId, itemId),
    retry: false,
  })
}

export function usePriceHistory(itemId: string, enabled: boolean) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: catalogKeys.history(merchantId, itemId),
    queryFn: () => catalogService.listPriceHistory(merchantId, itemId),
    enabled,
    retry: false,
  })
}

function useInvalidateCatalog() {
  const queryClient = useQueryClient()
  const merchantId = useSelectedMerchantId()
  return () => queryClient.invalidateQueries({ queryKey: catalogKeys.all(merchantId) })
}

export function useCreateCatalogItem() {
  const merchantId = useSelectedMerchantId()
  const invalidate = useInvalidateCatalog()
  return useMutation({
    mutationFn: (input: CreateCatalogItemInput) => catalogService.createItem(merchantId, input),
    onSuccess: invalidate,
  })
}

export function useUpdateCatalogItem(itemId: string) {
  const merchantId = useSelectedMerchantId()
  const invalidate = useInvalidateCatalog()
  return useMutation({
    mutationFn: (input: UpdateCatalogItemInput) =>
      catalogService.updateItem(merchantId, itemId, input),
    onSuccess: invalidate,
  })
}

export function useChangeCatalogItemStatus() {
  const merchantId = useSelectedMerchantId()
  const invalidate = useInvalidateCatalog()
  return useMutation({
    mutationFn: ({ itemId, ...input }: ChangeCatalogItemStatusInput & { itemId: string }) =>
      catalogService.changeItemStatus(merchantId, itemId, input),
    onSuccess: invalidate,
  })
}

export function useCreateCatalogPackage(itemId: string) {
  const merchantId = useSelectedMerchantId()
  const invalidate = useInvalidateCatalog()
  return useMutation({
    mutationFn: (input: CreateCatalogPackageInput) =>
      catalogService.createPackage(merchantId, itemId, input),
    onSuccess: invalidate,
  })
}

export function useUpdateCatalogPackage(itemId: string) {
  const merchantId = useSelectedMerchantId()
  const invalidate = useInvalidateCatalog()
  return useMutation({
    mutationFn: ({ packageId, ...input }: UpdateCatalogPackageInput & { packageId: string }) =>
      catalogService.updatePackage(merchantId, itemId, packageId, input),
    onSuccess: invalidate,
  })
}

/** The item's tax classification. Read fresh: billing depends on it. */
export function useItemTax(itemId: string) {
  const merchantId = useSelectedMerchantId()
  return useQuery({
    queryKey: catalogKeys.tax(merchantId, itemId),
    queryFn: () => catalogService.getItemTax(merchantId, itemId),
    retry: false,
    staleTime: 0,
  })
}

export function useSetItemTax(itemId: string) {
  const merchantId = useSelectedMerchantId()
  const invalidate = useInvalidateCatalog()
  return useMutation({
    mutationFn: (input: SetItemTaxInput) => catalogService.setItemTax(merchantId, itemId, input),
    onSuccess: invalidate,
  })
}
