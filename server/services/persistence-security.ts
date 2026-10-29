import type { InputSnapshot } from '~/shared/types/excel-input'
import type { RunResult } from '~/shared/types/run'
import { maskUrlForDisplay } from '~/shared/security/url-security'
import { maskSecretText, maskSensitiveUrl } from './ai-masking'
import { createUrlIdentity } from './url-identity'

const URL_FIELD = /(?:url|href)$/i
const IDENTIFIER_FIELD = /(?:^|_)(?:projectId|runId|bundleId|itemId|inputHash|outputHash|payloadHash|signature|urlIdentity|pageUrlIdentity|targetUrlIdentity|imageUrlIdentity)$/i

export function secureInputSnapshot(input: InputSnapshot, key: Uint8Array): InputSnapshot {
  const output = structuredClone(input)
  output.pageRows = input.pageRows.map(row => {
    const maskedUrl = safeUrl(row.url)
    const maskedNormalized = safeUrl(row.normalizedUrl)
    return {
      ...row,
      url: maskedUrl,
      normalizedUrl: maskedNormalized,
      urlIdentity: row.urlIdentity ?? safeIdentity(row.normalizedUrl, key),
      displayName: row.pageName === null ? maskedUrl : safeText(row.displayName),
    }
  })
  output.duplicateGroups = input.duplicateGroups.map(group => ({
    ...group,
    normalizedUrl: safeUrl(group.normalizedUrl),
    urlIdentity: group.urlIdentity ?? safeIdentity(group.normalizedUrl, key),
    pageNames: group.pageNames.map(safeText),
  }))
  return sanitizeTree(output, '', true) as InputSnapshot
}

export function secureRunResult(result: RunResult, key: Uint8Array): RunResult {
  const output = structuredClone(result)
  output.input = secureInputSnapshot(result.input, key)
  output.pages = result.pages.map(page => {
    const identity = safeIdentity(page.normalizedUrl || page.requestedUrl, key)
    return {
      ...page,
      normalizedUrl: safeUrl(page.normalizedUrl),
      requestedUrl: safeUrl(page.requestedUrl),
      ...(page.finalUrl ? { finalUrl: safeUrl(page.finalUrl) } : {}),
      ...(page.finalUrlIdentity ? { finalUrlIdentity: page.finalUrlIdentity } : page.finalUrl ? { finalUrlIdentity: safeOptionalIdentity(page.finalUrl, key) } : {}),
      urlIdentity: page.urlIdentity ?? identity,
      findings: page.findings.map(finding => ({
        ...finding,
        url: safeUrl(finding.url),
        urlIdentity: finding.urlIdentity ?? identity,
      })),
    }
  })
  const pageIdentity = new Map(result.pages.map(page => [page.normalizedUrl, page.urlIdentity ?? safeIdentity(page.normalizedUrl, key)]))
  output.links = result.links.map(link => ({
    ...link,
    pageUrl: safeUrl(link.pageUrl),
    href: safeUrlOrText(link.href),
    ...(link.resolvedUrl ? { resolvedUrl: safeUrlOrText(link.resolvedUrl) } : {}),
    ...(link.finalUrl ? { finalUrl: safeUrlOrText(link.finalUrl) } : {}),
    pageUrlIdentity: link.pageUrlIdentity ?? pageIdentity.get(link.pageUrl),
    targetUrlIdentity: link.targetUrlIdentity ?? safeOptionalIdentity(link.resolvedUrl || link.href, key),
    finalUrlIdentity: link.finalUrlIdentity ?? safeOptionalIdentity(link.finalUrl, key),
  }))
  output.images = result.images.map(image => ({
    ...image,
    pageUrl: safeUrl(image.pageUrl),
    imageUrl: safeUrlOrText(image.imageUrl),
    pageUrlIdentity: image.pageUrlIdentity ?? pageIdentity.get(image.pageUrl),
    imageUrlIdentity: image.imageUrlIdentity ?? safeOptionalIdentity(image.imageUrl, key),
  }))
  output.googleTagDetections = result.googleTagDetections.map(tag => ({
    ...tag,
    pageUrl: safeUrl(tag.pageUrl),
    pageUrlIdentity: tag.pageUrlIdentity ?? pageIdentity.get(tag.pageUrl),
  }))
  return sanitizeTree(output, '', true) as RunResult
}

export function secureEvent(event: Record<string, unknown>, key: Uint8Array): Record<string, unknown> {
  const output = sanitizeTree(event) as Record<string, unknown>
  if (typeof event.url === 'string') {
    output.url = safeUrlOrText(event.url)
    const identity = safeOptionalIdentity(event.url, key)
    if (identity) output.urlIdentity = identity
  }
  return output
}

/** Legacy JSON remains untouched on disk; API/UI receives this sanitized clone. */
export function secureRunForPublic(result: RunResult): RunResult {
  return sanitizeTree(structuredClone(result)) as RunResult
}

function sanitizeTree(value: unknown, field = '', preserveSafeKeys = false): unknown {
  if (typeof value === 'string') {
    if (IDENTIFIER_FIELD.test(field)) return value
    if (preserveSafeKeys && (field === 'key' || field === 'linkResultKey') && value.includes('url-hmac-v1:') && !/https?:\/\//iu.test(value)) return value
    if ((field === 'key' || field === 'linkResultKey') && value.includes('url-hmac-v1:') && !/https?:\/\//iu.test(value)) return value
    return URL_FIELD.test(field) || /^https?:\/\//iu.test(value) ? safeUrlOrText(value) : safeText(value)
  }
  if (Array.isArray(value)) return value.map(item => sanitizeTree(item, field, preserveSafeKeys))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childField, child]) => [childField, sanitizeTree(child, childField, preserveSafeKeys)]))
  }
  return value
}

function safeText(value: string): string {
  return maskSecretText(value).value
}

function safeUrl(value: string): string {
  try {
    return maskUrlForDisplay(value).value
  } catch {
    return safeText(value)
  }
}

function safeUrlOrText(value: string): string {
  if (/^tel:/iu.test(value)) return maskSensitiveUrl(value).value
  return /^[a-z][a-z0-9+.-]*:/iu.test(value) ? safeUrl(value) : safeText(value)
}

function safeIdentity(value: string, key: Uint8Array): string {
  return createUrlIdentity(value, key)
}

function safeOptionalIdentity(value: string | undefined, key: Uint8Array): string | undefined {
  if (!value) return undefined
  try {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol)) return undefined
    return safeIdentity(value, key)
  } catch {
    return undefined
  }
}
