import { Eye, MoreHorizontal, Pencil, Power, PowerOff } from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Branch } from '@/types/branch'

interface BranchRowActionsProps {
  branch: Branch
  onEdit: (branch: Branch) => void
  onChangeStatus: (branch: Branch) => void
}

export function BranchRowActions({ branch, onEdit, onChangeStatus }: BranchRowActionsProps) {
  const isActive = branch.status === 'ACTIVE'
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Actions for ${branch.name}`}>
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem asChild>
          <Link to={`/branches/${branch.id}`}>
            <Eye aria-hidden="true" /> View details
          </Link>
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onEdit(branch)}>
          <Pencil aria-hidden="true" /> Edit
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => onChangeStatus(branch)}>
          {isActive ? <PowerOff aria-hidden="true" /> : <Power aria-hidden="true" />}
          {isActive ? 'Deactivate' : 'Activate'}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
