/* eslint-disable react-refresh/only-export-components -- the hook belongs with its provider */
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react'
import { authService } from '@/services'
import { AuthServiceError } from '@/services/authService'
import type {
  AuthSession,
  BusinessMembership,
  LoginCredentials,
  RegisterInput,
  User,
} from '@/types/auth'

export type AuthStatus = 'loading' | 'authenticated' | 'unauthenticated' | 'expired' | 'error'

export interface AuthContextValue {
  status: AuthStatus
  user: User | null
  /** Every membership, whatever its status. Business access is derived in BusinessContext. */
  memberships: BusinessMembership[]
  login: (credentials: LoginCredentials, options: { rememberMe: boolean }) => Promise<void>
  register: (input: RegisterInput) => Promise<void>
  logout: () => Promise<void>
  /** Re-reads the session, e.g. after a membership changed. */
  refreshSession: () => Promise<unknown>
  retrySessionCheck: () => void
  /** True after the user chose to sign out, so the next sign-in does not resume their last page. */
  didSignOutOnPurpose: boolean
}

export const AUTH_SESSION_QUERY_KEY = ['auth', 'session'] as const

const NO_MEMBERSHIPS: BusinessMembership[] = []

const AuthContext = createContext<AuthContextValue | null>(null)

/**
 * Holds who is signed in. It knows nothing about which business is selected:
 * BusinessContextProvider depends on this provider, never the other way round.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient()
  const [didSignOutOnPurpose, setDidSignOutOnPurpose] = useState(false)
  const sessionQuery = useQuery({
    queryKey: AUTH_SESSION_QUERY_KEY,
    queryFn: () => authService.getCurrentSession(),
    retry: false,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
  })

  const status: AuthStatus = sessionQuery.isPending
    ? 'loading'
    : sessionQuery.isError
      ? sessionQuery.error instanceof AuthServiceError &&
        sessionQuery.error.code === 'session_expired'
        ? 'expired'
        : 'error'
      : sessionQuery.data
        ? 'authenticated'
        : 'unauthenticated'

  const session: AuthSession | null = sessionQuery.data ?? null

  const storeSession = useCallback(
    (next: AuthSession) => queryClient.setQueryData(AUTH_SESSION_QUERY_KEY, next),
    [queryClient],
  )

  const login = useCallback<AuthContextValue['login']>(
    async (credentials, options) => {
      storeSession(await authService.login(credentials, options))
      setDidSignOutOnPurpose(false)
    },
    [storeSession],
  )

  const register = useCallback<AuthContextValue['register']>(
    async (input) => {
      storeSession(await authService.register(input))
      setDidSignOutOnPurpose(false)
    },
    [storeSession],
  )

  const logout = useCallback(async () => {
    // A session check already in flight must not resolve afterwards and revive the old session.
    await queryClient.cancelQueries({ queryKey: AUTH_SESSION_QUERY_KEY })
    await authService.logout()
    // Drop every cached business record so nothing leaks to the next person on this device.
    queryClient.removeQueries({ predicate: (query) => query.queryKey[0] !== 'auth' })
    queryClient.setQueryData(AUTH_SESSION_QUERY_KEY, null)
    setDidSignOutOnPurpose(true)
  }, [queryClient])

  const refreshSession = useCallback(
    () => queryClient.invalidateQueries({ queryKey: AUTH_SESSION_QUERY_KEY }),
    [queryClient],
  )

  const retrySessionCheck = useCallback(() => void sessionQuery.refetch(), [sessionQuery])

  const value = useMemo<AuthContextValue>(
    () => ({
      status,
      user: session?.user ?? null,
      memberships: session?.memberships ?? NO_MEMBERSHIPS,
      login,
      register,
      logout,
      refreshSession,
      retrySessionCheck,
      didSignOutOnPurpose,
    }),
    [
      status,
      session,
      login,
      register,
      logout,
      refreshSession,
      retrySessionCheck,
      didSignOutOnPurpose,
    ],
  )

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext)
  if (!value) throw new Error('useAuth must be used inside AuthProvider')
  return value
}
