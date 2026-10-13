import { HttpApiError } from './httpClient'

/**
 * Turns a server error into the error type a service contract promises. Codes the contract knows keep
 * their meaning; anything else becomes `service_unavailable`, so the UI never sees a surprise code.
 * A 501 from the server means "not built yet" and is reported honestly as unavailable.
 */
export function mapHttpError<E extends Error>(
  error: unknown,
  make: (code: never, message: string) => E,
  knownCodes: readonly string[],
): never {
  if (error instanceof HttpApiError) {
    const code = knownCodes.includes(error.code) ? error.code : 'service_unavailable'
    const message =
      error.code === 'not_implemented'
        ? 'This feature is not available on the server yet.'
        : error.message
    throw make(code as never, message)
  }
  throw error
}

/** Wraps a service method so every failure is translated. */
export function translating<A extends unknown[], R>(
  action: (...args: A) => Promise<R>,
  translate: (error: unknown) => never,
): (...args: A) => Promise<R> {
  return async (...args) => {
    try {
      return await action(...args)
    } catch (error) {
      return translate(error)
    }
  }
}
