/** Mimics API latency so loading states are exercised during development. */
export function simulateNetworkDelay<T>(value: T, delayInMilliseconds = 350): Promise<T> {
  return new Promise((resolve) =>
    setTimeout(() => resolve(structuredClone(value)), delayInMilliseconds),
  )
}
