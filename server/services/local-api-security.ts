import { SECURITY_ERROR_CODES, type SecurityErrorCode } from '~/shared/security/security-constants'

export const CSRF_HEADER = 'x-web-check-csrf'
const MUTATION_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

const JSON_BODY_PATHS = [
  /^\/api\/projects$/,
  /^\/api\/projects\/[0-9a-f-]+$/,
  /^\/api\/projects\/[0-9a-f-]+\/runs\/[0-9a-f-]+\/rerun$/,
]
const MULTIPART_BODY_PATHS = [
  /^\/api\/projects\/[0-9a-f-]+\/excel$/,
  /^\/api\/projects\/[0-9a-f-]+\/runs\/[0-9a-f-]+\/ai\/import$/,
]

export interface LocalApiRequestMetadata {
  method: string
  path: string
  host?: string
  origin?: string
  fetchSite?: string
  contentType?: string
  contentLength?: string
  csrfToken?: string
}

export interface LocalApiSecurityFailure {
  statusCode: 403 | 415
  code: SecurityErrorCode
  message: string
}

export function validateLocalApiRequest(
  request: LocalApiRequestMetadata,
  verifyCsrf: (candidate: string | undefined) => boolean,
): LocalApiSecurityFailure | undefined {
  const host = request.host?.trim().toLowerCase()
  if (!host || !isLoopbackHost(host)) {
    return failure(SECURITY_ERROR_CODES.requestHostRejected, 'このAPIは127.0.0.1からのみ利用できます。')
  }
  const expectedOrigin = `http://${host}`
  if (request.origin && normalizeOrigin(request.origin) !== expectedOrigin) {
    return failure(SECURITY_ERROR_CODES.requestOriginRejected, '別OriginからのAPI操作を拒否しました。')
  }
  const method = request.method.toUpperCase()
  const mutation = MUTATION_METHODS.has(method)
  if (mutation && !request.origin) {
    return failure(SECURITY_ERROR_CODES.requestOriginRejected, '変更APIには同一OriginのOriginヘッダーが必要です。')
  }
  if (request.fetchSite && !['same-origin', 'none'].includes(request.fetchSite.toLowerCase())) {
    return failure(SECURITY_ERROR_CODES.fetchMetadataRejected, 'クロスサイトのAPI操作を拒否しました。')
  }
  if (mutation && !verifyCsrf(request.csrfToken)) {
    return failure(SECURITY_ERROR_CODES.csrfRejected, 'CSRFトークンが不正または不足しています。')
  }
  if (!mutation) return undefined

  const contentType = request.contentType?.split(';', 1)[0]?.trim().toLowerCase() ?? ''
  if (JSON_BODY_PATHS.some(pattern => pattern.test(request.path))) {
    if (contentType !== 'application/json') return unsupported('JSON形式のリクエストが必要です。')
  } else if (MULTIPART_BODY_PATHS.some(pattern => pattern.test(request.path))) {
    if (contentType !== 'multipart/form-data') return unsupported('multipart/form-data形式のリクエストが必要です。')
  } else if (contentType || Number(request.contentLength ?? '0') > 0) {
    return unsupported('このAPIはリクエスト本文を受け付けません。')
  }
  return undefined
}

function isLoopbackHost(host: string): boolean {
  const match = /^127\.0\.0\.1(?::(\d{1,5}))?$/.exec(host)
  if (!match) return false
  return !match[1] || Number(match[1]) <= 65_535
}

function normalizeOrigin(value: string): string {
  try {
    const url = new URL(value)
    return `${url.protocol}//${url.host}`.toLowerCase()
  } catch {
    return ''
  }
}

function failure(code: SecurityErrorCode, message: string): LocalApiSecurityFailure {
  return { statusCode: 403, code, message }
}

function unsupported(message: string): LocalApiSecurityFailure {
  return { statusCode: 415, code: SECURITY_ERROR_CODES.contentTypeRejected, message }
}
