import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import jsQR from 'jsqr'
import { paymentProfileService } from '@/services'
import { SAMPLE_MERCHANT_ID } from '@/services/mock/sampleMerchants'
import { getActiveTestBackend, useFastBackend } from '@/test/merchantTestDouble'
import { renderAppAt } from '@/test/renderApp'

const SHOP_URL = 'https://pay.oupay.rw/p/Rk4mQ8vTz2Xn'

beforeEach(() => {
  useFastBackend()
})

/** Rasterises the on-screen SVG exactly as drawn, so a real QR decoder can read it back. */
function decodeQr(svg: Element): string | null {
  const [, , width = 0] = (svg.getAttribute('viewBox') ?? '').split(' ').map(Number)
  const scale = 6
  const pixels = new Uint8ClampedArray(width * scale * width * scale * 4).fill(255)
  const d = svg.querySelector('path')!.getAttribute('d')!
  for (const match of d.matchAll(/M(\d+) (\d+)h1v1h-1z/g)) {
    const [x, y] = [Number(match[1]), Number(match[2])]
    for (let dy = 0; dy < scale; dy += 1) {
      for (let dx = 0; dx < scale; dx += 1) {
        const offset = ((y * scale + dy) * width * scale + (x * scale + dx)) * 4
        pixels[offset] = pixels[offset + 1] = pixels[offset + 2] = 0
      }
    }
  }
  return jsQR(pixels, width * scale, width * scale)?.data ?? null
}

const qrOf = () => document.querySelector('svg[data-qr-value]')!

describe('payment links list', () => {
  it('lists the business links with status, branch, cashier and destination', async () => {
    await renderAppAt('/payment-links')
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Payment links' }),
    ).toBeInTheDocument()
    const shop = (await screen.findByRole('link', { name: 'Shop counter' })).closest('li')!
    expect(within(shop).getByText('Active')).toBeInTheDocument()
    expect(within(shop).getByText(SHOP_URL)).toBeInTheDocument()
    expect(within(shop).getByText(/Whole business/)).toBeInTheDocument()
    const off = screen.getByRole('link', { name: 'City Centre counter' }).closest('li')!
    expect(within(off).getByText('Switched off')).toBeInTheDocument()
    const replaced = screen.getByRole('link', { name: 'Old shop counter link' }).closest('li')!
    expect(within(replaced).getByText('Replaced')).toBeInTheDocument()
    // Demo links are always labelled as simulated.
    expect(within(shop).getByText('Simulated')).toBeInTheDocument()
  })

  it('creates a link from the dialog and validates the choices', async () => {
    const user = userEvent.setup()
    await renderAppAt('/payment-links')
    await user.click(await screen.findByRole('button', { name: /New link/ }))
    const dialog = await screen.findByRole('dialog', { name: 'New payment link' })
    await user.type(await within(dialog).findByLabelText(/^Name/), 'Terrace table 4')
    await user.selectOptions(within(dialog).getByLabelText(/^Branch/), 'Remera Main')
    await user.click(within(dialog).getByRole('button', { name: 'Create link' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(await screen.findByRole('link', { name: 'Terrace table 4' })).toBeInTheDocument()
  })

  it('shows a link-creation error without closing the dialog', async () => {
    const user = userEvent.setup()
    await renderAppAt('/payment-links')
    await user.click(await screen.findByRole('button', { name: /New link/ }))
    const dialog = await screen.findByRole('dialog', { name: 'New payment link' })
    await within(dialog).findByLabelText(/^Name/)
    await user.click(within(dialog).getByRole('button', { name: 'Create link' }))
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/short name/)
  })

  it('shows a cashier only their own link and no way to create one', async () => {
    await renderAppAt('/payment-links', { signedInAs: 'cashier' })
    expect(await screen.findByRole('link', { name: 'Aline at Remera Main' })).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Shop counter' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /New link/ })).not.toBeInTheDocument()
    expect(screen.getByText('QR codes and NFC links assigned to you.')).toBeInTheDocument()
  })

  it('shows a cashier "not found" for a link that is not theirs', async () => {
    await renderAppAt('/payment-links/pp-sample-001', { signedInAs: 'cashier' })
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Payment link not found' }),
    ).toBeInTheDocument()
  })

  it('shows an empty state and an error state', async () => {
    const listProfiles = vi.mocked(paymentProfileService.listProfiles)
    listProfiles.mockResolvedValueOnce([])
    const empty = await renderAppAt('/payment-links')
    expect(await screen.findByText('No payment links yet')).toBeInTheDocument()
    empty.unmount()
    listProfiles.mockRejectedValue(new Error('boom'))
    await renderAppAt('/payment-links')
    expect(await screen.findByText('Payment links could not be loaded.')).toBeInTheDocument()
  })
})

describe('payment link details: QR code', () => {
  it('draws a QR code that decodes to exactly the displayed payment URL', async () => {
    await renderAppAt('/payment-links/pp-sample-001')
    await screen.findByRole('heading', { level: 1, name: 'Shop counter' })
    const svg = qrOf()
    expect(svg).toHaveAttribute('data-qr-value', SHOP_URL)
    expect(decodeQr(svg)).toBe(SHOP_URL)
    expect(screen.getByTestId('payment-url')).toHaveTextContent(SHOP_URL)
    expect(svg).toHaveAccessibleName(`QR code for Shop counter: ${SHOP_URL}`)
    // The QR contains no banking detail or internal ID, only the public link.
    expect(decodeQr(svg)).not.toMatch(/bacc-|dst-|mrc-|pp-sample|••••/)
  })

  it('copies the exact URL', async () => {
    const user = userEvent.setup()
    await renderAppAt('/payment-links/pp-sample-001')
    await user.click(await screen.findByRole('button', { name: /Copy link/ }))
    expect(await navigator.clipboard.readText()).toBe(SHOP_URL)
    expect(await screen.findByText('Link copied.')).toBeInTheDocument()
  })

  it('offers a PNG download and a print view', async () => {
    await renderAppAt('/payment-links/pp-sample-001')
    expect(await screen.findByRole('button', { name: /Download PNG/ })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Print QR code/ })).toHaveAttribute(
      'href',
      '/payment-links/pp-sample-001/print',
    )
    expect(screen.getByRole('link', { name: /Open customer page/ })).toHaveAttribute(
      'href',
      '/p/Rk4mQ8vTz2Xn',
    )
  })

  it('prints a sign with the merchant name and a QR code for the same URL', async () => {
    await renderAppAt('/payment-links/pp-sample-001/print')
    const sign = await screen.findByRole('article', { name: /Payment sign for Shop counter/ })
    expect(within(sign).getByRole('heading', { level: 1, name: 'Sample Shop' })).toBeInTheDocument()
    expect(decodeQr(qrOf())).toBe(SHOP_URL)
    expect(within(sign).getByText(/DEMO/)).toBeInTheDocument()
  })

  it('refuses to print an inactive link', async () => {
    await renderAppAt('/payment-links/pp-sample-003/print')
    expect(await screen.findByRole('alert')).toHaveTextContent(/not active/)
    expect(document.querySelector('svg[data-qr-value]')).toBeNull()
  })
})

describe('payment link details: NFC', () => {
  it('prepares the NDEF URL record and explains the tag requirements, without claiming hardware support', async () => {
    const user = userEvent.setup()
    await renderAppAt('/payment-links/pp-sample-001')
    const section = (await screen.findByRole('heading', { name: 'NFC tag' })).closest(
      'div',
    )!.parentElement!
    expect(within(section).getByText(/Well-known URI/)).toBeInTheDocument()
    expect(within(section).getByText(SHOP_URL)).toBeInTheDocument()
    expect(within(section).getByText(/NTAG213/)).toBeInTheDocument()
    expect(within(section).getByText(/Lock the tag/)).toBeInTheDocument()
    expect(within(section).getByText(/cannot scan or write NFC hardware/)).toBeInTheDocument()
    expect(within(section).getByText(/never trusted as proof/)).toBeInTheDocument()
    await user.click(within(section).getByRole('button', { name: /Copy URL for NFC writing/ }))
    expect(await navigator.clipboard.readText()).toBe(SHOP_URL)
  })
})

describe('payment link lifecycle', () => {
  it('switches a link off and on after confirmation, and the public page follows', async () => {
    const user = userEvent.setup()
    const { router } = await renderAppAt('/payment-links/pp-sample-001')
    await user.click(await screen.findByRole('button', { name: 'Switch off' }))
    const dialog = await screen.findByRole('dialog', { name: 'Switch this link off?' })
    await user.click(within(dialog).getByRole('button', { name: 'Switch off' }))
    expect(await screen.findByText('Switched off')).toBeInTheDocument()
    expect(await getActiveTestBackend().fastPublic.getProfile('Rk4mQ8vTz2Xn')).toMatchObject({
      status: 'UNAVAILABLE',
    })
    await router.navigate('/p/Rk4mQ8vTz2Xn')
    expect(await screen.findByText('This payment link is not available')).toBeInTheDocument()

    await router.navigate('/payment-links/pp-sample-001')
    await user.click(await screen.findByRole('button', { name: 'Switch on' }))
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Switch this link on?' })).getByRole(
        'button',
        {
          name: 'Switch on',
        },
      ),
    )
    expect(await screen.findByText('The link is switched on.')).toBeInTheDocument()
  })

  it('leaves a link as it was when the confirmation is dismissed', async () => {
    const user = userEvent.setup()
    await renderAppAt('/payment-links/pp-sample-001')
    await user.click(await screen.findByRole('button', { name: 'Switch off' }))
    await user.click(
      within(await screen.findByRole('dialog')).getByRole('button', { name: 'Cancel' }),
    )
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect((await getActiveTestBackend().fastPublic.getProfile('Rk4mQ8vTz2Xn')).status).toBe(
      'ACTIVE',
    )
  })

  it('replaces a link: the old URL dies and the replacement gets its own QR code', async () => {
    const user = userEvent.setup()
    const { router } = await renderAppAt('/payment-links/pp-sample-001')
    await user.click(await screen.findByRole('button', { name: 'Replace link' }))
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Replace this link?' })).getByRole(
        'button',
        {
          name: 'Replace link',
        },
      ),
    )
    expect(
      await screen.findByText('A new link was created. The old one no longer works.'),
    ).toBeInTheDocument()
    // The old link is now replaced and has no QR code any more.
    await waitFor(() => expect(document.querySelector('svg[data-qr-value]')).toBeNull())
    expect(screen.getByText('Replaced')).toBeInTheDocument()
    const replacement = getActiveTestBackend()
      .ledger.paymentProfiles.load()
      .find((p) => p.id !== 'pp-sample-001' && p.label === 'Shop counter' && p.status === 'ACTIVE')!
    expect(replacement.paymentProfileId).not.toBe('Rk4mQ8vTz2Xn')

    await router.navigate('/p/Rk4mQ8vTz2Xn')
    expect(await screen.findByText('This payment link is not available')).toBeInTheDocument()
    await router.navigate(`/payment-links/${replacement.id}`)
    await screen.findByRole('heading', { level: 1, name: 'Shop counter' })
    expect(decodeQr(qrOf())).toBe(`https://pay.oupay.rw/p/${replacement.paymentProfileId}`)
  })

  it('never offers to switch a replaced link back on', async () => {
    await renderAppAt('/payment-links/pp-sample-004')
    await screen.findByRole('heading', { level: 1, name: 'Old shop counter link' })
    expect(screen.queryByRole('button', { name: 'Switch on' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Replace link' })).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: /View the replacement link/ })).toHaveAttribute(
      'href',
      '/payment-links/pp-sample-001',
    )
  })

  it('hides management actions from a cashier looking at their own link', async () => {
    await renderAppAt('/payment-links/pp-sample-002', { signedInAs: 'cashier' })
    await screen.findByRole('heading', { level: 1, name: 'Aline at Remera Main' })
    expect(screen.queryByRole('button', { name: 'Switch off' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Replace link' })).not.toBeInTheDocument()
    expect(qrOf()).toBeInTheDocument()
  })

  it('uses a configurable base URL', async () => {
    vi.stubEnv('VITE_PUBLIC_PAYMENT_BASE_URL', 'https://pay.example.test/')
    await renderAppAt('/payment-links/pp-sample-001')
    await screen.findByRole('heading', { level: 1, name: 'Shop counter' })
    expect(decodeQr(qrOf())).toBe('https://pay.example.test/p/Rk4mQ8vTz2Xn')
    vi.unstubAllEnvs()
  })

  it('keeps another business out of reach', async () => {
    await renderAppAt(`/payment-links/pp-sample-101`)
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Payment link not found' }),
    ).toBeInTheDocument()
    expect(SAMPLE_MERCHANT_ID).toBeTruthy()
  })
})
