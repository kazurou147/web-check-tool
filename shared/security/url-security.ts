import { SECURITY_ERROR_CODES, SecurityFoundationError } from './security-constants'

export const URL_REDACTION_MARKER = '[REDACTED]'
export const URL_MASKING_RULE_VERSION = 'url-security.1'
export const URL_MASKING_NOTICE = 'URLの自動マスキングは、すべての秘密情報を検出できることを保証しません。共有・出力前に内容を確認してください。'

const SENSITIVE_SINGLE_PARTS = new Set([
  'token',
  'key',
  'secret',
  'auth',
  'authorization',
  'password',
  'passwd',
  'session',
  'sessionid',
  'sid',
  'cookie',
  'cid',
  'signature',
  'sig',
  'credential',
  'policy',
])

const SENSITIVE_COMBINATIONS = new Set([
  'apikey',
  'accesstoken',
  'refreshtoken',
])

export interface UrlSecretInspection {
  hasUserinfo: boolean
  sensitiveQueryNames: string[]
  hasDetectedSecrets: boolean
}

export interface MaskedDisplayUrl {
  value: string
  ruleVersion: typeof URL_MASKING_RULE_VERSION
  maskedCount: number
  maskedCategories: Array<'url_userinfo' | 'url_query_secret'>
  hadUserinfo: boolean
  sensitiveQueryNames: string[]
  notice: typeof URL_MASKING_NOTICE
}

/** URLを変更せず、検出可能なuserinfoと秘密クエリ名だけを調べます。 */
export function inspectUrlSecrets(value: string): UrlSecretInspection {
  const url = parseUrl(value)
  const sensitiveQueryNames = [...new Set(
    [...url.searchParams.keys()].filter(isSensitiveQueryName),
  )]
  const hasUserinfo = Boolean(url.username || url.password)
  return {
    hasUserinfo,
    sensitiveQueryNames,
    hasDetectedSecrets: hasUserinfo || sensitiveQueryNames.length > 0,
  }
}

/**
 * 表示・保存候補用の新しいURL文字列を返します。入力文字列や呼出側のURLは変更しません。
 * HTTP/HTTPS以外も解析できますが、userinfoと秘密クエリ以外は保持します。
 */
export function maskUrlForDisplay(value: string): MaskedDisplayUrl {
  const url = parseUrl(value)
  const inspection = inspectParsedUrl(url)
  let maskedCount = 0
  const categories = new Set<MaskedDisplayUrl['maskedCategories'][number]>()

  if (url.username) {
    url.username = URL_REDACTION_MARKER
    maskedCount += 1
    categories.add('url_userinfo')
  }
  if (url.password) {
    url.password = URL_REDACTION_MARKER
    maskedCount += 1
    categories.add('url_userinfo')
  }
  const parameters = [...url.searchParams.entries()]
  url.search = ''
  for (const [key, value] of parameters) {
    const sensitive = isSensitiveQueryName(key)
    url.searchParams.append(key, sensitive ? URL_REDACTION_MARKER : value)
    if (sensitive) {
      maskedCount += 1
      categories.add('url_query_secret')
    }
  }

  return {
    value: url.href,
    ruleVersion: URL_MASKING_RULE_VERSION,
    maskedCount,
    maskedCategories: [...categories].sort(),
    hadUserinfo: inspection.hasUserinfo,
    sensitiveQueryNames: inspection.sensitiveQueryNames,
    notice: URL_MASKING_NOTICE,
  }
}

/** 既存のExcel URL正規化と同じく、HTTP/HTTPSを検証してフラグメントだけを除去します。 */
export function normalizeHttpUrlForIdentity(value: string): string {
  const url = parseUrl(value)
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SecurityFoundationError(
      SECURITY_ERROR_CODES.unsupportedUrlProtocol,
      'HTTP/HTTPS以外のURLは識別できません。',
    )
  }
  url.hash = ''
  return url.href
}

export function hasUrlUserinfo(value: string): boolean {
  const url = parseUrl(value)
  return Boolean(url.username || url.password)
}

export function isSensitiveQueryName(value: string): boolean {
  const parts = splitQueryName(value)
  if (parts.some(part => SENSITIVE_SINGLE_PARTS.has(part))) return true
  const combined = parts.join('')
  return SENSITIVE_COMBINATIONS.has(combined)
}

/** 表示してよい単純なtel URLだけを許可し、パラメータや不審な文字列を除外します。 */
export function displaySafeTelNumber(value: string): string | undefined {
  const matched = /^tel:(\+?[0-9](?:[0-9(). -]*[0-9])?)$/iu.exec(value)
  if (!matched) return undefined
  const number = matched[1]!
  const normalized = number.replace(/[(). -]/gu, '')
  const digits = normalized.replace(/^\+/u, '')
  return /^\+?\d+$/u.test(normalized) && digits.length >= 3 && digits.length <= 15
    ? number
    : undefined
}

export function isDisplaySafeTelUrl(value: string): boolean {
  return displaySafeTelNumber(value) !== undefined
}

function splitQueryName(value: string): string[] {
  return value
    .normalize('NFKC')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function inspectParsedUrl(url: URL): UrlSecretInspection {
  const sensitiveQueryNames = [...new Set(
    [...url.searchParams.keys()].filter(isSensitiveQueryName),
  )]
  const hasUserinfo = Boolean(url.username || url.password)
  return {
    hasUserinfo,
    sensitiveQueryNames,
    hasDetectedSecrets: hasUserinfo || sensitiveQueryNames.length > 0,
  }
}

function parseUrl(value: string): URL {
  try {
    return new URL(value)
  } catch {
    throw new SecurityFoundationError(
      SECURITY_ERROR_CODES.invalidUrl,
      'URLの形式が不正です。',
    )
  }
}
