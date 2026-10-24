export class RunCanceledError extends Error {
  constructor() {
    super('検査がキャンセルされました。')
    this.name = 'AbortError'
  }
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new RunCanceledError()
}

export function isAbortError(error: unknown): boolean {
  return error instanceof RunCanceledError
    || (error instanceof Error && error.name === 'AbortError')
}

export async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  if (!signal) {
    await new Promise(resolve => setTimeout(resolve, milliseconds))
    return
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, milliseconds)
    function done() {
      signal?.removeEventListener('abort', aborted)
      resolve()
    }
    function aborted() {
      clearTimeout(timer)
      reject(new RunCanceledError())
    }
    signal.addEventListener('abort', aborted, { once: true })
  })
}
