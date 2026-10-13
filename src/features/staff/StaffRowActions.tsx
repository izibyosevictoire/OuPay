import {
  Ban,
  Building2,
  MailPlus,
  MoreHorizontal,
  PauseCircle,
  PlayCircle,
  ShieldCheck,
  Link as LinkIcon,
} from 'lucide-react'
import { Link } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { StaffMember } from '@/types/staff'
import type { StaffRowAction } from './staffActions'

interface StaffRowActionsProps {
  member: StaffMember
  actions: StaffRowAction[]
  onAction: (action: Exclude<StaffRowAction, 'open_invitation'>, member: StaffMember) => void
}

export function StaffRowActions({ member, actions, onAction }: StaffRowActionsProps) {
  if (actions.length === 0) {
    return <span className="sr-only">No actions available for {member.fullName}</span>
  }
  const has = (action: StaffRowAction) => actions.includes(action)

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label={`Actions for ${member.fullName}`}>
          <MoreHorizontal aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {has('assign_branches') && (
          <DropdownMenuItem onSelect={() => onAction('assign_branches', member)}>
            <Building2 aria-hidden="true" /> Manage branches
          </DropdownMenuItem>
        )}
        {has('change_role') && (
          <DropdownMenuItem onSelect={() => onAction('change_role', member)}>
            <ShieldCheck aria-hidden="true" /> Change role
          </DropdownMenuItem>
        )}
        {has('open_invitation') && member.pendingInvitation && (
          <DropdownMenuItem asChild>
            <Link to={`/accept-invitation/${member.pendingInvitation.demoToken}`}>
              <LinkIcon aria-hidden="true" /> Open demo invitation
            </Link>
          </DropdownMenuItem>
        )}
        {has('invite_again') && (
          <DropdownMenuItem onSelect={() => onAction('invite_again', member)}>
            <MailPlus aria-hidden="true" /> Send new invitation
          </DropdownMenuItem>
        )}
        {has('suspend') && (
          <DropdownMenuItem onSelect={() => onAction('suspend', member)}>
            <PauseCircle aria-hidden="true" /> Suspend
          </DropdownMenuItem>
        )}
        {has('reactivate') && (
          <DropdownMenuItem onSelect={() => onAction('reactivate', member)}>
            <PlayCircle aria-hidden="true" /> Reactivate
          </DropdownMenuItem>
        )}
        {has('revoke') && (
          <DropdownMenuItem onSelect={() => onAction('revoke', member)}>
            <Ban aria-hidden="true" />{' '}
            {member.status === 'INVITED' ? 'Cancel invitation' : 'Revoke access'}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
