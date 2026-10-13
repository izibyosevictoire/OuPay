/* eslint-disable react-refresh/only-export-components -- the hook belongs with its provider */
import { CheckCircle2, X, XCircle } from 'lucide-react'
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { cn } from '@/lib/utils'

type ToastTone = 'success' | 'error'

interface Toast {
  id: number
  tone: ToastTone
  message: string
}

interface ToastContextValue {
  notify: (tone: ToastTone, message: string) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const AUTO_DISMISS_MS = 6000

/** Lightweight feedback for completed actions. Errors are announced assertively. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const nextId = useRef(1)

  const dismiss = useCallback((id: number) => {
    setToasts((current) => current.filter((toast) => toast.id !== id))
  }, [])

  const notify = useCallback(
    (tone: ToastTone, message: string) => {
      const id = nextId.current++
      setToasts((current) => [...current, { id, tone, message }])
      setTimeout(() => dismiss(id), AUTO_DISMISS_MS)
    },
    [dismiss],
  )

  const value = useMemo(() => ({ notify }), [notify])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-[60] flex flex-col items-center gap-2 p-4 sm:items-end">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            className={cn(
              'pointer-events-auto flex w-full max-w-sm items-start gap-2 rounded-lg border bg-card p-3 text-sm shadow-popover',
              toast.tone === 'error' ? 'border-danger/40' : 'border-success/40',
            )}
          >
            {toast.tone === 'error' ? (
              <XCircle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden="true" />
            ) : (
              <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" aria-hidden="true" />
            )}
            <p className="flex-1">{toast.message}</p>
            <button
              type="button"
              onClick={() => dismiss(toast.id)}
              className="-m-2 inline-flex size-10 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
            >
              <X className="size-4" aria-hidden="true" />
              <span className="sr-only">Dismiss notification</span>
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast(): ToastContextValue {
  const value = useContext(ToastContext)
  if (!value) throw new Error('useToast must be used inside ToastProvider')
  return value
}
