import { AccountMenu } from './AccountMenu'
import { BrandLogo } from './BrandLogo'
import { MobileNavigationDrawer } from './MobileNavigationDrawer'
import { NotificationButton } from './NotificationButton'

export function TopHeader() {
  return (
    <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b bg-card/95 px-3 backdrop-blur sm:px-6">
      <MobileNavigationDrawer />
      <div className="lg:hidden">
        <BrandLogo />
      </div>
      <div className="ml-auto flex items-center gap-1">
        <NotificationButton />
        <AccountMenu />
      </div>
    </header>
  )
}
