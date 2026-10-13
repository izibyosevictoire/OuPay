import { PaymentServiceError } from '@/services/paymentServiceError'
import type { BankingConfigurationService, ProviderOverview } from '@/services/bankingService'
import {
  getAdapter,
  getCapabilities,
  PROVIDER_DESCRIPTIONS,
} from '@/services/banking/providerRegistry'
import type { BankConnection, PaymentDestination } from '@/types/banking'
import { createMockAuthStore, type MockAuthStore } from './mockAuthStore'
import { createLedgerStore, newId, type LedgerStore } from './ledger/mockLedgerStore'
import { createOperationRunner } from './mockOrganizationAccess'
import { requirePaymentActor } from './mockPaymentAccess'

interface MockBankingServiceOptions {
  authStore?: MockAuthStore
  ledger?: LedgerStore
  delayInMilliseconds?: number
}

/**
 * MOCK banking configuration. Everything linked here is a SIMULATED demo connection; the
 * result is never a verified bank connection and no real banking detail is handled. A real
 * implementation would run server-side against a bank-approved linking process.
 */
export function createMockBankingService(
  options: MockBankingServiceOptions = {},
): BankingConfigurationService {
  const store = options.authStore ?? createMockAuthStore()
  const ledger = options.ledger ?? createLedgerStore(store)
  const run = createOperationRunner(options.delayInMilliseconds ?? 450)

  const findConnection = (merchantId: string, connectionId: string): BankConnection => {
    const connection = ledger.bankConnections
      .load()
      .find((c) => c.id === connectionId && c.merchantId === merchantId)
    if (!connection)
      throw new PaymentServiceError('not_found', 'This connection could not be found.')
    return connection
  }

  const saveConnection = (updated: BankConnection) =>
    ledger.bankConnections.save(
      ledger.bankConnections.load().map((c) => (c.id === updated.id ? updated : c)),
    )

  return {
    listProviders: () =>
      run<ProviderOverview[]>(() =>
        PROVIDER_DESCRIPTIONS.map((description) => ({
          ...description,
          capabilities: getCapabilities(description.id),
        })),
      ),

    listConnections: (merchantId) =>
      run(() => {
        requirePaymentActor(store, merchantId, 'banking:manage')
        return ledger.bankConnections.load().filter((c) => c.merchantId === merchantId)
      }),

    listPaymentDestinations: (merchantId) =>
      run<PaymentDestination[]>(() => {
        requirePaymentActor(store, merchantId, 'banking:manage')
        return ledger.paymentDestinations.load().filter((d) => d.merchantId === merchantId)
      }),

    async startAccountLink(merchantId, request) {
      // Everything that can be refused up front is checked first, with the usual latency.
      await run(() => {
        requirePaymentActor(store, merchantId, 'banking:manage')
        const adapter = getAdapter(request.providerId)
        if (
          !adapter ||
          adapter.getProviderCapabilities().accountLinking !== 'SUPPORTED' ||
          !adapter.validateAccountLink
        ) {
          throw new PaymentServiceError(
            'not_supported',
            'This provider does not support account linking yet.',
          )
        }
        const nickname = request.accountNickname.trim()
        if (nickname.length < 2 || nickname.length > 60) {
          throw new PaymentServiceError(
            'validation',
            'Give the account a short name (2 to 60 characters).',
          )
        }
        if (request.accountReference.trim() === '') {
          throw new PaymentServiceError('validation', 'Enter the demo account reference.')
        }
        const alreadyLinked = ledger.bankConnections
          .load()
          .some(
            (c) =>
              c.merchantId === merchantId &&
              c.providerId === request.providerId &&
              (c.status === 'PENDING' || c.status === 'CONNECTED'),
          )
        if (alreadyLinked) {
          throw new PaymentServiceError(
            'invalid_state',
            'This provider is already linked. Disable the current connection first.',
          )
        }
        return true
      })

      const adapter = getAdapter(request.providerId)!
      const validation = await adapter.validateAccountLink!(request)
      return run(() => {
        const now = new Date().toISOString()
        const connection: BankConnection = {
          id: newId('bcn'),
          merchantId,
          providerId: request.providerId,
          status: validation.isValid ? 'PENDING' : 'ERROR',
          accountNickname: request.accountNickname.trim(),
          bankAccountId: validation.bankAccountId ?? null,
          maskedAccount: validation.maskedAccount ?? null,
          isSimulated: adapter.isSimulated,
          lastError: validation.isValid
            ? null
            : (validation.failureReason ?? 'The link could not be validated.'),
          createdAt: now,
          updatedAt: now,
        }
        ledger.bankConnections.save([...ledger.bankConnections.load(), connection])
        return connection
      })
    },

    completeAccountLink: (merchantId, connectionId) =>
      run(() => {
        requirePaymentActor(store, merchantId, 'banking:manage')
        const connection = findConnection(merchantId, connectionId)
        if (
          connection.status !== 'PENDING' ||
          !connection.bankAccountId ||
          !connection.maskedAccount
        ) {
          throw new PaymentServiceError(
            'invalid_state',
            'Only a pending connection can be completed.',
          )
        }
        const now = new Date().toISOString()
        const connected: BankConnection = { ...connection, status: 'CONNECTED', updatedAt: now }
        saveConnection(connected)
        ledger.paymentDestinations.save([
          ...ledger.paymentDestinations.load(),
          {
            id: newId('dst'),
            merchantId,
            bankConnectionId: connection.id,
            label: connection.accountNickname,
            bankAccountId: connection.bankAccountId,
            maskedAccount: connection.maskedAccount,
            providerId: connection.providerId,
            isSimulated: connection.isSimulated,
            createdAt: now,
          },
        ])
        return connected
      }),

    disableConnection: (merchantId, connectionId) =>
      run(() => {
        requirePaymentActor(store, merchantId, 'banking:manage')
        const connection = findConnection(merchantId, connectionId)
        if (connection.status === 'DISABLED') {
          throw new PaymentServiceError('invalid_state', 'This connection is already disabled.')
        }
        const disabled: BankConnection = {
          ...connection,
          status: 'DISABLED',
          updatedAt: new Date().toISOString(),
        }
        saveConnection(disabled)
        return disabled
      }),
  }
}
