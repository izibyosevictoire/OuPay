import { Menu } from 'lucide-react'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet'
import { BrandLogo } from './BrandLogo'
import { NavigationLinks } from './NavigationLinks'

export function MobileNavigationDrawer() {
  const [isOpen, setIsOpen] = useState(false)
  return (
    <Sheet open={isOpen} onOpenChange={setIsOpen}>
      <SheetTrigger asChild>
        <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Open navigation menu">
          <Menu className="size-5" aria-hidden="true" />
        </Button>
      </SheetTrigger>
      <SheetContent>
        <div className="p-4 pt-5">
          <SheetTitle asChild>
            <div>
              <BrandLogo />
            </div>
          </SheetTitle>
          <SheetDescription className="sr-only">Main navigation</SheetDescription>
        </div>
        <div className="px-3">
          <NavigationLinks onNavigate={() => setIsOpen(false)} />
        </div>
      </SheetContent>
    </Sheet>
  )
}
