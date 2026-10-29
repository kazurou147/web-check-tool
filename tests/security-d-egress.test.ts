import { createServer, request as httpRequest, type RequestListener } from 'node:http'
import { connect as connectSocket, createServer as createTcpServer, type Server } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { EgressHttpClient } from '~/server/services/egress-http-client'
import { EgressProxy } from '~/server/services/egress-proxy'
import { NetworkPolicy } from '~/server/services/network-policy'
import { createRunConfig } from '~/server/services/run-engine'
import { createPlaywrightInspector } from '~/server/services/playwright-inspector'
import { defaultProjectSettings } from '~/shared/types/project'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!()
})

describe('Security-D egress proxy', () => {
  it('HTTPを検証済みIPへ固定し、Host・Cookie・Basic認証・HEAD→GET・リダイレクトを維持する', async () => {
    const methods: string[] = []
    const fixture = await startHttpFixture((request, response) => {
      methods.push(request.method ?? '')
      expect(request.headers.host).toMatch(/^safe\.test:/)
      expect(request.headers.cookie).toBe('session=test-cookie')
      expect(request.headers.authorization).toBe(`Basic ${Buffer.from('user:pass').toString('base64')}`)
      if (request.url === '/start') {
        response.writeHead(302, { location: '/final' }).end()
      } else if (request.method === 'HEAD') {
        response.writeHead(405).end()
      } else {
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end('<h1>安全な応答</h1>')
      }
    })
    const proxy = await startProxy(fixture.port)
    const config = createRunConfig(defaultProjectSettings())
    const client = new EgressHttpClient({
      proxy: proxy.endpoint,
      config,
      authorizeTarget: (url, method) => proxy.proxy.authorizeUrl(url, method),
      cookieProvider: async () => 'session=test-cookie',
      basicCredentials: { username: 'user', password: 'pass' },
    })

    const result = await client.probe(`http://safe.test:${fixture.port}/start`, false)
    expect(result).toMatchObject({ status: 200, redirectCount: 1, finalUrl: `http://safe.test:${fixture.port}/final` })
    expect(methods).toEqual(['HEAD', 'HEAD', 'GET'])
  })

  it('origin-form、未許可メソッド、未許可ホストを拒否し、秘密URLを応答へ含めない', async () => {
    const fixture = await startHttpFixture((_request, response) => response.writeHead(200).end('unexpected'))
    const proxy = await startProxy(fixture.port)
    expect((await rawProxyRequest(proxy.endpoint.port, 'GET', '/relative')).status).toBe(403)
    expect((await rawProxyRequest(proxy.endpoint.port, 'DELETE', `http://safe.test:${fixture.port}/?token=do-not-log`)).status).toBe(405)
    const blocked = await rawProxyRequest(proxy.endpoint.port, 'GET', 'http://blocked.test/?token=do-not-log')
    expect(blocked.status).toBe(403)
    expect(blocked.body).not.toContain('do-not-log')
  })

  it('別ローカルプロセス相当の接続をrunで承認済みの宛先・メソッドだけに制限する', async () => {
    const hits: string[] = []
    const fixture = await startHttpFixture((request, response) => {
      hits.push(`${request.method} ${request.headers.host}${request.url}`)
      response.writeHead(200).end('ok')
    })
    const proxy = await startProxy(fixture.port, ['unrelated.test'])
    await proxy.proxy.authorizeUrl(`http://safe.test:${fixture.port}/`, 'GET')

    expect((await rawProxyRequest(proxy.endpoint.port, 'GET', `http://safe.test:${fixture.port}/allowed`)).status).toBe(200)
    expect((await rawProxyRequest(proxy.endpoint.port, 'POST', `http://safe.test:${fixture.port}/not-authorized-method`)).status).toBe(403)
    expect((await rawProxyRequest(proxy.endpoint.port, 'GET', `http://unrelated.test:${fixture.port}/not-authorized-host`)).status).toBe(403)
    expect(await rawConnectStatus(proxy.endpoint.port, `safe.test:${fixture.port}`)).toBe(403)
    expect(hits).toEqual([`GET safe.test:${fixture.port}/allowed`])
  })

  it('CONNECTを検証済みIPへ固定し、停止時にソケットと待受ポートを解放する', async () => {
    const fixture = createTcpServer(socket => socket.once('data', data => socket.end(data)))
    await listen(fixture)
    cleanup.push(() => closeServer(fixture))
    const port = addressPort(fixture)
    const proxy = await startProxy(port)
    await proxy.proxy.authorizeUrl(`https://safe.test:${port}/`)
    const tunnel = connectSocket(proxy.endpoint.port, '127.0.0.1')
    await new Promise<void>((resolve, reject) => {
      tunnel.once('connect', () => {
        tunnel.write(`CONNECT safe.test:${port} HTTP/1.1\r\nHost: safe.test:${port}\r\n\r\n`)
      })
      tunnel.once('data', data => data.toString().includes('200 Connection Established') ? resolve() : reject(new Error(data.toString())))
      tunnel.once('error', reject)
    })
    const tunnelClosed = new Promise<void>(resolve => tunnel.once('close', () => resolve()))
    await proxy.proxy.stop()
    await tunnelClosed
    expect(tunnel.destroyed).toBe(true)
    const rebound = createTcpServer()
    await new Promise<void>((resolve, reject) => rebound.once('error', reject).listen(proxy.endpoint.port, '127.0.0.1', resolve))
    await closeServer(rebound)
  })

  it('HTTPSではCONNECT後に元ホスト名をSNIに使い、TLS失敗時も直接通信へ切り替えない', async () => {
    let clientHello = Buffer.alloc(0)
    const fixture = createTcpServer(socket => socket.once('data', data => {
      clientHello = Buffer.from(data)
      socket.destroy()
    }))
    await listen(fixture)
    cleanup.push(() => closeServer(fixture))
    const port = addressPort(fixture)
    const proxy = await startProxy(port)
    const client = createClient(proxy)
    await expect(client.probe(`https://safe.test:${port}/`, false)).rejects.toBeDefined()
    expect(clientHello.includes(Buffer.from('safe.test'))).toBe(true)
  })

  it('AbortSignalで待機中のNode通信を中断できる', async () => {
    const fixture = await startHttpFixture(() => undefined)
    const proxy = await startProxy(fixture.port)
    const config = createRunConfig(defaultProjectSettings())
    const client = new EgressHttpClient({
      proxy: proxy.endpoint,
      config,
      authorizeTarget: (url, method) => proxy.proxy.authorizeUrl(url, method),
    })
    const controller = new AbortController()
    const pending = client.probe(`http://safe.test:${fixture.port}/slow`, false, controller.signal)
    controller.abort()
    await expect(pending).rejects.toBeDefined()
  })

  it('run全体で同一URL通信を共有し、認証状態が変わる場合は共有しない', async () => {
    let requests = 0
    let authState = 'session=first'
    const fixture = await startHttpFixture((_request, response) => {
      requests += 1
      setTimeout(() => response.writeHead(200).end(), 20)
    })
    const proxy = await startProxy(fixture.port)
    const client = new EgressHttpClient({
      proxy: proxy.endpoint,
      config: createRunConfig(defaultProjectSettings()),
      authorizeTarget: (url, method) => proxy.proxy.authorizeUrl(url, method),
      cookieProvider: async () => authState,
    })
    const url = `http://safe.test:${fixture.port}/same`
    const results = await Promise.all([client.probe(url, false), client.probe(url, false), client.probe(url, false)])
    expect(results.map(item => item.status)).toEqual([200, 200, 200])
    expect(requests).toBe(1)

    authState = 'session=second'
    await expect(client.probe(url, false)).resolves.toMatchObject({ status: 200 })
    expect(requests).toBe(2)
  })

  it('Content-Lengthがない巨大応答も読み取り途中で停止し、後続通信を継続できる', async () => {
    const fixture = await startHttpFixture((request, response) => {
      if (request.url === '/large') {
        response.writeHead(200, { 'content-type': 'text/html' })
        response.write('a'.repeat(800))
        response.end('b'.repeat(800))
        return
      }
      response.writeHead(200, { 'content-type': 'text/html' }).end('ok')
    })
    const proxy = await startProxy(fixture.port)
    const config = createRunConfig(defaultProjectSettings())
    config.maxResponseBytes = 1_024
    const client = new EgressHttpClient({
      proxy: proxy.endpoint,
      config,
      authorizeTarget: (url, method) => proxy.proxy.authorizeUrl(url, method),
    })

    await expect(client.probe(`http://safe.test:${fixture.port}/large`, true)).rejects.toThrow('応答サイズ')
    await expect(client.probe(`http://safe.test:${fixture.port}/ok`, true)).resolves.toMatchObject({ status: 200, body: 'ok' })
  })

  it('リダイレクト先を再検証し、禁止IPへ変化したDNS応答を拒否する', async () => {
    const fixture = await startHttpFixture((_request, response) => response.writeHead(302, { location: 'http://blocked.test/private' }).end())
    const proxy = await startProxy(fixture.port)
    const client = createClient(proxy)
    await expect(client.probe(`http://safe.test:${fixture.port}/redirect`, false)).rejects.toThrow('ローカル・私設')

    let resolution = 0
    const rebindingPolicy = new NetworkPolicy({ lookup: async () => (++resolution === 1
      ? [{ address: '93.184.216.34', family: 4 }]
      : [{ address: '127.0.0.1', family: 4 }]) })
    await expect(rebindingPolicy.resolveUrl('http://rebind.example/')).resolves.toMatchObject({ selectedAddress: { address: '93.184.216.34' } })
    await expect(rebindingPolicy.resolveUrl('http://rebind.example/')).rejects.toThrow('ローカル・私設')
  })

  it('proxy停止後に直接通信へフォールバックしない', async () => {
    const fixture = await startHttpFixture((_request, response) => response.writeHead(200).end('must not be reached'))
    const proxy = await startProxy(fixture.port)
    const client = createClient(proxy)
    await proxy.proxy.stop()
    await expect(client.probe(`http://safe.test:${fixture.port}/`, false)).rejects.toBeDefined()
  })

  it('Playwrightのdesktop/mobile・サブリソース・Cookieをrun専用proxy経由で検査する', async () => {
    const hits: string[] = []
    const fixture = await startHttpFixture((request, response) => {
      hits.push(request.url ?? '')
      if (request.url === '/style.css') return response.writeHead(200, { 'content-type': 'text/css' }).end('body{color:black}')
      if (request.url === '/script.js') return response.writeHead(200, { 'content-type': 'text/javascript' }).end('document.body.dataset.loaded="yes"')
      if (request.url === '/image.svg') return response.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>')
      if (request.url === '/frame') return response.writeHead(200, { 'content-type': 'text/html' }).end('<p>frame</p>')
      response.writeHead(200, { 'content-type': 'text/html', 'set-cookie': 'session=memory-only; Path=/' }).end('<title>fixture</title><script>let rtc="allowed",transport="allowed";try{new RTCPeerConnection()}catch{rtc="blocked"}try{new WebTransport("https://example.invalid/")}catch{transport="blocked"}document.title=rtc+"/"+transport</script><link rel="stylesheet" href="/style.css"><script src="/script.js"></script><iframe src="/frame"></iframe><img src="/image.svg">')
    })
    const settings = defaultProjectSettings()
    settings.allowedPrivateHosts = ['127.0.0.1']
    settings.navigationTimeoutMs = 10_000
    const config = createRunConfig(settings)
    config.imageScrollWaitMs = 1
    const inspector = await createPlaywrightInspector({ settings, secrets: {}, config })
    try {
      const result = await inspector.inspect(`http://127.0.0.1:${fixture.port}/`)
      expect(result.status).toBe(200)
      expect(result.metadata.titles).toEqual(['blocked/blocked'])
      expect(result.images.map(item => item.device)).toEqual(['desktop', 'mobile'])
      expect(hits).toEqual(expect.arrayContaining(['/style.css', '/script.js', '/frame', '/image.svg']))
    } finally {
      await inspector.close()
    }
  }, 30_000)

  it('ページ・端末ごとのリンクと画像候補を2000件で止め、残りを診断する', async () => {
    const fixture = await startHttpFixture((_request, response) => {
      const links = Array.from({ length: 2_001 }, (_, index) => `<a href="/link-${index}">link ${index}</a>`).join('')
      const images = Array.from({ length: 2_001 }, (_, index) => `<img id="image-${index}" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'/%3E">`).join('')
      response.writeHead(200, { 'content-type': 'text/html' }).end(`<title>limits</title>${links}${images}`)
    })
    const settings = defaultProjectSettings()
    settings.allowedPrivateHosts = ['127.0.0.1']
    const inspector = await createPlaywrightInspector({ settings, secrets: {}, config: fastConfig(settings) })
    try {
      const result = await inspector.inspect(`http://127.0.0.1:${fixture.port}/`)
      expect(result.links).toHaveLength(2_000)
      expect(result.linkCandidateLimit).toEqual({ limit: 2_000, observedAtLeast: 2_001 })
      expect(result.images).toHaveLength(2)
      expect(result.images[0]?.images).toHaveLength(2_000)
      expect(result.images[0]?.candidateLimit).toEqual({ limit: 2_000, observedAtLeast: 2_001 })
      expect(result.images[1]?.images).toHaveLength(2_000)
      expect(result.images[1]?.candidateLimit).toEqual({ limit: 2_000, observedAtLeast: 2_001 })
    } finally {
      await inspector.close()
    }
  }, 30_000)

  it('Basic認証をdesktop/mobileとNodeリンク検査へ安全に引き継ぐ', async () => {
    const authorization = `Basic ${Buffer.from('basic-user:basic-pass').toString('base64')}`
    const fixture = await startHttpFixture((request, response) => {
      if (request.headers.authorization !== authorization) return response.writeHead(401, { 'www-authenticate': 'Basic realm="fixture"' }).end()
      response.writeHead(200, { 'content-type': 'text/html' }).end('<title>basic-ok</title>')
    })
    const settings = defaultProjectSettings()
    settings.allowedPrivateHosts = ['127.0.0.1']
    settings.auth.mode = 'basic'
    const inspector = await createPlaywrightInspector({
      settings,
      secrets: { basic: { username: 'basic-user', password: 'basic-pass' } },
      config: fastConfig(settings),
    })
    try {
      await inspector.authenticate()
      const result = await inspector.inspect(`http://127.0.0.1:${fixture.port}/`)
      expect(result.status).toBe(200)
      await expect(inspector.linkProbe!.probe(`http://127.0.0.1:${fixture.port}/`, false)).resolves.toMatchObject({ status: 200 })
    } finally {
      await inspector.close()
    }
  }, 30_000)

  it('WordPress Password Protected形式でパスワードだけを送信しCookieをdesktop/mobile・リンク検査へ維持する', async () => {
    const receivedBodies: string[] = []
    const fixture = await startHttpFixture((request, response) => {
      const authenticated = request.headers.cookie?.includes('password-protected=accepted')
      if (request.method === 'POST' && request.url?.startsWith('/?password-protected=login')) {
        const chunks: Buffer[] = []
        request.on('data', chunk => chunks.push(Buffer.from(chunk)))
        return request.once('end', () => {
          const body = Buffer.concat(chunks).toString('utf8')
          receivedBodies.push(body)
          if (new URLSearchParams(body).get('password_protected_pwd') === 'site-pass') {
            response.writeHead(302, { location: '/page-one', 'set-cookie': 'password-protected=accepted; Path=/; HttpOnly' }).end()
          } else {
            response.writeHead(200, { 'content-type': 'text/html' }).end(passwordProtectedLogin('/page-one', 'incorrect password'))
          }
        })
      }
      if (request.method === 'GET' && request.url?.startsWith('/?password-protected=login')) {
        return response.writeHead(200, { 'content-type': 'text/html' }).end(passwordProtectedLogin('/page-one'))
      }
      if (!authenticated) {
        const redirectTo = encodeURIComponent(`http://127.0.0.1:${fixture.port}${request.url}`)
        return response.writeHead(302, { location: `/?password-protected=login&redirect_to=${redirectTo}` }).end()
      }
      if (request.url === '/image.svg') return response.writeHead(200, { 'content-type': 'image/svg+xml' }).end('<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"/>')
      response.writeHead(200, { 'content-type': 'text/html' }).end(`<title>${request.url === '/page-two' ? 'page-two' : 'page-one'}</title><a href="/page-two">next</a><img src="/image.svg">`)
    })
    const settings = defaultProjectSettings()
    settings.allowedPrivateHosts = ['127.0.0.1']
    settings.auth.mode = 'password_protected'
    const authenticationUrl = `http://127.0.0.1:${fixture.port}/page-one`
    const inspector = await createPlaywrightInspector({
      settings,
      secrets: { password_protected: { password: 'site-pass' } },
      config: fastConfig(settings),
      authenticationUrl,
    })
    try {
      await inspector.authenticate()
      const first = await inspector.inspect(authenticationUrl)
      const second = await inspector.inspect(`http://127.0.0.1:${fixture.port}/page-two`)
      expect(first.metadata.titles).toEqual(['page-one'])
      expect(second.metadata.titles).toEqual(['page-two'])
      expect(first.images.map(item => item.device)).toEqual(['desktop', 'mobile'])
      await expect(inspector.linkProbe!.probe(`http://127.0.0.1:${fixture.port}/page-two`, false)).resolves.toMatchObject({ status: 200 })
      expect(receivedBodies).toHaveLength(1)
      expect(receivedBodies[0]).toContain('password_protected_pwd=site-pass')
      expect(receivedBodies[0]).not.toContain('username')
    } finally {
      await inspector.close()
    }
  }, 30_000)

  it('パスワード誤りでは保護画面を通常ページとして検査しない', async () => {
    const fixture = await startHttpFixture((request, response) => {
      if (request.method === 'POST') {
        request.resume()
        return request.once('end', () => response.writeHead(200, { 'content-type': 'text/html' }).end(passwordProtectedLogin('/protected', 'incorrect password')))
      }
      if (request.headers.cookie?.includes('password-protected=accepted')) {
        return response.writeHead(200, { 'content-type': 'text/html' }).end('<title>real-page</title>')
      }
      response.writeHead(200, { 'content-type': 'text/html' }).end(passwordProtectedLogin('/protected'))
    })
    const settings = defaultProjectSettings()
    settings.allowedPrivateHosts = ['127.0.0.1']
    settings.auth.mode = 'password_protected'
    const inspector = await createPlaywrightInspector({
      settings,
      secrets: { password_protected: { password: 'wrong-pass' } },
      config: fastConfig(settings),
      authenticationUrl: `http://127.0.0.1:${fixture.port}/protected`,
    })
    try {
      await expect(inspector.authenticate()).rejects.toMatchObject({ code: 'AUTH_FAILED' })
    } finally {
      await inspector.close()
    }
  }, 30_000)

  it('フォーム認証のPOSTとCookieをdesktop/mobileへメモリ内で引き継ぐ', async () => {
    const fixture = await startHttpFixture((request, response) => {
      if (request.url === '/login' && request.method === 'GET') {
        return response.writeHead(200, { 'content-type': 'text/html' }).end('<form method="post"><input id="user" name="user"><input id="pass" name="pass" type="password"><button id="submit" type="submit">login</button></form>')
      }
      if (request.url === '/login' && request.method === 'POST') {
        request.resume()
        return request.once('end', () => response.writeHead(302, { location: '/protected', 'set-cookie': 'session=form-ok; Path=/; HttpOnly' }).end())
      }
      if (request.url === '/protected' && request.headers.cookie?.includes('session=form-ok')) {
        return response.writeHead(200, { 'content-type': 'text/html' }).end('<title>form-ok</title>')
      }
      response.writeHead(401).end()
    })
    const settings = defaultProjectSettings()
    settings.allowedPrivateHosts = ['127.0.0.1']
    settings.auth = {
      mode: 'form',
      loginUrl: `http://127.0.0.1:${fixture.port}/login`,
      usernameSelector: '#user',
      passwordSelector: '#pass',
      submitSelector: '#submit',
      successUrlPattern: '/protected',
    }
    const inspector = await createPlaywrightInspector({
      settings,
      secrets: { form: { username: 'form-user', password: 'form-pass' } },
      config: fastConfig(settings),
    })
    try {
      await inspector.authenticate()
      const result = await inspector.inspect(`http://127.0.0.1:${fixture.port}/protected`)
      expect(result.status).toBe(200)
      expect(result.metadata.titles).toEqual(['form-ok'])
    } finally {
      await inspector.close()
    }
  }, 30_000)
})

function fastConfig(settings = defaultProjectSettings()) {
  const config = createRunConfig(settings)
  config.imageScrollWaitMs = 1
  config.navigationTimeoutMs = 10_000
  return config
}

async function startProxy(_fixturePort: number, additionalAllowedHosts: string[] = []) {
  const privateHosts = ['safe.test', ...additionalAllowedHosts]
  const policy = new NetworkPolicy({
    allowedPrivateHosts: privateHosts,
    lookup: async hostname => privateHosts.includes(hostname)
      ? [{ address: '127.0.0.1', family: 4 }]
      : [{ address: '10.0.0.10', family: 4 }],
  })
  const proxy = new EgressProxy({ policy, connectTimeoutMs: 1_000, idleTimeoutMs: 2_000 })
  const endpoint = await proxy.start()
  cleanup.push(() => proxy.stop())
  return { proxy, endpoint }
}

function createClient(proxy: Awaited<ReturnType<typeof startProxy>>): EgressHttpClient {
  return new EgressHttpClient({
    proxy: proxy.endpoint,
    config: createRunConfig(defaultProjectSettings()),
    authorizeTarget: (url, method) => proxy.proxy.authorizeUrl(url, method),
  })
}

async function startHttpFixture(handler: RequestListener) {
  const server = createServer(handler)
  await listen(server)
  cleanup.push(() => closeServer(server))
  return { server, port: addressPort(server) }
}

function listen(server: Server): Promise<void> {
  return new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve))
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()))
}

function addressPort(server: Server): number {
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('port unavailable')
  return address.port
}

function rawProxyRequest(port: number, method: string, path: string): Promise<{ status: number, body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ host: '127.0.0.1', port, method, path }, response => {
      const chunks: Buffer[] = []
      response.on('data', chunk => chunks.push(Buffer.from(chunk)))
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    })
    request.once('error', reject)
    request.end()
  })
}

function rawConnectStatus(port: number, authority: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connectSocket(port, '127.0.0.1')
    socket.once('connect', () => socket.write(`CONNECT ${authority} HTTP/1.1\r\nHost: ${authority}\r\n\r\n`))
    socket.once('data', data => {
      const status = Number(data.toString().match(/^HTTP\/1\.1 (\d+)/)?.[1] ?? 0)
      socket.destroy()
      resolve(status)
    })
    socket.once('error', reject)
  })
}

function passwordProtectedLogin(redirectTo: string, error = ''): string {
  return `<!doctype html><html><head><title>保護画面</title></head><body class="login-password-protected"><p>${error}</p><form id="loginform" action="/?password-protected=login" method="post"><input id="password_protected_pass" type="password" name="password_protected_pwd"><input type="hidden" name="password-protected" value="login"><input type="hidden" name="redirect_to" value="${redirectTo}"><input id="wp-submit" type="submit" name="wp-submit" value="Log In"></form></body></html>`
}
