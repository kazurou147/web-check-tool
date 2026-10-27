import { randomBytes, timingSafeEqual } from 'node:crypto'

const CSRF_TOKEN_BYTES = 32
let token: string | undefined

export function getCsrfToken(): string {
  token ??= randomBytes(CSRF_TOKEN_BYTES).toString('base64url')
  return token
}

export function verifyCsrfToken(candidate: string | undefined): boolean {
  if (!candidate) return false
  const expected = Buffer.from(getCsrfToken())
  const actual = Buffer.from(candidate)
  return expected.length === actual.length && timingSafeEqual(expected, actual)
}
