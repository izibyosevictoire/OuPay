import { Outlet } from 'react-router-dom'

/**
 * Frame for the anonymous customer payment pages. No account, no business navigation and no
 * merchant data beyond what the page itself shows. Mobile first: one narrow column.
 */
export function PublicPaymentLayout() {
  return (
    <div className="flex min-h-screen flex-col items-center px-4 py-6 sm:py-10">
      <p className="mb-4 text-sm font-semibold tracking-tight">OuPay payment</p>
      <main className="w-full max-w-md">
        <Outlet />
      </main>
      <footer className="mt-6 max-w-md text-center text-xs text-muted-foreground">
        Never share a PIN, password or one-time code with anyone, including the merchant. OuPay will
        never ask for them.
      </footer>
    </div>
  )
}
