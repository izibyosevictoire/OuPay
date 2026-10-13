import { Outlet } from 'react-router-dom'

/**
 * Bare layout for printable documents: no sidebar or header, so what you see is what prints.
 * Print rules (A4 page, white background) live in styles/globals.css.
 */
export function PrintLayout() {
  return (
    <main className="min-h-screen bg-muted p-3 sm:p-6 print:bg-white print:p-0">
      <Outlet />
    </main>
  )
}
