import { render, screen, within } from '@testing-library/react'
import { posService } from '@/services'
import { useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'
import type { PosFulfilmentException, PosFulfilmentView } from '@/types/pos'
import { FulfilmentSection } from './PosFulfilment'

const view = (over: Partial<PosFulfilmentView> = {}): PosFulfilmentView => ({
  paymentState: 'UNPAID',
  appliedRwf: 0,
  totalRwf: 9_740,
  inventoryState: 'NOT_POSTED',
  postedAt: null,
  attempts: 0,
  nextAttemptAt: null,
  lastError: null,
  lines: [],
  exceptions: [],
  events: [],
  handover: 'NOT_TRACKED',
  note: 'Posting records the stock deduction only. Handing the goods over is not recorded yet.',
  ...over,
})

const exception = (over: Partial<PosFulfilmentException> = {}): PosFulfilmentException => ({
  id: 'e-1',
  saleId: 'sale-1',
  saleReference: 'OP-ABC12345',
  invoiceNumber: 'INV-0007',
  kind: 'RESERVATION_RELEASED',
  status: 'OPEN',
  detail: 'The sale was paid in full after its stock reservation was released.',
  openedAt: '2026-10-29T08:00:00Z',
  history: [],
  ...over,
})

beforeEach(() => {
  useFastBackend()
})

describe('payment and stock of a sale (R7c)', () => {
  it('keeps payment, inventory and handover apart: paid is not deducted, and nothing is ever "delivered"', () => {
    render(
      <FulfilmentSection
        fulfilment={view({ paymentState: 'PAID', appliedRwf: 9_740 })}
        demo={false}
      />,
    )
    const section = screen.getByRole('region', { name: 'Payment and stock' })
    expect(
      within(section).getByText(/Paid in full: bank-verified money was matched/),
    ).toBeInTheDocument()
    expect(within(section).getByText(/Stock not deducted yet/)).toBeInTheDocument()
    expect(within(section).getByText(/Not recorded\./)).toBeInTheDocument()
    expect(section.textContent ?? '').not.toMatch(
      /delivered|handed over to the customer|fulfilled/i,
    )
  })

  it('shows what was deducted and what is physically left, without claiming handover', () => {
    render(
      <FulfilmentSection
        demo={false}
        fulfilment={view({
          paymentState: 'PAID',
          appliedRwf: 9_740,
          inventoryState: 'POSTED',
          postedAt: '2026-10-29T08:00:00Z',
          lines: [
            {
              itemId: 'i-1',
              name: 'Rice',
              quantityDeducted: '2000',
              canonicalUnit: 'g',
              movementId: 'm-1',
              physicalNow: '8000',
              availableNow: '6000',
            },
          ],
        })}
      />,
    )
    expect(screen.getByText(/Stock deducted/)).toBeInTheDocument()
    expect(screen.getByText(/the stock ledger was updated/)).toBeInTheDocument()
    const lines = within(screen.getByRole('list', { name: 'Stock deducted' }))
    expect(
      lines.getByText(/Rice: 2 kg deducted · physical now 8 kg · available now 6 kg/),
    ).toBeInTheDocument()
    expect(screen.getByText(/Not recorded\./)).toBeInTheDocument()
  })

  it('says a partial payment deducts nothing, and a reversal means nothing verified is applied', () => {
    const { rerender } = render(
      <FulfilmentSection
        fulfilment={view({ paymentState: 'PARTIAL', appliedRwf: 4_000 })}
        demo={false}
      />,
    )
    expect(
      screen.getByText(/Partly paid: RWF\s?4,000 of RWF\s?9,740 verified and matched/),
    ).toBeInTheDocument()
    expect(screen.getByText(/deducted only when it is paid in full/)).toBeInTheDocument()
    rerender(<FulfilmentSection fulfilment={view({ paymentState: 'REVERSED' })} demo={false} />)
    expect(
      screen.getByText(/reversed by the bank. Nothing verified is applied now/),
    ).toBeInTheDocument()
  })

  it('explains an exception on the sale: paid, but the stock was not deducted', () => {
    render(
      <FulfilmentSection
        demo={false}
        fulfilment={view({
          paymentState: 'PAID',
          inventoryState: 'EXCEPTION',
          exceptions: [exception()],
        })}
      />,
    )
    expect(screen.getByText(/Stock was NOT deducted/)).toBeInTheDocument()
    const list = within(screen.getByRole('list', { name: 'Fulfilment exceptions' }))
    expect(list.getByText('Paid after its stock reservation was released')).toBeInTheDocument()
  })

  it('shows services-only sales as needing no stock, and a demonstration as having no real effect', () => {
    const { rerender } = render(
      <FulfilmentSection
        fulfilment={view({ paymentState: 'PAID', inventoryState: 'NOT_REQUIRED' })}
        demo={false}
      />,
    )
    expect(screen.getByText(/No goods in this sale: nothing to deduct/)).toBeInTheDocument()
    rerender(
      <FulfilmentSection
        demo
        fulfilment={view({
          paymentState: 'NOT_APPLICABLE',
          inventoryState: 'NOT_APPLICABLE',
          note: 'DEMONSTRATION: no real payment, stock reservation, stock deduction or fulfilment exists for this bill.',
        })}
      />,
    )
    expect(
      screen.getByText(
        /DEMONSTRATION: no real payment, stock reservation, stock deduction or fulfilment/,
      ),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Stock deducted|Paid in full/)).not.toBeInTheDocument()
  })
})

describe('the owner’s list of paid sales that need attention (R7c)', () => {
  it('shows each open exception read-only to the owner, whether or not the owner bills', async () => {
    vi.spyOn(posService, 'listFulfilmentExceptions').mockResolvedValue([exception()])
    await renderAppAt('/pos', { signedInAs: 'owner' })
    const list = within(await screen.findByRole('list', { name: 'Open fulfilment exceptions' }))
    expect(list.getByText('INV-0007 · OP-ABC12345')).toBeInTheDocument()
    expect(list.getByText('Paid after its stock reservation was released')).toBeInTheDocument()
    expect(
      screen.getByText(/Read-only\. The payment stays verified and applied/),
    ).toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: /resolve|re-reserve|deduct/i }),
    ).not.toBeInTheDocument()
  })

  it('says so when nothing is waiting, and is not offered to a cashier or manager', async () => {
    await renderAppAt('/pos', { signedInAs: 'owner' })
    expect(await screen.findByText('No paid sale is waiting for a decision.')).toBeInTheDocument()
  })

  it('is not shown, and not even requested, for a manager', async () => {
    const spy = vi.spyOn(posService, 'listFulfilmentExceptions')
    await renderAppAt('/pos', { signedInAs: 'manager' })
    await screen.findByRole('heading', { level: 1, name: 'POS billing' })
    expect(screen.queryByText('Paid sales that need attention')).not.toBeInTheDocument()
    expect(spy).not.toHaveBeenCalled()
  })
})
