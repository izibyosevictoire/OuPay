import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  DEMO_INVITE_EXISTING_USER_TOKEN,
  DEMO_INVITE_NEW_USER_TOKEN,
} from '@/services/mock/sampleAccounts'
import { SAMPLE_BRANCH_IDS } from '@/services/mock/sampleOrganization'
import { findAccessibilityViolations } from '@/test/axe'
import { useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

type User = ReturnType<typeof userEvent.setup>

const table = () => within(screen.getByRole('table'))

async function openRowMenu(user: User, name: string) {
  await user.click(table().getByRole('button', { name: `Actions for ${name}` }))
  return screen.findByRole('menu')
}

beforeEach(() => {
  useFastBackend()
})

describe('accessibility: branches', () => {
  it('list, with an open row menu', async () => {
    const user = userEvent.setup()
    const { container } = await renderAppAt('/branches')
    await screen.findByRole('table')
    expect(await findAccessibilityViolations(container)).toEqual([])
    const menu = await openRowMenu(user, 'Remera Main')
    expect(await findAccessibilityViolations(menu)).toEqual([])
  })

  it('create dialog, including validation errors', async () => {
    const user = userEvent.setup()
    await renderAppAt('/branches')
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Add branch' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add a branch' })
    expect(await findAccessibilityViolations(dialog)).toEqual([])
    await user.click(within(dialog).getByRole('button', { name: 'Add branch' }))
    await within(dialog).findByText('Branch name is required.')
    expect(await findAccessibilityViolations(dialog)).toEqual([])
  })

  it('edit and deactivate-confirmation dialogs', async () => {
    const user = userEvent.setup()
    await renderAppAt('/branches')
    await screen.findByRole('table')
    let menu = await openRowMenu(user, 'City Centre')
    await user.click(within(menu).getByRole('menuitem', { name: 'Edit' }))
    expect(
      await findAccessibilityViolations(await screen.findByRole('dialog', { name: 'Edit branch' })),
    ).toEqual([])
    await user.click(screen.getByRole('button', { name: 'Cancel' }))
    menu = await openRowMenu(user, 'City Centre')
    await user.click(within(menu).getByRole('menuitem', { name: 'Deactivate' }))
    expect(await findAccessibilityViolations(await screen.findByRole('dialog'))).toEqual([])
  })

  it('details page and the branch-not-found state', async () => {
    const { container, unmount } = await renderAppAt(`/branches/${SAMPLE_BRANCH_IDS.remera}`)
    await screen.findByRole('heading', { level: 1, name: 'Remera Main' })
    expect(await findAccessibilityViolations(container)).toEqual([])
    unmount()
    const second = await renderAppAt(`/branches/${SAMPLE_BRANCH_IDS.cafe}`)
    await screen.findByRole('heading', { level: 1, name: 'Branch not found' })
    expect(await findAccessibilityViolations(second.container)).toEqual([])
  })
})

describe('accessibility: staff', () => {
  it('list with its row menu, on the owner view', async () => {
    const user = userEvent.setup()
    const { container } = await renderAppAt('/cashiers')
    await screen.findByRole('table')
    expect(await findAccessibilityViolations(container)).toEqual([])
    const menu = await openRowMenu(user, 'Aline Uwase')
    expect(await findAccessibilityViolations(menu)).toEqual([])
  })

  it('invite dialog with errors, and the created confirmation', async () => {
    const user = userEvent.setup()
    await renderAppAt('/cashiers')
    await screen.findByRole('table')
    await user.click(screen.getByRole('button', { name: 'Invite staff' }))
    const dialog = await screen.findByRole('dialog', { name: 'Invite staff' })
    await within(dialog).findByRole('checkbox', { name: /Remera Main/ })
    expect(await findAccessibilityViolations(dialog)).toEqual([])
    await user.click(within(dialog).getByRole('button', { name: 'Send invitation' }))
    await within(dialog).findByText('Email address is required.')
    expect(await findAccessibilityViolations(dialog)).toEqual([])
    await user.type(within(dialog).getByLabelText(/Email address/), 'nadine@example.rw')
    await user.click(within(dialog).getByRole('button', { name: 'Send invitation' }))
    const created = await screen.findByRole('dialog', { name: 'Invitation created' })
    expect(await findAccessibilityViolations(created)).toEqual([])
  })

  it('role, branch-assignment and revoke dialogs', async () => {
    const user = userEvent.setup()
    await renderAppAt('/cashiers')
    await screen.findByRole('table')
    for (const [item, dialogName] of [
      ['Change role', 'Change role'],
      ['Manage branches', 'Manage branches'],
      ['Revoke access', 'Revoke access for Aline Uwase?'],
    ] as const) {
      const menu = await openRowMenu(user, 'Aline Uwase')
      await user.click(within(menu).getByRole('menuitem', { name: item }))
      const dialog = await screen.findByRole('dialog', { name: dialogName })
      if (item === 'Manage branches')
        await within(dialog).findByRole('checkbox', { name: /Remera/ })
      expect(await findAccessibilityViolations(dialog)).toEqual([])
      await user.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    }
  })

  it('accepting an invitation: existing user, new user and wrong account', async () => {
    const existing = await renderAppAt(`/accept-invitation/${DEMO_INVITE_EXISTING_USER_TOKEN}`, {
      signedInAs: null,
    })
    await screen.findByRole('heading', { level: 1, name: 'Join Sample Shop' })
    expect(await findAccessibilityViolations(existing.container)).toEqual([])
    existing.unmount()

    const brandNew = await renderAppAt(`/accept-invitation/${DEMO_INVITE_NEW_USER_TOKEN}`, {
      signedInAs: null,
    })
    await screen.findByLabelText(/Full name/)
    expect(await findAccessibilityViolations(brandNew.container)).toEqual([])
    brandNew.unmount()

    const wrong = await renderAppAt(`/accept-invitation/${DEMO_INVITE_EXISTING_USER_TOKEN}`, {
      signedInAs: 'cashier',
    })
    await screen.findByRole('heading', {
      level: 1,
      name: 'This invitation is for a different account',
    })
    expect(await findAccessibilityViolations(wrong.container)).toEqual([])
  })

  it('invited-only user message and the 403', async () => {
    const invited = await renderAppAt('/', { signedInAs: 'invitee' })
    await screen.findByRole('heading', { level: 1, name: 'No business access right now' })
    expect(await findAccessibilityViolations(invited.container)).toEqual([])
    invited.unmount()
    const forbidden = await renderAppAt('/cashiers', { signedInAs: 'cashier' })
    await screen.findByRole('heading', { level: 1, name: 'Access denied' })
    expect(await findAccessibilityViolations(forbidden.container)).toEqual([])
  })
})
