/* eslint-disable react-refresh/only-export-components -- the hook belongs with its provider */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'
import type { BusinessContextValue } from '@/types/businessContext'
import { useAuth } from './AuthProvider'

const STORAGE_KEY = 'oupay.selectedMerchant'

interface StoredSelection {
  userId: string
  merchantId: string
}

const BusinessContext = createContext<BusinessContextValue | null>(null)

function readStoredSelection(): StoredSelection | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? (JSON.parse(raw) as Partial<StoredSelection>) : null
    return typeof parsed?.userId === 'string' && typeof parsed.merchantId === 'string'
      ? { userId: parsed.userId, merchantId: parsed.merchantId }
      : null
  } catch {
    return null
  }
}

function writeStoredSelection(selection: StoredSelection | null) {
  try {
    if (selection) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(selection))
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    // Selection still works for this session without persistence.
  }
}

/**
 * Derives the selectable businesses from the signed-in user's ACTIVE memberships. A stored
 * or requested selection is only honoured if it is one of them, so a stale or tampered
 * value can never grant access to another business.
 */
export function BusinessContextProvider({ children }: { children: ReactNode }) {
  const { status, user, memberships } = useAuth()
  const [preferred, setPreferred] = useState<StoredSelection | null>(readStoredSelection)

  const availableMemberships = useMemo(
    () => memberships.filter((membership) => membership.status === 'ACTIVE'),
    [memberships],
  )

  const currentMembership = useMemo(() => {
    const preferredForThisUser = preferred?.userId === user?.id ? preferred : null
    return (
      availableMemberships.find(
        (membership) => membership.merchantId === preferredForThisUser?.merchantId,
      ) ??
      availableMemberships[0] ??
      null
    )
  }, [availableMemberships, preferred, user?.id])

  const selectedMerchantId = currentMembership?.merchantId ?? null

  // Forget the selection once signed out. Adjusting state during render (guarded) avoids an effect.
  const isSignedOut = status === 'unauthenticated' || status === 'expired'
  if (isSignedOut && preferred !== null) setPreferred(null)

  // Persist the effective choice (an external system), and erase it on sign-out.
  useEffect(() => {
    if (isSignedOut) writeStoredSelection(null)
    else if (user && selectedMerchantId) {
      writeStoredSelection({ userId: user.id, merchantId: selectedMerchantId })
    }
  }, [isSignedOut, user, selectedMerchantId])

  const selectMerchant = useCallback(
    (merchantId: string) => {
      if (user) setPreferred({ userId: user.id, merchantId })
    },
    [user],
  )

  const value = useMemo<BusinessContextValue>(
    () => ({ availableMemberships, selectedMerchantId, currentMembership, selectMerchant }),
    [availableMemberships, selectedMerchantId, currentMembership, selectMerchant],
  )
  return <BusinessContext.Provider value={value}>{children}</BusinessContext.Provider>
}

export function useBusinessContext(): BusinessContextValue {
  const value = useContext(BusinessContext)
  if (!value) throw new Error('useBusinessContext must be used inside BusinessContextProvider')
  return value
}
