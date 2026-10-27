import { createHash } from 'node:crypto'
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { isIP } from 'node:net'
import { checkServerIdentity, connect as tlsConnect } from 'node:tls'
import type { BrowserContext } from 'playwright'
import type { SanitizedRunConfig } from '~/shared/types/run'
import type { HttpProbeResult, LinkProbe } from './checks/links'
import { NetworkPolicyError } from './network-policy'
import { throwIfAborted } from './abort'
import type { EgressProxyEndpoint } from './egress-proxy'
import { SECURITY_LIMITS } from '~/shared/security/security-constants'

export interface EgressHttpClientOptions {
  proxy: EgressProxyEndpoint
  config: Pick<SanitizedRunConfig, 'linkTimeoutMs' | 'maxRedirects' | 'maxResponseBytes'>
  authorizeTarget: (url: string, method: 'GET' | 'HEAD') => Promise<void>
  cookieProvider?: (url: string) => Promise<string>
  basicCredentials?: { username: string, password: string }
}

export class EgressHttpClient implements LinkProbe {
  private readonly limiter = new LinkRequestLimiter(
    SECURITY_LIMITS.linkRequestConcurrencyPerRun,
    SECURITY_LIMITS.linkRequestConcurrencyPerOrigin,
  )
  private readonly probes = new Map<string, Promise<HttpProbeResult>>()

  constructor(private readonly options: EgressHttpClientOptions) {}

  async probe(value: string, includeBody: boolean, signal?: AbortSignal): Promise<HttpProbeResult> {
    throwIfAborted(signal)
    const normalized = new URL(value)
    normalized.hash = ''
    const authScope = await this.authScope(normalized.href)
    const cacheKey = `${includeBody ? 'GET' : 'HEAD'}|${normalized.href}|${authScope}`
    const existing = this.probes.get(cacheKey)
    if (existing) return await existing
    const pending = this.probeUncached(normalized.href, includeBody, signal)
    this.probes.set(cacheKey, pending)
    return await pending
  }

  private async probeUncached(value: string, includeBody: boolean, signal?: AbortSignal): Promise<HttpProbeResult> {
    let current = value
    let redirects = 0
    let method: 'HEAD' | 'GET' = includeBody ? 'GET' : 'HEAD'
    while (true) {
      throwIfAborted(signal)
      const response = await this.requestOnce(current, method, includeBody && method === 'GET', signal)
      if (method === 'HEAD' && response.status === 405) {
        method = 'GET'
        continue
      }
      const location = header(response.headers, 'location')
      if (response.status >= 300 && response.status < 400 && location) {
        if (redirects >= this.options.config.maxRedirects) {
          throw new NetworkPolicyError(`リダイレクト回数が上限${this.options.config.maxRedirects}回を超えました`)
        }
        current = new URL(location, current).href
        redirects += 1
        method = includeBody ? 'GET' : 'HEAD'
        continue
      }
      return {
        requestedUrl: value,
        finalUrl: current,
        status: response.status,
        contentType: header(response.headers, 'content-type') ?? '',
        redirectCount: redirects,
        ...(response.body === undefined ? {} : { body: response.body }),
      }
    }
  }

  private async requestOnce(value: string, method: 'HEAD' | 'GET', readBody: boolean, signal?: AbortSignal): Promise<{ status: number, headers: IncomingHttpHeaders, body?: string }> {
    const target = new URL(value)
    if (!['http:', 'https:'].includes(target.protocol)) throw new NetworkPolicyError('HTTP/HTTPS以外のURLは取得できません')
    const release = await this.limiter.acquire(target.origin, signal)
    try {
      await this.options.authorizeTarget(target.href, method)
      const timeoutSignal = AbortSignal.timeout(this.options.config.linkTimeoutMs)
      const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
      const headers: Record<string, string> = {
        host: target.host,
        connection: 'close',
        'user-agent': 'WebsiteDeliveryChecker/1.0',
      }
      const cookie = await this.options.cookieProvider?.(target.href)
      if (cookie) headers.cookie = cookie
      if (this.options.basicCredentials) {
        headers.authorization = `Basic ${Buffer.from(`${this.options.basicCredentials.username}:${this.options.basicCredentials.password}`).toString('base64')}`
      }
      const response = target.protocol === 'http:'
        ? await this.requestHttp(target, method, headers, requestSignal)
        : await this.requestHttps(target, method, headers, requestSignal)
      if (header(response.headers, 'x-web-check-proxy-error')) {
        response.destroy()
        throw new NetworkPolicyError('安全な通信経路で接続先が拒否されました')
      }
      const declaredLength = Number(header(response.headers, 'content-length') ?? '0')
      if (declaredLength > this.options.config.maxResponseBytes) {
        response.destroy()
        throw new NetworkPolicyError(`応答サイズが上限${this.options.config.maxResponseBytes}バイトを超えています`)
      }
      if (!readBody) {
        await drainLimited(response, this.options.config.maxResponseBytes, requestSignal)
        return { status: response.statusCode ?? 0, headers: response.headers }
      }
      return {
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: await readLimited(response, this.options.config.maxResponseBytes, requestSignal),
      }
    } finally {
      release()
    }
  }

  private async authScope(url: string): Promise<string> {
    const cookie = await this.options.cookieProvider?.(url) ?? ''
    const basic = this.options.basicCredentials
      ? `${this.options.basicCredentials.username}\0${this.options.basicCredentials.password}`
      : ''
    return createHash('sha256').update(`${cookie}\0${basic}`).digest('hex')
  }

  private requestHttp(target: URL, method: string, headers: Record<string, string>, signal: AbortSignal): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const request = httpRequest({
        host: this.options.proxy.host,
        port: this.options.proxy.port,
        method,
        path: target.href,
        headers,
        signal,
      }, resolve)
      request.once('error', reject)
      request.end()
    })
  }

  private requestHttps(target: URL, method: string, headers: Record<string, string>, signal: AbortSignal): Promise<IncomingMessage> {
    return new Promise((resolve, reject) => {
      const authority = target.port ? `${target.hostname}:${target.port}` : `${target.hostname}:443`
      const connect = httpRequest({
        host: this.options.proxy.host,
        port: this.options.proxy.port,
        method: 'CONNECT',
        path: authority,
        headers: { host: authority, connection: 'close' },
        signal,
      })
      connect.once('connect', (response, socket, head) => {
        if (response.statusCode !== 200) {
          socket.destroy()
          return reject(new NetworkPolicyError('安全な接続経路を確立できませんでした'))
        }
        if (head.length) socket.unshift(head)
        const certificateHostname = target.hostname.replace(/^\[|\]$/g, '')
        const tlsSocket = tlsConnect({
          socket,
          ...(isIP(certificateHostname) ? {} : { servername: certificateHostname }),
          rejectUnauthorized: true,
          checkServerIdentity: (_hostname, certificate) => checkServerIdentity(certificateHostname, certificate),
        })
        const abortTls = () => tlsSocket.destroy(signal.reason instanceof Error ? signal.reason : new Error('通信が中断されました'))
        if (signal.aborted) abortTls()
        else signal.addEventListener('abort', abortTls, { once: true })
        tlsSocket.once('secureConnect', () => {
          signal.removeEventListener('abort', abortTls)
          const request = httpsRequest({
            hostname: certificateHostname,
            port: target.port || 443,
            method,
            path: `${target.pathname}${target.search}`,
            headers,
            agent: false,
            signal,
            createConnection: () => tlsSocket,
          }, resolve)
          request.once('error', reject)
          request.end()
        })
        tlsSocket.once('error', (error) => {
          signal.removeEventListener('abort', abortTls)
          reject(error)
        })
      })
      connect.once('error', reject)
      connect.end()
    })
  }
}

interface PendingPermit {
  origin: string
  signal?: AbortSignal
  resolve: (release: () => void) => void
  reject: (error: unknown) => void
  abort?: () => void
}

export class LinkRequestLimiter {
  private active = 0
  private readonly activeByOrigin = new Map<string, number>()
  private readonly queue: PendingPermit[] = []

  constructor(
    readonly maxTotal: number = SECURITY_LIMITS.linkRequestConcurrencyPerRun,
    readonly maxPerOrigin: number = SECURITY_LIMITS.linkRequestConcurrencyPerOrigin,
  ) {}

  acquire(origin: string, signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal)
    return new Promise((resolve, reject) => {
      const pending: PendingPermit = { origin, signal, resolve, reject }
      if (signal) {
        pending.abort = () => {
          const index = this.queue.indexOf(pending)
          if (index >= 0) this.queue.splice(index, 1)
          reject(signal.reason ?? new DOMException('通信が中断されました', 'AbortError'))
        }
        signal.addEventListener('abort', pending.abort, { once: true })
      }
      this.queue.push(pending)
      this.schedule()
    })
  }

  private schedule(): void {
    while (this.active < this.maxTotal) {
      const index = this.queue.findIndex(item => !item.signal?.aborted && (this.activeByOrigin.get(item.origin) ?? 0) < this.maxPerOrigin)
      if (index < 0) return
      const pending = this.queue.splice(index, 1)[0]!
      if (pending.abort) pending.signal?.removeEventListener('abort', pending.abort)
      this.active += 1
      this.activeByOrigin.set(pending.origin, (this.activeByOrigin.get(pending.origin) ?? 0) + 1)
      let released = false
      pending.resolve(() => {
        if (released) return
        released = true
        this.active -= 1
        const remaining = (this.activeByOrigin.get(pending.origin) ?? 1) - 1
        if (remaining <= 0) this.activeByOrigin.delete(pending.origin)
        else this.activeByOrigin.set(pending.origin, remaining)
        this.schedule()
      })
    }
  }
}

export function browserCookieProvider(context: BrowserContext): (url: string) => Promise<string> {
  return async url => (await context.cookies(url)).map(cookie => `${cookie.name}=${cookie.value}`).join('; ')
}

function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name]
  return Array.isArray(value) ? value[0] : value
}

async function readLimited(response: IncomingMessage, limit: number, signal: AbortSignal): Promise<string> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const raw of response) {
    if (signal.aborted) {
      response.destroy()
      throw signal.reason
    }
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw)
    total += chunk.length
    if (total > limit) {
      response.destroy()
      throw new NetworkPolicyError(`応答サイズが上限${limit}バイトを超えています`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function drainLimited(response: IncomingMessage, limit: number, signal: AbortSignal): Promise<void> {
  let total = 0
  for await (const raw of response) {
    if (signal.aborted) {
      response.destroy()
      throw signal.reason
    }
    total += Buffer.isBuffer(raw) ? raw.length : Buffer.byteLength(raw)
    if (total > limit) {
      response.destroy()
      throw new NetworkPolicyError(`応答サイズが上限${limit}バイトを超えています`)
    }
  }
}
