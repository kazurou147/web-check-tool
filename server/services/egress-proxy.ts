import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { connect as connectSocket, type Socket } from 'node:net'
import type { Duplex } from 'node:stream'
import { NetworkPolicy, NetworkPolicyError } from './network-policy'

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST'])
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'])

export interface EgressProxyOptions {
  policy: NetworkPolicy
  connectTimeoutMs?: number
  idleTimeoutMs?: number
}

export interface EgressProxyEndpoint {
  server: string
  host: '127.0.0.1'
  port: number
}

export class EgressProxy {
  private server?: Server
  private readonly sockets = new Set<Duplex>()
  private readonly authorizedTargets = new Map<string, Set<string>>()
  private stopping?: Promise<void>
  private abortListener?: () => void

  constructor(private readonly options: EgressProxyOptions) {}

  async authorizeUrl(value: string, method = 'GET'): Promise<void> {
    const approved = await this.options.policy.resolveUrl(value)
    const normalizedMethod = method.toUpperCase()
    if (!ALLOWED_METHODS.has(normalizedMethod)) throw new NetworkPolicyError('許可されていないHTTPメソッドです')
    const key = targetKey(approved.url.protocol, approved.hostname, approved.port)
    const methods = this.authorizedTargets.get(key) ?? new Set<string>()
    methods.add(normalizedMethod)
    if (approved.url.protocol === 'https:') methods.add('CONNECT')
    this.authorizedTargets.set(key, methods)
  }

  async start(signal?: AbortSignal): Promise<EgressProxyEndpoint> {
    if (this.server) throw new Error('egress proxyは既に起動しています')
    if (signal?.aborted) throw signal.reason
    const server = createServer((request, response) => { void this.forwardHttp(request, response) })
    server.on('connect', (request, client, head) => { void this.forwardConnect(request, client, head) })
    server.on('connection', socket => this.track(socket))
    server.on('clientError', (_error, socket) => {
      if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
    })
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => reject(error)
      server.once('error', onError)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', onError)
        resolve()
      })
    })
    this.server = server
    if (signal) {
      this.abortListener = () => { void this.stop() }
      signal.addEventListener('abort', this.abortListener, { once: true })
    }
    const address = server.address()
    if (!address || typeof address === 'string') {
      await this.stop()
      throw new Error('egress proxyの待受ポートを確認できません')
    }
    return { server: `http://127.0.0.1:${address.port}`, host: '127.0.0.1', port: address.port }
  }

  async stop(): Promise<void> {
    if (this.stopping) return this.stopping
    this.stopping = (async () => {
      const server = this.server
      this.server = undefined
      if (!server) return
      for (const socket of this.sockets) socket.destroy()
      await new Promise<void>(resolve => server.close(() => resolve()))
      this.sockets.clear()
      this.authorizedTargets.clear()
    })()
    return this.stopping
  }

  private async forwardHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (!this.isLoopbackClient(request.socket.remoteAddress)) return rejectResponse(response, 403)
    const method = request.method?.toUpperCase() ?? ''
    if (!ALLOWED_METHODS.has(method)) return rejectResponse(response, 405)
    let target: URL
    try {
      if (!/^https?:\/\//i.test(request.url ?? '')) throw new NetworkPolicyError('absolute-form以外は拒否します')
      target = new URL(request.url!)
      if (target.protocol !== 'http:') throw new NetworkPolicyError('HTTPSはCONNECTを使用してください')
      const approved = await this.options.policy.resolveUrl(target.href)
      if (!this.isAuthorized(target.protocol, approved.hostname, approved.port, method)) {
        throw new NetworkPolicyError('runで承認されていない接続先です')
      }
      const headers = forwardedHeaders(request.headers, target.host)
      const upstream = httpRequest({
        host: approved.selectedAddress.address,
        family: approved.selectedAddress.family,
        port: approved.port,
        method,
        path: `${target.pathname}${target.search}`,
        headers,
        setHost: false,
        timeout: this.options.idleTimeoutMs ?? 30_000,
      }, upstreamResponse => {
        response.writeHead(upstreamResponse.statusCode ?? 502, stripHopByHop(upstreamResponse.headers))
        response.once('close', () => upstreamResponse.destroy())
        upstreamResponse.pipe(response)
      })
      const connectTimer = setTimeout(() => upstream.destroy(new Error('接続がタイムアウトしました')), this.options.connectTimeoutMs ?? 10_000)
      upstream.once('socket', socket => {
        this.track(socket)
        socket.once('connect', () => clearTimeout(connectTimer))
      })
      upstream.once('close', () => clearTimeout(connectTimer))
      upstream.on('timeout', () => upstream.destroy(new Error('通信がタイムアウトしました')))
      upstream.on('error', () => {
        if (!response.headersSent) rejectResponse(response, 502)
        else response.destroy()
      })
      request.pipe(upstream)
    } catch {
      rejectResponse(response, 403)
    }
  }

  private async forwardConnect(request: IncomingMessage, client: Duplex, head: Buffer): Promise<void> {
    if (!this.isLoopbackClient((client as Socket).remoteAddress)) return rejectSocket(client, 403)
    let upstream: Socket | undefined
    try {
      const authority = request.url ?? ''
      if (!authority || /[/?#@]/.test(authority)) throw new NetworkPolicyError('CONNECT先が不正です')
      const target = new URL(`https://${authority}/`)
      const approved = await this.options.policy.resolveUrl(target.href)
      if (!this.isAuthorized(target.protocol, approved.hostname, approved.port, 'CONNECT')) {
        throw new NetworkPolicyError('runで承認されていない接続先です')
      }
      upstream = connectSocket({
        host: approved.selectedAddress.address,
        family: approved.selectedAddress.family,
        port: approved.port,
      })
      this.track(upstream)
      upstream.setTimeout(this.options.idleTimeoutMs ?? 30_000, () => upstream?.destroy())
      const timer = setTimeout(() => upstream?.destroy(new Error('接続がタイムアウトしました')), this.options.connectTimeoutMs ?? 10_000)
      upstream.once('connect', () => {
        clearTimeout(timer)
        if (!client.writable) return upstream?.destroy()
        client.write('HTTP/1.1 200 Connection Established\r\nProxy-Agent: website-delivery-checker\r\n\r\n')
        if (head.length) upstream?.write(head)
        upstream?.pipe(client)
        client.pipe(upstream!)
      })
      upstream.once('close', () => clearTimeout(timer))
      upstream.on('error', () => {
        clearTimeout(timer)
        if (!client.destroyed) rejectSocket(client, 502)
      })
    } catch {
      upstream?.destroy()
      rejectSocket(client, 403)
    }
  }

  private track<T extends Duplex>(socket: T): T {
    this.sockets.add(socket)
    socket.once('close', () => this.sockets.delete(socket))
    return socket
  }

  private isLoopbackClient(address?: string): boolean {
    return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'
  }

  private isAuthorized(protocol: string, hostname: string, port: number, method: string): boolean {
    return this.authorizedTargets.get(targetKey(protocol, hostname, port))?.has(method) === true
  }
}

function targetKey(protocol: string, hostname: string, port: number): string {
  return `${protocol}//${hostname}:${port}`
}

function forwardedHeaders(headers: IncomingMessage['headers'], host: string): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = { host }
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || name === 'host' || HOP_BY_HOP.has(name.toLowerCase())) continue
    result[name] = value
  }
  return result
}

function stripHopByHop(headers: IncomingMessage['headers']): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined || HOP_BY_HOP.has(name.toLowerCase())) continue
    result[name] = value
  }
  return result
}

function rejectResponse(response: ServerResponse, status: number): void {
  if (response.headersSent) {
    response.destroy()
    return
  }
  response.writeHead(status, {
    connection: 'close',
    'content-type': 'text/plain; charset=utf-8',
    'x-web-check-proxy-error': 'EGRESS_PROXY_REJECTED',
  })
  response.end('Request blocked')
}

function rejectSocket(socket: Duplex, status: number): void {
  if (!socket.writable) {
    socket.destroy()
    return
  }
  socket.end(`HTTP/1.1 ${status} Request blocked\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}
