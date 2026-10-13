import { BrandLogo } from './BrandLogo'
import { NavigationLinks } from './NavigationLinks'

export function Sidebar() {
  return (
    <aside
      aria-label="Sidebar"
      className="hidden w-60 shrink-0 flex-col gap-6 border-r bg-card p-4 lg:flex"
    >
      <div className="px-2 pt-1">
        <BrandLogo />
      </div>
      <NavigationLinks />
    </aside>
  )
}
