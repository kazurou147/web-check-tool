import { chromium, devices, type Browser, type BrowserContext, type BrowserContextOptions, type Page, type Request } from 'playwright'
import type { ProjectSecrets, ProjectSettings } from '~/shared/types/project'
import type { ImageDevice, ImageScrollDiagnostics, MobileEmulationSnapshot, SanitizedRunConfig } from '~/shared/types/run'
import type { CapturedImage } from './checks/images'
import type { CapturedLink, LinkProbe } from './checks/links'
import type { RenderedMetadata } from './checks/metadata'
import type { TagNetworkObservation } from './checks/google-tags'
import { NetworkPolicy, NetworkPolicyError } from './network-policy'
import { isAbortError, RunCanceledError, throwIfAborted } from './abort'
import { EgressProxy } from './egress-proxy'
import { browserCookieProvider, EgressHttpClient } from './egress-http-client'
import { SECURITY_ERROR_CODES, SECURITY_LIMITS } from '~/shared/security/security-constants'

export interface ImageViewportInspection {
  device: ImageDevice
  images: CapturedImage[]
  timedOut: boolean
  scroll?: ImageScrollDiagnostics
  error?: string
  candidateLimit?: { limit: number; observedAtLeast: number }
}

export const MOBILE_DEVICE_PROFILE_NAME = 'Pixel 5' as const
export const IMAGE_SCROLL_STEP_VIEWPORT_RATIO = 0.8
export const IMAGE_SCROLL_WAIT_MAX_MS = 1_000
export const IMAGE_SCROLL_MAX_COUNT = 60
export const IMAGE_SCROLL_BOTTOM_STABLE_COUNT = 2
export const IMAGE_SCROLL_NO_PROGRESS_COUNT = 3

export function mobileEmulationSnapshot(): MobileEmulationSnapshot {
  const profile = devices[MOBILE_DEVICE_PROFILE_NAME]
  return {
    deviceProfile: MOBILE_DEVICE_PROFILE_NAME,
    userAgent: profile.userAgent,
    viewport: { width: 375, height: 667 },
    screen: { width: 375, height: 667 },
    deviceScaleFactor: profile.deviceScaleFactor,
    isMobile: true,
    hasTouch: true,
  }
}

export function createMobileContextOptions(
  config: SanitizedRunConfig,
  httpCredentials?: { username: string; password: string },
  storageState?: BrowserContextOptions['storageState'],
): BrowserContextOptions {
  const mobile = config.mobileEmulation ?? mobileEmulationSnapshot()
  return {
    acceptDownloads: false,
    serviceWorkers: 'block',
    httpCredentials,
    storageState,
    userAgent: mobile.userAgent,
    viewport: mobile.viewport,
    screen: mobile.screen,
    deviceScaleFactor: mobile.deviceScaleFactor,
    isMobile: mobile.isMobile,
    hasTouch: mobile.hasTouch,
  }
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
  linkCandidateLimit?: { limit: number; observedAtLeast: number }
}

export interface WebsiteInspector {
  readonly linkProbe?: LinkProbe
  authenticate(signal?: AbortSignal): Promise<void>
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
    private mobileContext: BrowserContext,
    private readonly settings: ProjectSettings,
    private readonly secrets: ProjectSecrets,
    private readonly config: SanitizedRunConfig,
    private readonly policy: NetworkPolicy,
    private readonly proxy: EgressProxy,
    linkProbe: LinkProbe,
  ) {
    this.loginOrigin = settings.auth.loginUrl ? safeOrigin(settings.auth.loginUrl) : null
    this.linkProbe = linkProbe
  }

  static async create(settings: ProjectSettings, secrets: ProjectSecrets, config: SanitizedRunConfig): Promise<PlaywrightWebsiteInspector> {
    const policy = new NetworkPolicy({ allowedPrivateHosts: settings.allowedPrivateHosts })
    const proxy = new EgressProxy({ policy, connectTimeoutMs: config.linkTimeoutMs, idleTimeoutMs: config.navigationTimeoutMs })
    const endpoint = await proxy.start()
    let browser: Browser | undefined
    let context: BrowserContext | undefined
    let mobileContext: BrowserContext | undefined
    const httpCredentials = settings.auth.mode === 'basic' && secrets.basic
      ? { username: secrets.basic.username, password: secrets.basic.password }
      : undefined
    try {
      browser = await chromium.launch({
        headless: true,
        proxy: { server: endpoint.server, bypass: '<-loopback>' },
        args: [
          '--proxy-bypass-list=<-loopback>',
          '--disable-quic',
          '--disable-features=WebTransport',
          '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
        ],
      })
      context = await browser.newContext({
        acceptDownloads: false,
        serviceWorkers: 'block',
        httpCredentials,
        viewport: config.viewports.desktop,
      })
      mobileContext = await browser.newContext(createMobileContextOptions(config, httpCredentials))
      const linkProbe = new EgressHttpClient({
        proxy: endpoint,
        config,
        authorizeTarget: (url, method) => proxy.authorizeUrl(url, method),
        cookieProvider: browserCookieProvider(context),
        ...(httpCredentials ? { basicCredentials: httpCredentials } : {}),
      })
      const inspector = new PlaywrightWebsiteInspector(browser, context, mobileContext, settings, secrets, config, policy, proxy, linkProbe)
      await inspector.hardenContext(context)
      await inspector.hardenContext(mobileContext)
      return inspector
    } catch (error) {
      await mobileContext?.close().catch(() => undefined)
      await context?.close().catch(() => undefined)
      await browser?.close().catch(() => undefined)
      await proxy.stop().catch(() => undefined)
      throw error
    }
  }

  async authenticate(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
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
      throwIfAborted(signal)
      if (!response || response.status() >= 400) throw new Error('ログインページを取得できません')
      await page.locator(this.settings.auth.usernameSelector).fill(credentials.username)
      await page.locator(this.settings.auth.passwordSelector).fill(credentials.password)
      await page.locator(this.settings.auth.submitSelector).click()
      throwIfAborted(signal)
      await page.waitForLoadState('domcontentloaded', { timeout: this.config.navigationTimeoutMs }).catch(() => undefined)
      if (this.settings.auth.successUrlPattern && !matchesUrlPattern(page.url(), this.settings.auth.successUrlPattern)) {
        throw new PageInspectionError('フォーム認証の成功URL条件を満たしませんでした。', 'AUTH_FAILED', false, 1)
      }
      const storageState = await this.context.storageState()
      throwIfAborted(signal)
      await this.mobileContext.close()
      throwIfAborted(signal)
      this.mobileContext = await this.browser.newContext(createMobileContextOptions(this.config, undefined, storageState))
      await this.hardenContext(this.mobileContext)
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw new RunCanceledError()
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
    await this.mobileContext.close().catch(() => undefined)
    await this.context.close().catch(() => undefined)
    await this.browser.close().catch(() => undefined)
    await this.proxy.stop().catch(() => undefined)
  }

  private async inspectAttempt(url: string, attempt: number, signal?: AbortSignal): Promise<PageInspection> {
    throwIfAborted(signal)
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
      if (request.resourceType() === 'image' && (imageFailures.has(request.url()) || imageFailures.size < SECURITY_LIMITS.imageCandidatesPerDevice)) {
        imageFailures.set(request.url(), request.failure()?.errorText ?? '通信失敗')
      }
    })
    page.on('response', response => {
      const length = Number(response.headers()['content-length'] ?? '0')
      if (response.request().isNavigationRequest() && length > this.config.maxResponseBytes) mainResponseOversized = true
      if (response.request().resourceType() === 'image') {
        if (length > this.config.maxResponseBytes) {
          if (imageFailures.has(response.url()) || imageFailures.size < SECURITY_LIMITS.imageCandidatesPerDevice) imageFailures.set(response.url(), '画像の応答サイズが上限を超えました')
        } else if (response.status() >= 400) {
          if (imageFailures.has(response.url()) || imageFailures.size < SECURITY_LIMITS.imageCandidatesPerDevice) imageFailures.set(response.url(), `HTTP ${response.status()}`)
        } else if (imageSuccesses.has(response.url()) || imageSuccesses.size < SECURITY_LIMITS.imageCandidatesPerDevice) imageSuccesses.add(response.url())
      }
    })

    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: this.config.navigationTimeoutMs,
      })
      throwIfAborted(signal)
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
      const capturedLinks = await captureLinks(page, (this.settings.ai?.mode ?? 'off') !== 'off')
      const anchorTargets = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('[id], a[name]')]
        .flatMap(element => [element.id, element.getAttribute('name') ?? ''])
        .filter(Boolean))
      const desktopImages = await this.inspectImagesOnLoadedPage(page, 'desktop', imageFailures, imageSuccesses, signal)
      throwIfAborted(signal)
      const mobileImages = await this.inspectMobileImages(url, signal)
      throwIfAborted(signal)
      return {
        requestedUrl: url,
        finalUrl: page.url(),
        status,
        attempts: attempt,
        rawHtml,
        renderedHtml,
        metadata,
        links: capturedLinks.items,
        ...(capturedLinks.truncated ? { linkCandidateLimit: { limit: SECURITY_LIMITS.linkCandidatesPerPage, observedAtLeast: capturedLinks.observedAtLeast } } : {}),
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
    throwIfAborted(signal)
    const startedAt = Date.now()
    const page = await this.mobileContext.newPage()
    const failures = new Map<string, string>()
    const successes = new Set<string>()
    page.on('requestfailed', request => {
      if (request.resourceType() === 'image' && (failures.has(request.url()) || failures.size < SECURITY_LIMITS.imageCandidatesPerDevice)) {
        failures.set(request.url(), request.failure()?.errorText ?? '通信失敗')
      }
    })
    page.on('response', response => {
      if (response.request().resourceType() === 'image') {
        const length = Number(response.headers()['content-length'] ?? '0')
        if (length > this.config.maxResponseBytes) {
          if (failures.has(response.url()) || failures.size < SECURITY_LIMITS.imageCandidatesPerDevice) failures.set(response.url(), '画像の応答サイズが上限を超えました')
        } else if (response.status() >= 400) {
          if (failures.has(response.url()) || failures.size < SECURITY_LIMITS.imageCandidatesPerDevice) failures.set(response.url(), `HTTP ${response.status()}`)
        } else if (successes.has(response.url()) || successes.size < SECURITY_LIMITS.imageCandidatesPerDevice) successes.add(response.url())
      }
    })
    try {
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: Math.min(this.config.navigationTimeoutMs, this.config.imageTimeoutMsPerDevice),
      })
      throwIfAborted(signal)
      if (!response || response.status() >= 400) {
        return { device: 'mobile', images: [], timedOut: false, error: response ? `HTTP ${response.status()}` : '応答なし' }
      }
      const remaining = this.config.imageTimeoutMsPerDevice - (Date.now() - startedAt)
      if (remaining <= 0) return {
        device: 'mobile',
        images: [],
        timedOut: true,
        scroll: emptyScrollDiagnostics('time_limit', Date.now() - startedAt),
      }
      return await this.inspectImagesOnLoadedPage(page, 'mobile', failures, successes, signal, remaining)
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw new RunCanceledError()
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
    const scroll = await performProgressiveScroll({
      state: () => page.evaluate(() => ({ y: window.scrollY, height: document.documentElement.scrollHeight, viewport: window.innerHeight })),
      scrollBy: step => page.evaluate(value => window.scrollBy(0, value), step),
      wait: milliseconds => page.waitForTimeout(milliseconds),
    }, timeoutMs, this.config.imageScrollWaitMs, () => Date.now(), signal, {
      stepViewportRatio: this.config.imageScrollStepViewportRatio,
      maxScrollCount: this.config.imageScrollMaxCount,
      bottomStableCount: this.config.imageScrollBottomStableCount,
      noProgressCount: this.config.imageScrollNoProgressCount,
    })
    throwIfAborted(signal)
    const captured = await captureImages(page)
    throwIfAborted(signal)
    for (const image of captured.items) {
      const failure = failures.get(image.imageUrl)
      if (failure) image.networkError = failure
      else if (successes.has(image.imageUrl) && image.decoded === null) {
        image.complete = true
        image.naturalWidth = 1
        image.decoded = true
      }
    }
    return {
      device,
      images: captured.items,
      timedOut: scroll.stopReason === 'time_limit',
      scroll,
      ...(captured.truncated ? { candidateLimit: { limit: SECURITY_LIMITS.imageCandidatesPerDevice, observedAtLeast: captured.observedAtLeast } } : {}),
    }
  }

  private async installProtectedRoute(context: BrowserContext): Promise<void> {
    await context.route('**/*', async (route) => {
      const request = route.request()
      try {
        await this.assertRequestAllowed(request)
        await route.continue()
      } catch {
        await route.abort('blockedbyclient')
      }
    })
  }

  private async hardenContext(context: BrowserContext): Promise<void> {
    await context.addInitScript(() => {
      const blocked = () => { throw new DOMException('通信方式がセキュリティポリシーにより無効化されています', 'SecurityError') }
      for (const name of ['RTCPeerConnection', 'webkitRTCPeerConnection', 'WebTransport']) {
        try { Object.defineProperty(globalThis, name, { configurable: false, writable: false, value: blocked }) } catch { /* browser-defined non-configurable property */ }
      }
    })
    await this.installProtectedRoute(context)
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
    await this.proxy.authorizeUrl(request.url(), method)
    if (redirectCount(request) > this.config.maxRedirects) {
      throw new NetworkPolicyError('リダイレクト回数が上限を超えました')
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
  options: {
    stepViewportRatio?: number
    maxScrollCount?: number
    bottomStableCount?: number
    noProgressCount?: number
  } = {},
): Promise<ImageScrollDiagnostics> {
  const startedAt = now()
  const deadline = startedAt + timeoutMs
  const stepViewportRatio = options.stepViewportRatio ?? IMAGE_SCROLL_STEP_VIEWPORT_RATIO
  const maxScrollCount = options.maxScrollCount ?? IMAGE_SCROLL_MAX_COUNT
  const requiredBottomStableCount = options.bottomStableCount ?? IMAGE_SCROLL_BOTTOM_STABLE_COUNT
  const requiredNoProgressCount = options.noProgressCount ?? IMAGE_SCROLL_NO_PROGRESS_COUNT
  let previousState: { y: number; height: number; viewport: number } | undefined
  let scrollCount = 0
  let bottomStableCount = 0
  let noProgressCount = 0
  while (true) {
    if (signal?.aborted) return diagnostics('aborted', previousState, false)
    const state = await driver.state()
    const atBottom = state.y + state.viewport >= state.height
    if (atBottom) {
      bottomStableCount = previousState && previousState.height === state.height && previousState.y + previousState.viewport >= previousState.height
        ? bottomStableCount + 1
        : 1
    } else {
      bottomStableCount = 0
    }
    if (bottomStableCount >= requiredBottomStableCount) return diagnostics('bottom_stable', state, true)
    if (previousState && state.y <= previousState.y && !atBottom) noProgressCount += 1
    else noProgressCount = 0
    if (noProgressCount >= requiredNoProgressCount) return diagnostics('no_progress', state, false)
    if (now() >= deadline) return diagnostics('time_limit', state, false)
    if (scrollCount >= maxScrollCount) return diagnostics('scroll_limit', state, false)
    previousState = state
    await driver.scrollBy(Math.max(1, Math.floor(state.viewport * stepViewportRatio)))
    scrollCount += 1
    if (signal?.aborted) return diagnostics('aborted', state, false)
    const remaining = deadline - now()
    if (remaining <= 0) return diagnostics('time_limit', state, false)
    await driver.wait(Math.min(waitMs, IMAGE_SCROLL_WAIT_MAX_MS, remaining))
  }


  function diagnostics(
    stopReason: ImageScrollDiagnostics['stopReason'],
    state: { y: number; height: number; viewport: number } | undefined,
    reachedStableBottom: boolean,
  ): ImageScrollDiagnostics {
    return {
      stopReason,
      scrollCount,
      elapsedMs: Math.max(0, now() - startedAt),
      lastScrollY: state?.y ?? 0,
      lastDocumentHeight: state?.height ?? 0,
      viewportHeight: state?.viewport ?? 0,
      bottomStableCount,
      noProgressCount,
      reachedStableBottom,
    }
  }
}

function emptyScrollDiagnostics(stopReason: ImageScrollDiagnostics['stopReason'], elapsedMs: number): ImageScrollDiagnostics {
  return {
    stopReason,
    scrollCount: 0,
    elapsedMs: Math.max(0, elapsedMs),
    lastScrollY: 0,
    lastDocumentHeight: 0,
    viewportHeight: 0,
    bottomStableCount: 0,
    noProgressCount: 0,
    reachedStableBottom: false,
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
    throwIfAborted(signal)
    try {
      return await operation(attempt)
    } catch (error) {
      if (isAbortError(error) || signal?.aborted) throw new RunCanceledError()
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

async function captureLinks(page: Page, includeAiContext: boolean): Promise<{ items: CapturedLink[]; truncated: boolean; observedAtLeast: number }> {
  return page.evaluate(({ includeAiContext, maximum }) => {
    const body = document.body
    const limit = (value: string, maximumCharacters: number, side: 'start' | 'end') => {
      const characters = Array.from(value)
      return (side === 'start' ? characters.slice(0, maximumCharacters) : characters.slice(-maximumCharacters)).join('')
    }
    const anchors = document.querySelectorAll<HTMLAnchorElement>('a[href]')
    const items = Array.from({ length: Math.min(anchors.length, maximum) }, (_, index) => anchors[index]!).map(anchor => {
      let beforeText = ''
      let afterText = ''
      if (includeAiContext && body && body.contains(anchor)) {
        const before = document.createRange()
        before.selectNodeContents(body)
        before.setEndBefore(anchor)
        beforeText = limit(before.toString(), 200, 'end')
        const after = document.createRange()
        after.selectNodeContents(body)
        after.setStartAfter(anchor)
        afterText = limit(after.toString(), 200, 'start')
      }
      const href = anchor.getAttribute('href') ?? ''
      const resolvedUrl = anchor.href
      const urlTooLong = href.length > 8_192 || resolvedUrl.length > 8_192
      return {
        href: href.slice(0, 8_192),
        resolvedUrl: resolvedUrl.slice(0, 8_192),
        text: limit(anchor.textContent ?? '', 10_000, 'start'),
        beforeText,
        afterText,
        isImageLink: Boolean(anchor.querySelector('img, picture, svg')),
        ...(urlTooLong ? { captureError: 'リンクURLが安全な抽出上限を超えたため未確認です。' } : {}),
      }
    })
    return { items, truncated: anchors.length > maximum, observedAtLeast: Math.min(anchors.length, maximum + 1) }
  }, { includeAiContext, maximum: SECURITY_LIMITS.linkCandidatesPerPage })
}

async function captureImages(page: Page): Promise<{ items: CapturedImage[]; truncated: boolean; observedAtLeast: number }> {
  return page.evaluate(async (maximum) => {
    type Item = CapturedImage
    const output: Item[] = []
    let truncated = false
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
      if (item.imageUrl.length > 8_192) {
        item.imageUrl = item.imageUrl.slice(0, 8_192)
        item.currentSrc = item.currentSrc?.slice(0, 8_192)
        item.captureError = '画像URLが安全な抽出上限を超えたため未確認です。'
      }
      item.location = item.location.slice(0, 4_096)
      const key = `${item.imageUrl}|${item.sourceKind}|${item.location}`
      if (!item.imageUrl || seen.has(key)) return
      seen.add(key)
      if (output.length >= maximum) { truncated = true; return }
      output.push(item)
    }
    type ResponsiveHideRule = {
      selector: string
      property: 'display' | 'visibility' | 'content-visibility'
      value: string
      mediaCondition: string
      stylesheet: string
    }
    const responsiveHideRules: ResponsiveHideRule[] = []
    const responsiveFeature = /(?:^|[(:])\s*(?:min-|max-)?(?:width|height|inline-size|block-size|aspect-ratio|resolution|orientation|pointer|hover)\b/i
    const collectHideRules = (rules: CSSRuleList, mediaConditions: string[], stylesheet: string): void => {
      for (const rule of [...rules]) {
        if (rule.type === CSSRule.MEDIA_RULE) {
          const mediaRule = rule as CSSMediaRule
          if (window.matchMedia(mediaRule.conditionText).matches) {
            collectHideRules(mediaRule.cssRules, [...mediaConditions, mediaRule.conditionText], stylesheet)
          }
          continue
        }
        if (rule.type === CSSRule.STYLE_RULE && mediaConditions.some(condition => responsiveFeature.test(condition))) {
          const styleRule = rule as CSSStyleRule
          const hiddenDeclaration = ([
            ['display', styleRule.style.display],
            ['visibility', styleRule.style.visibility],
            ['content-visibility', styleRule.style.getPropertyValue('content-visibility')],
          ] as const).find(([property, value]) => (
            (property === 'display' && value === 'none')
            || (property === 'visibility' && /^(?:hidden|collapse)$/.test(value))
            || (property === 'content-visibility' && value === 'hidden')
          ))
          if (hiddenDeclaration) {
            responsiveHideRules.push({
              selector: styleRule.selectorText,
              property: hiddenDeclaration[0],
              value: hiddenDeclaration[1],
              mediaCondition: mediaConditions.join(' and '),
              stylesheet,
            })
          }
          continue
        }
        const groupedRule = rule as CSSGroupingRule
        if ('cssRules' in groupedRule) collectHideRules(groupedRule.cssRules, mediaConditions, stylesheet)
      }
    }
    for (const stylesheet of [...document.styleSheets]) {
      try {
        collectHideRules(stylesheet.cssRules, [], stylesheet.href ?? 'inline stylesheet')
      } catch {
        // Cross-origin stylesheets are unreadable. Without inspectable evidence the image stays needs_review.
      }
    }
    const elementName = (element: Element): string => {
      let name = element.tagName.toLowerCase()
      if (element.id) name += `#${element.id}`
      if (element.classList.length) name += `.${[...element.classList].slice(0, 3).join('.')}`
      return name
    }
    const interactivePattern = /(?:^|[-_])(?:accordion|collapse|dialog|drawer|lightbox|menu|modal|offcanvas|popover|popup|slider|carousel|tab)(?:$|[-_])/i
    const visibilityObservation = (image: HTMLImageElement): NonNullable<Item['visibility']> => {
      const rectangle = image.getBoundingClientRect()
      const nodes: Element[] = []
      let current: Element | null = image
      while (current) {
        nodes.push(current)
        current = current.parentElement
      }
      let hiddenAncestor: Element | undefined
      let hiddenProperty: NonNullable<Item['visibility']>['hiddenProperty']
      let hiddenValue: string | undefined
      let responsiveRule: ResponsiveHideRule | undefined
      for (const node of nodes) {
        const style = getComputedStyle(node)
        const hidden: Array<[NonNullable<typeof hiddenProperty>, string]> = [
          ['display', style.display],
          ['visibility', style.visibility],
          ['content-visibility', style.contentVisibility],
        ]
        const matchedHidden = hidden.find(([property, value]) => (
          (property === 'display' && value === 'none')
          || (property === 'visibility' && /^(?:hidden|collapse)$/.test(value))
          || (property === 'content-visibility' && value === 'hidden')
        ))
        if (!matchedHidden) continue
        const matchedRule = responsiveHideRules.find(rule => {
          if (rule.property !== matchedHidden[0] || rule.value !== matchedHidden[1]) return false
          try { return node.matches(rule.selector) } catch { return false }
        })
        if (!matchedRule) continue
        hiddenAncestor = node
        hiddenProperty = matchedHidden[0]
        hiddenValue = matchedHidden[1]
        responsiveRule = matchedRule
        break
      }

      const relevantNodes = hiddenAncestor ? nodes.slice(0, nodes.indexOf(hiddenAncestor) + 1) : nodes
      const interactiveEvidence: string[] = []
      for (const node of relevantNodes) {
        if (node.matches('dialog, details:not([open]), [popover], [role="dialog"], [role="menu"], [aria-expanded], [aria-haspopup], [inert], [hidden]')) {
          interactiveEvidence.push(`操作で表示される可能性がある要素: ${elementName(node)}`)
        }
        const tokens = `${node.id} ${[...node.classList].join(' ')}`.split(/\s+/)
        if (tokens.some(token => interactivePattern.test(token))) {
          interactiveEvidence.push(`操作UIを示す識別子: ${elementName(node)}`)
        }
      }
      if (hiddenAncestor?.id) {
        const controlled = [...document.querySelectorAll<HTMLElement>('[aria-controls], a[href^="#"]')].find(control => (
          control.getAttribute('aria-controls')?.split(/\s+/).includes(hiddenAncestor!.id)
          || control.getAttribute('href') === `#${hiddenAncestor!.id}`
        ))
        if (controlled) interactiveEvidence.push(`非表示要素を操作するコントロール: ${elementName(controlled)}`)
      }
      if (responsiveRule && /:(?:checked|focus|focus-within|hover|target|has)\b/.test(responsiveRule.selector)) {
        interactiveEvidence.push(`状態依存セレクター: ${responsiveRule.selector}`)
      }

      return {
        clientRectCount: image.getClientRects().length,
        layoutWidth: rectangle.width,
        layoutHeight: rectangle.height,
        ...(hiddenAncestor ? { hiddenAncestor: elementName(hiddenAncestor) } : {}),
        ...(hiddenProperty ? { hiddenProperty } : {}),
        ...(hiddenValue ? { hiddenValue } : {}),
        ...(responsiveRule ? {
          responsiveRule: {
            selector: responsiveRule.selector,
            mediaCondition: responsiveRule.mediaCondition,
            stylesheet: responsiveRule.stylesheet,
          },
        } : {}),
        interactiveRisk: interactiveEvidence.length > 0,
        interactiveEvidence,
      }
    }
    for (const image of document.querySelectorAll<HTMLImageElement>('img')) {
      if (truncated) break
      const sourceKind = image.closest('picture')
        ? 'picture'
        : image.srcset ? 'srcset' : 'img'
      add({
        imageUrl: image.currentSrc || image.src,
        sourceKind,
        location: location(image),
        currentSrc: image.currentSrc,
        complete: image.complete,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        decoded: image.complete ? image.naturalWidth > 0 : null,
        visibility: visibilityObservation(image),
      })
    }
    const cssUrls = (value: string): string[] => [...value.matchAll(/url\(["']?([^"')]+)["']?\)/gi)].map(match => match[1]!)
    for (const element of document.querySelectorAll<HTMLElement>('body *')) {
      if (truncated) break
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
    return { items: output, truncated, observedAtLeast: output.length + (truncated ? 1 : 0) }
  }, SECURITY_LIMITS.imageCandidatesPerDevice)
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
