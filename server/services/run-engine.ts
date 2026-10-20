import { randomUUID } from 'node:crypto'
import type { DuplicateUrlGroup, InputPageRow, InputSnapshot } from '~/shared/types/excel-input'
import type { Project, ProjectSecrets, ProjectSettings } from '~/shared/types/project'
import type {
  Finding,
  ImageResult,
  LinkResult,
  PageResult,
  RunResult,
  SafeError,
  SanitizedRunConfig,
  Verdict,
} from '~/shared/types/run'
import { checkGoogleTags } from './checks/google-tags'
import { checkImages } from './checks/images'
import { checkLinks, SafeLinkProbe, type LinkProbe } from './checks/links'
import { checkMetadata } from './checks/metadata'
import { readExcelInput } from './excel-input'
import { NetworkPolicy } from './network-policy'
import {
  createPlaywrightInspector,
  PageInspectionError,
  type InspectorFactory,
  type PageInspection,
  type WebsiteInspector,
} from './playwright-inspector'
import { ArchivedProjectError, type ProjectStore, useProjectStore } from './project-store'
import { RunStore } from './run-store'

export class RunBusyError extends Error {}
export class RunInputError extends Error {}

export type LinkProbeFactory = (settings: ProjectSettings, config: SanitizedRunConfig) => LinkProbe

export interface RunEngineDependencies {
  projectStore: ProjectStore
  runStore: RunStore
  inspectorFactory: InspectorFactory
  linkProbeFactory: LinkProbeFactory
  now: () => Date
}

export class RunEngine {
  constructor(private readonly dependencies: RunEngineDependencies) {}

  async prepare(projectId: string): Promise<PreparedRun> {
    const project = await this.dependencies.projectStore.get(projectId)
    if (project.archivedAt) throw new ArchivedProjectError('アーカイブ中の案件では検査を開始できません')
    if (!project.excelFileName) throw new RunInputError('Excelファイルが登録されていません')

    const input = await readExcelInput(this.dependencies.projectStore.excelPath(projectId), project.excelFileName)
    if (!input.canStart) throw new RunInputError('Excel入力に致命的な問題があるため検査を開始できません')
    const secrets = project.settings.auth.mode === 'none'
      ? {}
      : await this.dependencies.projectStore.vault.read(projectId)
    const runId = randomUUID()
    const now = this.dependencies.now().toISOString()
    const result: RunResult = {
      schemaVersion: 1,
      runId,
      projectId,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      configSnapshot: createRunConfig(project.settings),
      input,
      summary: emptySummary(),
      pages: [],
      links: [],
      images: [],
      googleTagDetections: [],
      aiUsage: {
        enabled: false,
        inputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        costLimitUsd: 1,
        stoppedByCostLimit: false,
      },
    }
    await this.dependencies.runStore.create(projectId, runId, input, result)
    return { project, secrets, input, result }
  }

  async execute(prepared: PreparedRun): Promise<RunResult> {
    const { project, secrets, input, result } = prepared
    let inspector: WebsiteInspector | undefined
    try {
      await this.transition(result, 'reading_input')
      await this.transition(result, 'authenticating', true)
      inspector = await this.dependencies.inspectorFactory({ settings: project.settings, secrets, config: result.configSnapshot })
      await inspector.authenticate()
      await this.transition(result, 'checking')
      const groups = groupRows(input.pageRows)
      const queue = [...groups.entries()]
      const workerCount = Math.min(project.settings.pageConcurrency, queue.length)
      const probe = inspector.linkProbe ?? this.dependencies.linkProbeFactory(project.settings, result.configSnapshot)
      await Promise.all(Array.from({ length: workerCount }, () => this.worker(queue, input, result, inspector!, probe)))
      result.status = 'completed'
      result.finishedAt = this.dependencies.now().toISOString()
      result.updatedAt = result.finishedAt
      result.summary = summarize(result)
      await this.dependencies.runStore.saveResult(result.projectId, result.runId, result)
      await this.event(result, 'run_completed')
      return result
    } catch (error) {
      result.status = 'failed'
      result.finishedAt = this.dependencies.now().toISOString()
      result.updatedAt = result.finishedAt
      result.fatalError = safeError(error)
      result.summary = summarize(result)
      await this.dependencies.runStore.saveResult(result.projectId, result.runId, result)
      await this.event(result, 'run_failed', { code: result.fatalError.code })
      return result
    } finally {
      await inspector?.close().catch(() => undefined)
    }
  }

  private async worker(
    queue: Array<[string, InputPageRow[]]>,
    input: InputSnapshot,
    result: RunResult,
    inspector: WebsiteInspector,
    probe: LinkProbe,
  ): Promise<void> {
    while (true) {
      const next = queue.shift()
      if (!next) return
      const [normalizedUrl, rows] = next
      const startedAt = this.dependencies.now().toISOString()
      let pageResult: PageResult
      try {
        const inspection = await inspector.inspect(rows[0]!.url)
        pageResult = await this.buildSuccessfulPage(normalizedUrl, rows, input, inspection, probe, startedAt)
        result.links.push(...pageResultLinks.get(pageResult)!)
        result.images.push(...pageResultImages.get(pageResult)!)
        result.googleTagDetections.push(...pageResultTags.get(pageResult)!)
      } catch (error) {
        pageResult = buildFailedPageResult(normalizedUrl, rows, startedAt, this.dependencies.now().toISOString(), error)
      } finally {
        // WeakMaps are only temporary carriers so the persisted page structure stays specification-focused.
      }
      result.pages.push(pageResult)
      result.pages.sort((left, right) => left.sourceRows[0]! - right.sourceRows[0]!)
      result.updatedAt = this.dependencies.now().toISOString()
      result.summary = summarize(result)
      await this.dependencies.runStore.saveResult(result.projectId, result.runId, result)
      await this.event(result, 'page_completed', { url: normalizedUrl, verdict: pageResult.findings[0]?.verdict })
      pageResultLinks.delete(pageResult)
      pageResultImages.delete(pageResult)
      pageResultTags.delete(pageResult)
    }
  }

  private async buildSuccessfulPage(
    normalizedUrl: string,
    rows: InputPageRow[],
    input: InputSnapshot,
    inspection: PageInspection,
    probe: LinkProbe,
    startedAt: string,
  ): Promise<PageResult> {
    const pageNames = rows.map(row => row.displayName)
    const sourceRows = rows.map(row => row.sourceRow)
    const duplicate = input.duplicateGroups.find(group => group.normalizedUrl === normalizedUrl)
    const pageFetch: Finding = {
      key: `${normalizedUrl}|page_fetch`,
      item: 'page_fetch',
      verdict: 'ok',
      detailStatus: 'fetched',
      url: normalizedUrl,
      pageNames,
      sourceRows,
      actual: { status: inspection.status, finalUrl: redactForResult(inspection.finalUrl) },
      message: 'ページを取得しました。',
      evidence: [`HTTP ${inspection.status}`, `試行回数: ${inspection.attempts}`],
    }
    const metadata = checkMetadata(normalizedUrl, rows, duplicate, inspection.metadata)
    const tags = checkGoogleTags({
      pageUrl: normalizedUrl,
      pageNames,
      sourceRows,
      rawHtml: inspection.rawHtml,
      renderedHtml: inspection.renderedHtml,
      network: inspection.networkTags,
      expected: input.expectedGoogleTags,
    })
    const links = await checkLinks(normalizedUrl, inspection.links, new Set(inspection.anchorTargets), probe, undefined, inspection.finalUrl)
    const images = inspection.images.flatMap(viewport => checkImages(normalizedUrl, viewport.device, viewport.images, viewport.timedOut))
    const linkFinding = aggregateLinkFinding(normalizedUrl, pageNames, sourceRows, links)
    const imageFinding = aggregateImageFinding(normalizedUrl, pageNames, sourceRows, images, inspection)
    const page: PageResult = {
      normalizedUrl,
      requestedUrl: redactForResult(inspection.requestedUrl),
      finalUrl: redactForResult(inspection.finalUrl),
      pageNames,
      sourceRows,
      startedAt,
      finishedAt: this.dependencies.now().toISOString(),
      attempts: inspection.attempts,
      httpStatus: inspection.status,
      findings: [pageFetch, ...metadata, tags.finding, linkFinding, imageFinding],
    }
    pageResultLinks.set(page, links)
    pageResultImages.set(page, images)
    pageResultTags.set(page, tags.detections)
    return page
  }

  private async transition(result: RunResult, status: RunResult['status'], setStarted = false): Promise<void> {
    result.status = status
    const now = this.dependencies.now().toISOString()
    if (setStarted && !result.startedAt) result.startedAt = now
    result.updatedAt = now
    await this.dependencies.runStore.saveResult(result.projectId, result.runId, result)
    await this.event(result, 'status_changed', { status })
  }

  private async event(result: RunResult, type: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.dependencies.runStore.appendEvent(result.projectId, result.runId, {
      at: this.dependencies.now().toISOString(),
      type,
      ...details,
    })
  }
}

interface PreparedRun {
  project: Project
  secrets: ProjectSecrets
  input: InputSnapshot
  result: RunResult
}

export class RunCoordinator {
  private active: Promise<RunResult> | null = null
  private starting = false

  constructor(private readonly engine: RunEngine) {}

  async start(projectId: string): Promise<RunResult> {
    if (this.active || this.starting) throw new RunBusyError('別の検査を実行中です')
    this.starting = true
    try {
      const prepared = await this.engine.prepare(projectId)
      this.active = this.engine.execute(prepared).finally(() => { this.active = null })
      return prepared.result
    } finally {
      this.starting = false
    }
  }

  isRunning(): boolean {
    return this.starting || this.active !== null
  }
}

export function createRunConfig(settings: ProjectSettings): SanitizedRunConfig {
  return {
    pageConcurrency: settings.pageConcurrency,
    navigationTimeoutMs: settings.navigationTimeoutMs,
    retryCount: 2,
    maxRedirects: 10,
    maxResponseBytes: 10 * 1024 * 1024,
    linkTimeoutMs: 15_000,
    imageTimeoutMsPerDevice: 60_000,
    imageScrollWaitMs: 1_000,
    authMode: settings.auth.mode,
    allowedPrivateHosts: [...(settings.allowedPrivateHosts ?? [])],
    viewports: {
      desktop: { width: 1366, height: 768 },
      mobile: { width: 375, height: 667 },
    },
  }
}

function defaultDependencies(): RunEngineDependencies {
  const projectStore = useProjectStore()
  return {
    projectStore,
    runStore: new RunStore(projectStore.projectsDir),
    inspectorFactory: createPlaywrightInspector,
    linkProbeFactory: (settings, config) => new SafeLinkProbe(
      new NetworkPolicy({ allowedPrivateHosts: settings.allowedPrivateHosts }),
      {
        timeoutMs: config.linkTimeoutMs,
        maxRedirects: config.maxRedirects,
        maxResponseBytes: config.maxResponseBytes,
      },
    ),
    now: () => new Date(),
  }
}

let engineSingleton: RunEngine | undefined
let coordinatorSingleton: RunCoordinator | undefined
let storeSingleton: RunStore | undefined

export function useRunEngine(): RunEngine {
  engineSingleton ??= new RunEngine(defaultDependencies())
  return engineSingleton
}

export function useRunCoordinator(): RunCoordinator {
  coordinatorSingleton ??= new RunCoordinator(useRunEngine())
  return coordinatorSingleton
}

export function useRunStore(): RunStore {
  if (!storeSingleton) {
    const projectStore = useProjectStore()
    storeSingleton = new RunStore(projectStore.projectsDir)
  }
  return storeSingleton
}

function groupRows(rows: InputPageRow[]): Map<string, InputPageRow[]> {
  const groups = new Map<string, InputPageRow[]>()
  for (const row of rows) groups.set(row.normalizedUrl, [...(groups.get(row.normalizedUrl) ?? []), row])
  return groups
}

function aggregateLinkFinding(url: string, pageNames: string[], sourceRows: number[], links: LinkResult[]): Finding {
  const verdict = highestVerdict(links.map(link => link.verdict))
  return {
    key: `${url}|links`,
    item: 'links',
    verdict,
    detailStatus: links.length === 0 ? 'no_links' : verdict === 'ok' ? 'checked' : 'issues_found',
    url,
    pageNames,
    sourceRows,
    actual: { total: links.length, ...verdictCounts(links.map(link => link.verdict)) },
    message: links.length === 0 ? '検査対象リンクはありません。' : `リンク${links.length}件を検査しました。`,
    evidence: links.filter(link => link.verdict !== 'ok').map(link => `${link.href}: ${link.message}`).slice(0, 100),
  }
}

function aggregateImageFinding(
  url: string,
  pageNames: string[],
  sourceRows: number[],
  images: ImageResult[],
  inspection: PageInspection,
): Finding {
  const viewportErrors = inspection.images.filter(viewport => viewport.error)
  const verdict = viewportErrors.length > 0 ? 'ng' : highestVerdict(images.map(image => image.verdict))
  return {
    key: `${url}|images`,
    item: 'images',
    verdict,
    detailStatus: viewportErrors.length > 0 ? 'viewport_failed' : images.length === 0 ? 'no_images' : verdict === 'ok' ? 'checked' : 'issues_found',
    url,
    pageNames,
    sourceRows,
    actual: { total: images.length, ...verdictCounts(images.map(image => image.verdict)) },
    message: viewportErrors.length > 0
      ? `画像検査で端末別ページ取得に失敗しました: ${viewportErrors.map(item => item.device).join(', ')}`
      : images.length === 0 ? '検査対象画像はありません。' : `画像${images.length}件を端末別に検査しました。`,
    evidence: [
      ...viewportErrors.map(item => `${item.device}: ${item.error}`),
      ...images.filter(image => image.verdict !== 'ok').map(image => `${image.device} ${image.imageUrl}: ${image.message}`),
    ].slice(0, 100),
  }
}

export function buildFailedPageResult(
  normalizedUrl: string,
  rows: InputPageRow[],
  startedAt: string,
  finishedAt: string,
  error: unknown,
): PageResult {
  const normalizedError = safeError(error)
  const attempts = error instanceof PageInspectionError ? error.attempts : 1
  const status = error instanceof PageInspectionError ? error.status : undefined
  const pageNames = rows.map(row => row.displayName)
  const sourceRows = rows.map(row => row.sourceRow)
  const base = { url: normalizedUrl, pageNames, sourceRows, evidence: [normalizedError.code] }
  const findings: Finding[] = [{
    ...base,
    key: `${normalizedUrl}|page_fetch`,
    item: 'page_fetch',
    verdict: 'ng',
    detailStatus: 'fetch_failed',
    actual: status ? { status } : undefined,
    message: normalizedError.message,
  }]
  for (const item of ['title', 'description', 'google_tags', 'links', 'images'] as const) {
    findings.push({
      ...base,
      key: `${normalizedUrl}|${item}`,
      item,
      verdict: 'unchecked',
      detailStatus: 'page_unavailable',
      message: 'ページ取得不能のため未確認です。',
    })
  }
  return {
    normalizedUrl,
    requestedUrl: redactForResult(rows[0]!.url),
    pageNames,
    sourceRows,
    startedAt,
    finishedAt,
    attempts,
    httpStatus: status,
    findings,
    error: normalizedError,
  }
}

function safeError(error: unknown): SafeError {
  if (error instanceof PageInspectionError) {
    return { code: error.code, message: error.message, retryable: error.retryable }
  }
  const code = error instanceof RunInputError ? 'INPUT_ERROR'
    : error instanceof ArchivedProjectError ? 'PROJECT_ARCHIVED'
      : 'RUN_FAILED'
  return { code, message: code === 'RUN_FAILED' ? '検査処理でエラーが発生しました。' : (error as Error).message, retryable: false }
}

function summarize(result: RunResult): RunResult['summary'] {
  const summary = emptySummary()
  for (const finding of result.pages.flatMap(page => page.findings)) {
    if (finding.detailStatus === 'not_applicable') continue
    if (finding.verdict === 'needs_review') summary.needsReview += 1
    else summary[finding.verdict] += 1
  }
  return summary
}

function emptySummary(): RunResult['summary'] {
  return { ng: 0, needsReview: 0, unchecked: 0, ok: 0 }
}

function highestVerdict(verdicts: Verdict[]): Verdict {
  if (verdicts.includes('ng')) return 'ng'
  if (verdicts.includes('needs_review')) return 'needs_review'
  if (verdicts.includes('unchecked')) return 'unchecked'
  return 'ok'
}

function verdictCounts(verdicts: Verdict[]): Record<string, number> {
  return {
    ng: verdicts.filter(value => value === 'ng').length,
    needsReview: verdicts.filter(value => value === 'needs_review').length,
    unchecked: verdicts.filter(value => value === 'unchecked').length,
    ok: verdicts.filter(value => value === 'ok').length,
  }
}

function redactForResult(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/token|key|secret|auth|password|passwd|session|email|user/i.test(key)) url.searchParams.set(key, '[REDACTED]')
    }
    return url.href
  } catch {
    return '[INVALID URL]'
  }
}

const pageResultLinks = new WeakMap<PageResult, LinkResult[]>()
const pageResultImages = new WeakMap<PageResult, ImageResult[]>()
const pageResultTags = new WeakMap<PageResult, ReturnType<typeof checkGoogleTags>['detections']>()
