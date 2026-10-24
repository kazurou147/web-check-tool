import type { LinkKind, LinkResult, Verdict } from '~/shared/types/run'
import { NetworkPolicy, NetworkPolicyError } from '../network-policy'
import { isAbortError, RunCanceledError, throwIfAborted } from '../abort'

export interface CapturedLink {
  href: string
  resolvedUrl: string
  text: string
  beforeText?: string
  afterText?: string
  isImageLink: boolean
}

export interface LinkCheckOptions {
  timeoutMs: number
  maxRedirects: number
  maxResponseBytes: number
}

export interface HttpProbeResult {
  requestedUrl: string
  finalUrl: string
  status: number
  contentType: string
  redirectCount: number
  body?: string
}

export interface LinkProbe {
  probe(url: string, includeBody: boolean, signal?: AbortSignal): Promise<HttpProbeResult>
}

export class SafeLinkProbe implements LinkProbe {
  constructor(
    private readonly policy: NetworkPolicy,
    private readonly options: LinkCheckOptions,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async probe(value: string, includeBody: boolean, signal?: AbortSignal): Promise<HttpProbeResult> {
    let current = value
    let redirectCount = 0
    let method: 'HEAD' | 'GET' = includeBody ? 'GET' : 'HEAD'
    while (true) {
      throwIfAborted(signal)
      await this.policy.assertUrl(current)
      const timeout = AbortSignal.timeout(this.options.timeoutMs)
      const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
      const response = await this.fetcher(current, {
        method,
        redirect: 'manual',
        signal: combinedSignal,
        headers: { 'user-agent': 'WebsiteDeliveryChecker/1.0' },
      })
      const location = response.headers.get('location')
      if (response.status >= 300 && response.status < 400 && location) {
        if (redirectCount >= this.options.maxRedirects) {
          throw new NetworkPolicyError(`リダイレクト回数が上限${this.options.maxRedirects}回を超えました`)
        }
        current = new URL(location, current).href
        redirectCount += 1
        continue
      }

      const contentLength = Number(response.headers.get('content-length') ?? '0')
      if (contentLength > this.options.maxResponseBytes) {
        throw new NetworkPolicyError(`応答サイズが上限${this.options.maxResponseBytes}バイトを超えています`)
      }
      const body = includeBody && method === 'GET'
        ? await readLimitedText(response, this.options.maxResponseBytes)
        : undefined
      return {
        requestedUrl: value,
        finalUrl: response.url || current,
        status: response.status,
        contentType: response.headers.get('content-type') ?? '',
        redirectCount,
        body,
      }
    }
  }
}

export async function checkLinks(
  pageUrl: string,
  links: CapturedLink[],
  samePageAnchors: Set<string>,
  probe: LinkProbe,
  signal?: AbortSignal,
  documentUrl = pageUrl,
): Promise<LinkResult[]> {
  const cache = new Map<string, Promise<HttpProbeResult>>()
  return Promise.all(links.map(async (link, index) => {
    const key = `${redactUrl(pageUrl)}|link|${index}|${redactUrl(link.resolvedUrl || link.href)}`
    const base = {
      key,
      pageUrl,
      href: redactUrl(link.href),
      resolvedUrl: link.resolvedUrl ? redactUrl(link.resolvedUrl) : undefined,
      redirectCount: 0,
      isImageLink: link.isImageLink,
      evidence: [] as string[],
    }
    if (!link.href) return result(base, 'empty', 'needs_review', 'hrefが空です。')
    if (/^mailto:/i.test(link.href)) {
      const valid = /^mailto:[^?\s@]+@[^?\s@]+(?:\?.*)?$/i.test(link.href)
      return result(base, 'mailto', valid ? 'ok' : 'ng', valid ? 'mailto形式を確認しました。' : 'mailto形式が不正です。')
    }
    if (/^tel:/i.test(link.href)) {
      const valid = /^tel:\+?[0-9().\s-]+$/i.test(link.href)
      return result(base, 'tel', valid ? 'ok' : 'ng', valid ? 'tel形式を確認しました。' : 'tel形式が不正です。')
    }
    if (/^(?:javascript|data):/i.test(link.href)) {
      return result(base, 'non_http', 'needs_review', '通信しないリンク形式として記録しました。')
    }

    throwIfAborted(signal)
    let target: URL
    try {
      target = new URL(link.resolvedUrl || link.href, pageUrl)
    } catch {
      return result(base, 'non_http', 'ng', 'リンクURLの形式が不正です。')
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      return result(base, 'non_http', 'needs_review', 'HTTP/HTTPS以外のリンクとして記録しました。')
    }

    const page = new URL(documentUrl)
    const hasAnchor = Boolean(target.hash)
    const sameDocument = withoutHash(target) === withoutHash(page)
    if (hasAnchor && sameDocument) {
      const anchor = decodeAnchor(target.hash)
      const found = samePageAnchors.has(anchor)
      return result(base, 'anchor', found ? 'ok' : 'ng', found ? 'ページ内アンカーを確認しました。' : `ページ内アンカー #${anchor} が見つかりません。`)
    }

    const kind: LinkKind = hasAnchor ? 'anchor' : /\.pdf(?:$|[?#])/i.test(target.href) ? 'pdf' : 'http'
    const requestUrl = withoutHash(target)
    try {
      let response: HttpProbeResult
      if (hasAnchor) {
        const cacheKey = `GET ${requestUrl}`
        const pending = cache.get(cacheKey) ?? probe.probe(requestUrl, true, signal)
        cache.set(cacheKey, pending)
        response = await pending
      } else {
        const cacheKey = `HEAD ${requestUrl}`
        const pending = cache.get(cacheKey) ?? probe.probe(requestUrl, false, signal)
        cache.set(cacheKey, pending)
        response = await pending
      }
      const statusVerdict = verdictForStatus(response.status)
      let verdict = statusVerdict
      let message = messageForStatus(response.status)
      const evidence = [`HTTP ${response.status}`, `最終URL: ${redactUrl(response.finalUrl)}`]

      if (statusVerdict === 'ok' && hasAnchor) {
        const anchor = decodeAnchor(target.hash)
        const found = htmlHasAnchor(response.body ?? '', anchor)
        verdict = found ? 'ok' : 'ng'
        message = found ? '別ページのアンカーを確認しました。' : `別ページのアンカー #${anchor} が見つかりません。`
      }
      if (kind === 'pdf' && response.contentType && !/application\/pdf/i.test(response.contentType)) {
        verdict = 'needs_review'
        message = 'PDF拡張子ですがContent-Typeがapplication/pdfではありません。'
      }
      return {
        ...base,
        kind,
        verdict,
        status: response.status,
        contentType: response.contentType,
        finalUrl: redactUrl(response.finalUrl),
        redirectCount: response.redirectCount,
        message,
        evidence,
      }
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw new RunCanceledError()
      const message = error instanceof NetworkPolicyError
        ? error.message
        : error instanceof DOMException && error.name === 'TimeoutError'
          ? 'リンク先の取得がタイムアウトしました。'
          : 'リンク先の取得に失敗しました。'
      return result(base, kind, 'ng', message)
    }
  }))
}

export function verdictForStatus(status: number): Verdict {
  if ([401, 403, 405, 429].includes(status)) return 'needs_review'
  if (status >= 200 && status < 300) return 'ok'
  return 'ng'
}

function messageForStatus(status: number): string {
  if ([401, 403, 405, 429].includes(status)) return `HTTP ${status} は例外規則により要確認です。`
  if (status >= 200 && status < 300) return `HTTP ${status} を確認しました。`
  if (status >= 300 && status < 400) return `HTTP ${status} のリダイレクト先を確認できませんでした。`
  return `HTTP ${status} のためリンク切れです。`
}

function result(
  base: Omit<LinkResult, 'kind' | 'verdict' | 'message'>,
  kind: LinkKind,
  verdict: Verdict,
  message: string,
): LinkResult {
  return { ...base, kind, verdict, message }
}

function withoutHash(url: URL): string {
  const copy = new URL(url)
  copy.hash = ''
  return copy.href
}

function decodeAnchor(hash: string): string {
  try {
    return decodeURIComponent(hash.replace(/^#/, ''))
  } catch {
    return hash.replace(/^#/, '')
  }
}

function htmlHasAnchor(html: string, anchor: string): boolean {
  const escaped = escapeRegExp(anchor)
  return new RegExp(`\\b(?:id|name)\\s*=\\s*(["'])${escaped}\\1`, 'i').test(html)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function readLimitedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel()
      throw new NetworkPolicyError(`応答サイズが上限${maxBytes}バイトを超えています`)
    }
    chunks.push(value)
  }
  return new TextDecoder().decode(Buffer.concat(chunks))
}

export function redactUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|secret|auth|password|passwd|session|email|user/i.test(key)) {
        url.searchParams.set(key, '[REDACTED]')
      }
    }
    return url.href.slice(0, 4_096)
  } catch {
    return value.slice(0, 4_096)
  }
}
