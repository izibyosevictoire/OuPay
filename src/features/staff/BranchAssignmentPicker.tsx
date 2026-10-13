import { useId } from 'react'
import { BRANCH_STATUS_LABELS } from '@/constants/branch'
import type { Branch } from '@/types/branch'

interface BranchAssignmentPickerProps {
  /** Branches of the current business only. */
  branches: Branch[]
  selectedBranchIds: string[]
  onChange: (branchIds: string[]) => void
  legend?: string
  disabled?: boolean
}

/**
 * Reusable multi-select for branch assignments. Inactive branches cannot be newly chosen;
 * one that is already selected stays visible so it can be removed, preserving the rule
 * that only active branches receive new assignments.
 */
export function BranchAssignmentPicker({
  branches,
  selectedBranchIds,
  onChange,
  legend = 'Assigned branches',
  disabled = false,
}: BranchAssignmentPickerProps) {
  const groupId = useId()
  const selected = new Set(selectedBranchIds)

  if (branches.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        There are no branches yet. Add a branch first to assign staff to it.
      </p>
    )
  }

  const toggle = (branchId: string) =>
    onChange(
      selected.has(branchId)
        ? selectedBranchIds.filter((id) => id !== branchId)
        : [...selectedBranchIds, branchId],
    )

  return (
    <fieldset className="space-y-1">
      <legend className="mb-1 text-sm font-medium">{legend}</legend>
      <ul className="divide-y rounded-md border">
        {branches.map((branch) => {
          const isSelected = selected.has(branch.id)
          const isBlocked = branch.status === 'INACTIVE' && !isSelected
          const inputId = `${groupId}-${branch.id}`
          return (
            <li key={branch.id}>
              <label
                htmlFor={inputId}
                className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm aria-disabled:cursor-not-allowed aria-disabled:opacity-60"
                aria-disabled={isBlocked || disabled}
              >
                <input
                  id={inputId}
                  type="checkbox"
                  className="size-5 shrink-0 accent-primary"
                  checked={isSelected}
                  disabled={isBlocked || disabled}
                  onChange={() => toggle(branch.id)}
                />
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-medium">
                    {branch.name}{' '}
                    <span className="font-mono text-xs font-normal">({branch.code})</span>
                  </span>
                  <span className="block text-xs text-muted-foreground">
                    {branch.location.district}, {branch.location.sector}
                    {branch.status === 'INACTIVE' &&
                      ` · ${BRANCH_STATUS_LABELS.INACTIVE}${isSelected ? ' (can only be removed)' : ' (cannot be assigned)'}`}
                  </span>
                </span>
              </label>
            </li>
          )
        })}
      </ul>
    </fieldset>
  )
}
