/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { getActiveTestBackend, useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'
import { SAMPLE_MERCHANT_ID } from '@/services/mock/sampleMerchants'

function invoiceByNumber(number: string) {
  return getActiveTestBackend()
    .store.loadInvoices()
    .find((i) => i.invoiceNumber === number && i.merchantId === SAMPLE_MERCHANT_ID)!
}

async function openPrint(number: string, options: Parameters<typeof renderAppAt>[1] = {}) {
  const invoice = invoiceByNumber(number)
  const result = await renderAppAt(`/invoices/${invoice.id}/print`, options)
  const article = await screen.findByRole('article', { name: `Invoice ${number}` })
  return { ...result, invoice, article }
}

beforeEach(() => {
  useFastBackend()
})

describe('printable invoice', () => {
  it('shows the merchant, customer, dates, items and totals in a document layout', async () => {
    const { article } = await openPrint('SMP-INV-1044')
    const doc = within(article)
    expect(doc.getByRole('heading', { level: 1, name: 'Sample Shop' })).toBeInTheDocument()
    expect(doc.getByText('Sample Business Ltd')).toBeInTheDocument()
    expect(doc.getByText('TIN: 100000001')).toBeInTheDocument()
    expect(doc.getByText('INVOICE')).toBeInTheDocument()
    expect(doc.getByText('SMP-INV-1044')).toBeInTheDocument()
    expect(doc.getByText('Kivu Fresh Foods Ltd')).toBeInTheDocument()
    expect(doc.getByText('20 October 2026')).toBeInTheDocument()
    expect(doc.getByText(/Branch: Remera Main \(RM01\)/)).toBeInTheDocument()
    expect(doc.getByText(/Served by: Grace Mukamana/)).toBeInTheDocument()
    expect(doc.getByRole('row', { name: /Catering supplies/ })).toHaveTextContent(/660,800/)
    expect(article).toHaveTextContent(/Total\s*RWF\s*708,000/)
    expect(doc.getByText(/Payment: Unpaid/)).toBeInTheDocument()
    expect(doc.getByText('(bank-confirmed payments only)')).toBeInTheDocument()
  })

  it('carries the disclaimer that it is not an official RRA EBM/EIS invoice', async () => {
    const { article } = await openPrint('SMP-INV-1044')
    expect(article).toHaveTextContent(/not an official RRA EBM\/EIS tax invoice/)
    expect(article).toHaveTextContent(/no fiscal signature or verification code/)
  })

  it('invents no fiscal identifiers, signatures, QR codes or receipt numbers', async () => {
    const { article } = await openPrint('SMP-INV-1044')
    const withoutDisclaimer = (article.textContent ?? '').replace(
      /This is a commercial invoice[\s\S]*?bank-confirmed payments\./,
      '',
    )
    for (const pattern of [
      /\bSDC\b/i,
      /receipt (no|number)/i,
      /fiscal (id|number|code)/i,
      /\bMRC\b/i,
      /\bQR\b/i,
      /signature/i,
      /verification code/i,
      /EBM/i,
    ]) {
      expect(withoutDisclaimer).not.toMatch(pattern)
    }
    expect(article.querySelector('img, canvas, svg:not([aria-hidden])')).toBeNull()
  })

  it('marks drafts, cancelled and voided invoices so they cannot pass for live ones', async () => {
    const marks: [string, string][] = [
      ['SMP-INV-1040', 'DRAFT: NOT ISSUED'],
      ['SMP-INV-1045', 'CANCELLED'],
      ['SMP-INV-1046', 'VOID'],
    ]
    for (const [number, mark] of marks) {
      const { article, unmount } = await openPrint(number)
      expect(article).toHaveTextContent(mark)
      unmount()
    }
    const issued = await openPrint('SMP-INV-1044')
    expect(issued.article).not.toHaveTextContent(/DRAFT|CANCELLED|VOID/)
  })

  it('shows the void reason on a voided invoice', async () => {
    const { article } = await openPrint('SMP-INV-1046')
    expect(article).toHaveTextContent('Void reason: Issued to the wrong customer')
  })

  it('prints through the browser, with a screen-only toolbar and no app chrome', async () => {
    const user = userEvent.setup()
    const print = vi.spyOn(window, 'print').mockImplementation(() => {})
    const { invoice } = await openPrint('SMP-INV-1044')
    const printButton = screen.getByRole('button', { name: 'Print' })
    expect(printButton.parentElement?.className).toContain('print:hidden')
    expect(screen.getByRole('link', { name: /Back to invoice/ })).toHaveAttribute(
      'href',
      `/invoices/${invoice.id}`,
    )
    await user.click(printButton)
    expect(print).toHaveBeenCalledTimes(1)
    // No sidebar, header or navigation: what is on screen is what prints.
    expect(screen.queryByRole('navigation')).not.toBeInTheDocument()
    expect(document.querySelector('aside')).toBeNull()
  })

  it('has print CSS for A4 pages, hides screen chrome, and avoids splitting tables', () => {
    const css = readFileSync(resolve(import.meta.dirname, '../../styles/globals.css'), 'utf8')
    const printBlock = css.slice(css.indexOf('@media print'))
    expect(printBlock).toContain('size: A4')
    expect(printBlock).toMatch(/background:\s*#fff/)
    expect(printBlock).toContain('break-inside: avoid')
  })

  it('applies the same access rules as the details page', async () => {
    const own = await openPrint('SMP-INV-1043', { signedInAs: 'cashier' })
    expect(own.article).toBeInTheDocument()
    own.unmount()
    const others = invoiceByNumber('SMP-INV-1044')
    await renderAppAt(`/invoices/${others.id}/print`, { signedInAs: 'cashier' })
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Invoice not found' }),
    ).toBeInTheDocument()
  })

  it('shows a loading state and an error state', async () => {
    const { invoiceService } = await import('@/services')
    vi.mocked(invoiceService.getInvoice).mockImplementation(() => new Promise(() => {}))
    const loading = await renderAppAt('/invoices/anything/print')
    expect((await screen.findAllByRole('status'))[0]).toHaveTextContent('Loading')
    loading.unmount()
    vi.mocked(invoiceService.getInvoice).mockRejectedValue(new Error('down'))
    await renderAppAt('/invoices/anything/print')
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be loaded')
  })
})
