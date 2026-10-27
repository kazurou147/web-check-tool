import type { FetchOptions } from 'ofetch'
import { $fetch as rawFetch } from 'ofetch'

let csrfTokenPromise: Promise<string> | undefined

export async function secureFetch<T>(request: string, options: FetchOptions = {}): Promise<T> {
  const method = String(options.method ?? 'GET').toUpperCase()
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
    return await rawFetch(request, options) as T
  }
  const token = await loadCsrfToken()
  const headers = new Headers(options.headers as HeadersInit | undefined)
  headers.set('x-web-check-csrf', token)
  try {
    return await rawFetch(request, { ...options, headers }) as T
  } catch (error) {
    const code = (error as { data?: { data?: { code?: string }; code?: string } }).data?.data?.code
      ?? (error as { data?: { code?: string } }).data?.code
    if (code !== 'SECURITY_CSRF_REJECTED') throw error
    csrfTokenPromise = undefined
    headers.set('x-web-check-csrf', await loadCsrfToken())
    return await rawFetch(request, { ...options, headers }) as T
  }
}

export function resetCsrfTokenForTests(): void {
  csrfTokenPromise = undefined
}

async function loadCsrfToken(): Promise<string> {
  csrfTokenPromise ??= rawFetch('/api/security/csrf').then(response => (response as { token: string }).token)
  try {
    return await csrfTokenPromise
  } catch (error) {
    csrfTokenPromise = undefined
    throw error
  }
}
