import { chromium, type Browser, type BrowserContext, type Page, type Request } from 'playwright'
import type { ProjectSecrets, ProjectSettings } from '~/shared/types/project'
import type { ImageDevice, SanitizedRunConfig } from '~/shared/types/run'
import type { CapturedImage } from './checks/images'
import type { CapturedLink, HttpProbeResult, LinkProbe } from './checks/links'
import type { RenderedMetadata } from './checks/metadata'
import type { TagNetworkObservation } from './checks/google-tags'
import { NetworkPolicy, NetworkPolicyError } from './network-policy'

export interface ImageViewportInspection {
  device: ImageDevice
  images: CapturedImage[]
  timedOut: boolean
  error?: string
}

export interface PageInspection {
  requestedUrl: string
  finalUrl: string
  status: number
  attempts: number
  rawHtml: string
  renderedHtml: string
  metadata: RenderedMetadata
  links: CapturedLink[]
  anchorTargets: string[]
  networkTags: TagNetworkObservation[]
  images: ImageViewportInspection[]
}

export interface WebsiteInspector {
  readonly linkProbe?: LinkProbe
  authenticate(): Promise<void>
  inspect(url: string, signal?: AbortSignal): Promise<PageInspection>
  close(): Promise<void>
}

export interface InspectorFactoryInput {
  settings: ProjectSettings
  secrets: ProjectSecrets
  config: SanitizedRunConfig
}

export type InspectorFactory = (input: InspectorFactoryInput) => Promise<WebsiteInspector>

export const createPlaywrightInspector: InspectorFactory = async ({ settings, secrets, config }) => {
  return PlaywrightWebsiteInspector.create(settings, secrets, config)
}

export class PageInspectionError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly retryable: boolean,
    readonly attempts: number,
    readonly status?: number,
  ) {
    super(message)
  }
}

class PlaywrightWebsiteInspector implements WebsiteInspector {
  private authenticating = false
  private readonly loginOrigin: string | null
  readonly linkProbe: LinkProbe

  private constructor(
    private readonly browser: Browser,
    private readonly context: BrowserContext,
    private readonly settings: ProjectSettings,
    private readonly secrets: ProjectSecrets,
    private readonly config: SanitizedRunConfig,
    private readonly policy: NetworkPolicy,
  ) {
    this.loginOrigin = settings.auth.loginUrl ? safeOrigin(settings.auth.loginUrl) : null
    this.linkProbe = new ContextLinkProbe(context, policy, config)
  }

  static async create(settings: ProjectSettings, secrets: ProjectSecrets, config: SanitizedRunConfig): Promise<PlaywrightWebsiteInspector> {
    const browser = await chromium.launch({ headless: true })
    const context = await browser.newContext({
      acceptDownloads: false,
      serviceWorkers: 'block',
      httpCredentials: settings.auth.mode === 'basic' && secrets.basic
        ? { username: secrets.basic.username, password: secrets.basic.password }
        : undefined,
      viewport: config.viewports.desktop,
    })
    const policy = new NetworkPolicy({ allowedPrivateHosts: settings.allowedPrivateHosts })
    const inspector = new PlaywrightWebsiteInspector(browser, context, settings, secrets, config, policy)
    await context.route('**/*', async (route) => {
      const request = route.request()
      try {
        await inspector.assertRequestAllowed(request)
        await route.continue()
      } catch {
        await route.abort('blockedbyclient')
      }
    })
    return inspector
  }

  async authenticate(): Promise<void> {
    if (this.settings.auth.mode !== 'form') return
    const credentials = this.secrets.form
    if (!credentials) throw new PageInspectionError('フォーム認証情報が設定されていません。', 'AUTH_MISSING', false, 0)
    await this.policy.assertUrl(this.settings.auth.loginUrl)
    const page = await this.context.newPage()
    this.authenticating = true
    try {
      const response = await page.goto(this.settings.auth.loginUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.config.navigationTimeoutMs,
      })
      if (!response || response.status() >= 400) throw new Error('ログインページを取得できません')
      await page.locator(this.settings.auth.usernameSelector).fill(credentials.username)
      await page.locator(this.settings.auth.passwordSelector).fill(credentials.password)
      await page.locator(this.settings.auth.submitSelector).click()
      await page.waitForLoadState('domcontentloaded', { timeout: this.config.navigationTimeoutMs }).catch(() => undefined)
      if (this.settings.auth.successUrlPattern && !matchesUrlPattern(page.url(), this.settings.auth.successUrlPattern)) {
        throw new PageInspectionError('フォーム認証の成功URL条件を満たしませんでした。', 'AUTH_FAILED', false, 1)
      }
    } catch (error) {
      if (error instanceof PageInspectionError) throw error
      throw new PageInspectionError('フォーム認証に失敗しました。', 'AUTH_FAILED', false, 1)
    } finally {
      this.authenticating = false
      await page.close()
    }
  }

  async inspect(url: string, signal?: AbortSignal): Promise<PageInspection> {
    return withPageRetries(
      attempt => this.inspectAttempt(url, attempt, signal),
      this.config.retryCount,
      normalizeInspectionError,
      signal,
    )
  }

  async close(): Promise<void> {
    await this.context.close().catch(() => undefined)
    await this.browser.close().catch(() => undefined)
  }

  private async inspectAttempt(url: string, attempt: number, signal?: AbortSignal): Promise<PageInspection> {
    await this.policy.assertUrl(url)
    const page = await this.context.newPage()
    await page.setViewportSize(this.config.viewports.desktop)
    const networkTags: TagNetworkObservation[] = []
    const imageFailures = new Map<string, string>()
    const imageSuccesses = new Set<string>()
    let mainResponseOversized = false
    const client = await this.context.newCDPSession(page)
    await client.send('Network.enable')
    client.on('Network.requestWillBeSent', (event: CdpRequestEvent) => {
      networkTags.push({ url: event.request.url, initiatorUrls: collectInitiatorUrls(event.initiator) })
    })
    page.on('requestfailed', request => {
      if (request.resourceType() === 'image') imageFailures.set(request.url(), request.failure()?.errorText ?? '通信失敗')
    })
    page.on('response', response => {
      const length = Number(response.headers()['content-length'] ?? '0')
      if (response.request().isNavigationRequest() && length > this.config.maxResponseBytes) mainResponseOversized = true
      if (response.request().resourceType() === 'image') {
        if (length > this.config.maxResponseBytes) imageFailures.set(response.url(), '画像の応答サイズが上限を超えました')
        else if (response.status() >= 400) imageFailures.set(response.url(), `HTTP ${response.status()}`)
        else imageSuccesses.add(response.url())
      }
    })

    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.config.navigationTimeoutMs,
      })
      if (!response) throw new PageInspectionError('ページの応答を取得できませんでした。', 'NO_RESPONSE', true, attempt)
      const status = response.status()
      if (status === 429 || status >= 500) {
        throw new PageInspectionError(`ページ取得がHTTP ${status}でした。`, `HTTP_${status}`, true, attempt, status)
      }
      if (status >= 400) {
        throw new PageInspectionError(`ページ取得がHTTP ${status}でした。`, `HTTP_${status}`, false, attempt, status)
      }
      await page.waitForLoadState('networkidle', { timeout: Math.min(2_000, this.config.navigationTimeoutMs) }).catch(() => undefined)
      if (mainResponseOversized) {
        throw new PageInspectionError('ページ内の応答サイズが上限を超えました。', 'RESPONSE_TOO_LARGE', false, attempt)
      }
      const rawBody = await response.body()
      if (rawBody.byteLength > this.config.maxResponseBytes) {
        throw new PageInspectionError('ページ本文がサイズ上限を超えました。', 'RESPONSE_TOO_LARGE', false, attempt)
      }
      const rawHtml = rawBody.toString('utf8')
      const renderedHtml = (await page.content()).slice(0, this.config.maxResponseBytes)
      const metadata = await captureMetadata(page)
      const links = await captureLinks(page)
      const anchorTargets = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[id], a[name]')]
        .flatMap(element => [element.id, element.getAttribute('name') ?? ''])
        .filter(Boolean))
      const desktopImages = await this.inspectImagesOnLoadedPage(page, 'desktop', imageFailures, imageSuccesses, signal)
      const mobileImages = await this.inspectMobileImages(url, signal)
      return {
        requestedUrl: url,
        finalUrl: page.url(),
        status,
        attempts: attempt,
        rawHtml,
        renderedHtml,
        metadata,
        links,
        anchorTargets,
        networkTags,
        images: [desktopImages, mobileImages],
      }
    } finally {
      await client.detach().catch(() => undefined)
      await page.close()
    }
  }

  private async inspectMobileImages(url: string, signal?: AbortSignal): Promise<ImageViewportInspection> {
    const startedAt = Date.now()
    const page = await this.context.newPage()
    const failures = new Map<string, string>()
    const successes = new Set<string>()
    page.on('requestfailed', request => {
      if (request.resourceType() === 'image') failures.set(request.url(), request.failure()?.errorText ?? '通信失敗')
    })
    page.on('response', response => {
      if (response.request().resourceType() === 'image') {
        const length = Number(response.headers()['content-length'] ?? '0')
        if (length > this.config.maxResponseBytes) failures.set(response.url(), '画像の応答サイズが上限を超えました')
        else if (response.status() >= 400) failures.set(response.url(), `HTTP ${response.status()}`)
        else successes.add(response.url())
      }
    })
    try {
      await page.setViewportSize(this.config.viewports.mobile)
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(this.config.navigationTimeoutMs, this.config.imageTimeoutMsPerDevice),
      })
      if (!response || response.status() >= 400) {
        return { device: 'mobile', images: [], timedOut: false, error: response ? `HTTP ${response.status()}` : '応答なし' }
      }
      const remaining = this.config.imageTimeoutMsPerDevice - (Date.now() - startedAt)
      if (remaining <= 0) return { device: 'mobile', images: [], timedOut: true }
      return await this.inspectImagesOnLoadedPage(page, 'mobile', failures, successes, signal, remaining)
    } catch (error) {
      return { device: 'mobile', images: [], timedOut: false, error: safeErrorMessage(error) }
    } finally {
      await page.close()
    }
  }

  private async inspectImagesOnLoadedPage(
    page: Page,
    device: ImageDevice,
    failures: Map<string, string>,
    successes: Set<string>,
    signal?: AbortSignal,
    timeoutMs = this.config.imageTimeoutMsPerDevice,
  ): Promise<ImageViewportInspection> {
    const timedOut = await performProgressiveScroll({
      state: () => page.evaluate(() => ({ y: window.scrollY, height: document.documentElement.scrollHeight, viewport: window.innerHeight })),
      scrollBy: step => page.evaluate(value => window.scrollBy(0, value), step),
      wait: milliseconds => page.waitForTimeout(milliseconds),
    }, timeoutMs, this.config.imageScrollWaitMs, () => Date.now(), signal)
    const captured = await captureImages(page)
    for (const image of captured) {
      const failure = failures.get(image.imageUrl)
      if (failure) image.networkError = failure
      else if (successes.has(image.imageUrl) && image.decoded === null) {
        image.complete = true
        image.naturalWidth = 1
        image.decoded = true
      }
    }
    return { device, images: captured, timedOut }
  }

  private async assertRequestAllowed(request: Request): Promise<void> {
    const method = request.method().toUpperCase()
    const origin = safeOrigin(request.url())
    const allowedLoginMutation = this.authenticating
      && this.loginOrigin !== null
      && origin === this.loginOrigin
      && method === 'POST'
    if (!['GET', 'HEAD'].includes(method) && !allowedLoginMutation) {
      throw new NetworkPolicyError(`${method}リクエストを拒否しました`)
    }
    if (request.resourceType() === 'websocket') throw new NetworkPolicyError('WebSocket通信を拒否しました')
    await this.policy.assertUrl(request.url())
    if (redirectCount(request) > this.config.maxRedirects) {
      throw new NetworkPolicyError('リダイレクト回数が上限を超えました')
    }
  }
}

class ContextLinkProbe implements LinkProbe {
  constructor(
    private readonly context: BrowserContext,
    private readonly policy: NetworkPolicy,
    private readonly config: SanitizedRunConfig,
  ) {}

  async probe(value: string, includeBody: boolean, signal?: AbortSignal): Promise<HttpProbeResult> {
    let current = value
    let redirectCount = 0
    while (true) {
      if (signal?.aborted) throw new Error('リンク検査が中止されました')
      await this.policy.assertUrl(current)
      const response = await this.context.request.fetch(current, {
        method: includeBody ? 'GET' : 'HEAD',
        failOnStatusCode: false,
        maxRedirects: 0,
        timeout: this.config.linkTimeoutMs,
        headers: { 'user-agent': 'WebsiteDeliveryChecker/1.0' },
      })
      try {
        const location = response.headers()['location']
        if (response.status() >= 300 && response.status() < 400 && location) {
          if (redirectCount >= this.config.maxRedirects) {
            throw new NetworkPolicyError(`リダイレクト回数が上限${this.config.maxRedirects}回を超えました`)
          }
          current = new URL(location, current).href
          redirectCount += 1
          continue
        }
        const length = Number(response.headers()['content-length'] ?? '0')
        if (length > this.config.maxResponseBytes) {
          throw new NetworkPolicyError(`応答サイズが上限${this.config.maxResponseBytes}バイトを超えています`)
        }
        let body: string | undefined
        if (includeBody) {
          const bytes = await response.body()
          if (bytes.byteLength > this.config.maxResponseBytes) {
            throw new NetworkPolicyError(`応答サイズが上限${this.config.maxResponseBytes}バイトを超えています`)
          }
          body = bytes.toString('utf8')
        }
        return {
          requestedUrl: value,
          finalUrl: response.url(),
          status: response.status(),
          contentType: response.headers()['content-type'] ?? '',
          redirectCount,
          body,
        }
      } finally {
        await response.dispose()
      }
    }
  }
}

export interface ProgressiveScrollDriver {
  state(): Promise<{ y: number; height: number; viewport: number }>
  scrollBy(step: number): Promise<unknown>
  wait(milliseconds: number): Promise<unknown>
}

export async function performProgressiveScroll(
  driver: ProgressiveScrollDriver,
  timeoutMs: number,
  waitMs: number,
  now: () => number = () => Date.now(),
  signal?: AbortSignal,
): Promise<boolean> {
  const deadline = now() + timeoutMs
  let previousHeight = 0
  while (true) {
    if (signal?.aborted) return false
    const state = await driver.state()
    if (now() >= deadline) return true
    if (state.y + state.viewport >= state.height && state.height === previousHeight) return false
    previousHeight = state.height
    await driver.scrollBy(Math.max(1, Math.floor(state.viewport * 0.8)))
    const remaining = deadline - now()
    if (remaining <= 0) return true
    await driver.wait(Math.min(waitMs, 2_000, remaining))
  }
}

export async function withPageRetries<T>(
  operation: (attempt: number) => Promise<T>,
  retryCount: number,
  normalize: (error: unknown, attempt: number) => PageInspectionError,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= retryCount + 1; attempt += 1) {
    if (signal?.aborted) throw new PageInspectionError('検査が中止されました。', 'ABORTED', false, attempt - 1)
    try {
      return await operation(attempt)
    } catch (error) {
      lastError = error
      const normalized = normalize(error, attempt)
      if (!normalized.retryable || attempt > retryCount) throw normalized
    }
  }
  throw normalize(lastError, retryCount + 1)
}

async function captureMetadata(page: Page): Promise<RenderedMetadata> {
  return page.evaluate(() => ({
    titles: [...document.querySelectorAll('title')].map(element => element.textContent ?? ''),
    descriptions: [...document.querySelectorAll<HTMLMetaElement>('meta[name="description" i]')]
      .map(element => element.getAttribute('content') ?? ''),
  }))
}

async function captureLinks(page: Page): Promise<CapturedLink[]> {
  return page.evaluate(() => [...document.querySelectorAll<HTMLAnchorElement>('a[href]')].map(anchor => ({
    href: anchor.getAttribute('href') ?? '',
    resolvedUrl: anchor.href,
    text: anchor.textContent ?? '',
    isImageLink: Boolean(anchor.querySelector('img, picture')),
  })))
}

async function captureImages(page: Page): Promise<CapturedImage[]> {
  return page.evaluate(async () => {
    type Item = CapturedImage
    const output: Item[] = []
    const seen = new Set<string>()
    const location = (element: Element): string => {
      const parts: string[] = []
      let current: Element | null = element
      while (current && parts.length < 5) {
        let part = current.tagName.toLowerCase()
        if (current.id) part += `#${current.id}`
        else if (current.classList.length) part += `.${[...current.classList].slice(0, 2).join('.')}`
        parts.unshift(part)
        current = current.parentElement
      }
      return parts.join(' > ')
    }
    const add = (item: Item) => {
      const key = `${item.imageUrl}|${item.sourceKind}|${item.location}`
      if (!item.imageUrl || seen.has(key)) return
      seen.add(key)
      output.push(item)
    }
    for (const image of document.querySelectorAll<HTMLImageElement>('img')) {
      const sourceKind = image.closest('picture')
        ? 'picture'
        : image.srcset ? 'srcset' : 'img'
      add({
        imageUrl: image.currentSrc || image.src,
        sourceKind,
        location: location(image),
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        decoded: image.complete ? image.naturalWidth > 0 : null,
      })
    }
    const cssUrls = (value: string): string[] => [...value.matchAll(/url\(["']?([^"')]+)["']?\)/gi)].map(match => match[1]!)
    for (const element of document.querySelectorAll<HTMLElement>('body *')) {
      const normal = getComputedStyle(element)
      for (const url of cssUrls(normal.backgroundImage)) {
        add({ imageUrl: new URL(url, document.baseURI).href, sourceKind: 'css_background', location: location(element), complete: null, naturalWidth: null, decoded: null })
      }
      for (const [pseudo, sourceKind] of [['::before', 'pseudo_before'], ['::after', 'pseudo_after']] as const) {
        const style = getComputedStyle(element, pseudo)
        for (const url of cssUrls(`${style.backgroundImage} ${style.content}`)) {
          add({ imageUrl: new URL(url, document.baseURI).href, sourceKind, location: `${location(element)}${pseudo}`, complete: null, naturalWidth: null, decoded: null })
        }
      }
    }
    await Promise.all(output.map(async (item) => {
      if (item.decoded !== null || !/^(?:data|blob):/i.test(item.imageUrl)) return
      const probe = new Image()
      const loaded = await new Promise<boolean>((resolve) => {
        const timeout = window.setTimeout(() => resolve(false), 1_000)
        probe.onload = () => { window.clearTimeout(timeout); resolve(true) }
        probe.onerror = () => { window.clearTimeout(timeout); resolve(false) }
        probe.src = item.imageUrl
      })
      item.complete = true
      item.naturalWidth = probe.naturalWidth
      item.decoded = loaded && probe.naturalWidth > 0
    }))
    return output
  })
}

function redirectCount(request: Request): number {
  let count = 0
  let current = request.redirectedFrom()
  while (current) {
    count += 1
    current = current.redirectedFrom()
  }
  return count
}

function normalizeInspectionError(error: unknown, attempts: number): PageInspectionError {
  if (error instanceof PageInspectionError) return error
  if (error instanceof NetworkPolicyError) return new PageInspectionError(error.message, error.code, false, attempts)
  const message = safeErrorMessage(error)
  const retryable = /timeout|timed out|econnreset|connection reset|net::err_(?:timed_out|connection_reset|connection_closed|connection_refused)/i.test(message)
  return new PageInspectionError(retryable ? '一時的な通信エラーでページを取得できませんでした。' : 'ページを取得できませんでした。', retryable ? 'TRANSIENT_NETWORK_ERROR' : 'PAGE_FETCH_FAILED', retryable, attempts)
}

function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '不明なエラー'
  return message
    .replace(/(?:authorization|cookie|password|token|secret)\s*[:=]\s*\S+/gi, '[REDACTED]')
    .slice(0, 1_000)
}

function safeOrigin(value: string): string | null {
  try {
    return new URL(value).origin
  } catch {
    return null
  }
}

function matchesUrlPattern(value: string, pattern: string): boolean {
  if (!pattern) return true
  const candidate = pattern.startsWith('/') ? `${new URL(value).pathname}${new URL(value).search}` : value
  const escaped = pattern.split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  return new RegExp(`^${escaped}$`).test(candidate)
}

interface CdpRequestEvent {
  request: { url: string }
  initiator?: CdpInitiator
}

interface CdpInitiator {
  url?: string
  stack?: { callFrames?: Array<{ url?: string }>; parent?: CdpInitiator['stack'] }
}

function collectInitiatorUrls(initiator: CdpInitiator | undefined): string[] {
  const output: string[] = []
  if (initiator?.url) output.push(initiator.url)
  let stack = initiator?.stack
  while (stack) {
    for (const frame of stack.callFrames ?? []) if (frame.url) output.push(frame.url)
    stack = stack.parent
  }
  return [...new Set(output)]
}
