export const MEBIBYTE = 1024 * 1024

/**
 * Security-Aで確定した共通上限です。
 * この段階では既存処理へ適用せず、後続Security-B〜Fの実装元として利用します。
 */
export const SECURITY_LIMITS = Object.freeze({
  linkRequestConcurrencyPerRun: 8,
  linkRequestConcurrencyPerOrigin: 4,
  runResultHardBytes: 50 * MEBIBYTE,
  runResultOperationalBudgetBytes: 48 * MEBIBYTE,
  excelUploadBytes: 20 * MEBIBYTE,
  aiResultUploadBytes: 5 * MEBIBYTE,
  runEventsBytes: 10 * MEBIBYTE,
  linkCandidatesPerPage: 2_000,
  imageCandidatesPerDevice: 2_000,
} as const)

export const SECURITY_ERROR_CODES = Object.freeze({
  invalidUrl: 'SECURITY_URL_INVALID',
  unsupportedUrlProtocol: 'SECURITY_URL_PROTOCOL_UNSUPPORTED',
  urlUserinfoDetected: 'SECURITY_URL_USERINFO_DETECTED',
  urlIdentityKeyMissing: 'SECURITY_URL_IDENTITY_KEY_MISSING',
  urlIdentityKeyInvalid: 'SECURITY_URL_IDENTITY_KEY_INVALID',
  urlIdentityKeyExists: 'SECURITY_URL_IDENTITY_KEY_EXISTS',
  urlIdentityKeyIoFailed: 'SECURITY_URL_IDENTITY_KEY_IO_FAILED',
  requestHostRejected: 'SECURITY_REQUEST_HOST_REJECTED',
  requestOriginRejected: 'SECURITY_REQUEST_ORIGIN_REJECTED',
  csrfRejected: 'SECURITY_CSRF_REJECTED',
  ssrfBlocked: 'SECURITY_SSRF_BLOCKED',
  dnsRebindingDetected: 'SECURITY_DNS_REBINDING_DETECTED',
  redirectBlocked: 'SECURITY_REDIRECT_BLOCKED',
  requestTooLarge: 'SECURITY_REQUEST_TOO_LARGE',
  resultTooLarge: 'SECURITY_RESULT_TOO_LARGE',
  eventLogTooLarge: 'SECURITY_EVENT_LOG_TOO_LARGE',
  candidateLimitReached: 'SECURITY_CANDIDATE_LIMIT_REACHED',
  concurrencyLimitReached: 'SECURITY_CONCURRENCY_LIMIT_REACHED',
} as const)

export type SecurityErrorCode = typeof SECURITY_ERROR_CODES[keyof typeof SECURITY_ERROR_CODES]

export class SecurityFoundationError extends Error {
  constructor(
    readonly code: SecurityErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'SecurityFoundationError'
  }
}
