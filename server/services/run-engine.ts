import { randomUUID } from 'node:crypto'
import type { DuplicateUrlGroup, InputPageRow, InputSnapshot } from '~/shared/types/excel-input'
import type { Project, ProjectSecrets, ProjectSettings } from '~/shared/types/project'
import type { AiInputBundle } from '~/shared/types/ai'
import { findMatchingAiPriceProfile } from '~/shared/config/ai-pricing'
import type {
  ActiveRunStatus,
  Finding,
  ImageResult,
  LinkResult,
  PageResult,
  RunResult,
  SafeError,
  SanitizedRunConfig,
  Verdict,
} from '~/shared/types/run'
import { isActiveRun } from '~/shared/utils/run-display'
import { isAbortError, RunCanceledError, throwIfAborted } from './abort'
import { checkGoogleTags } from './checks/google-tags'
import { checkImages } from './checks/images'
import { checkLinks, SafeLinkProbe, type LinkProbe } from './checks/links'
import { checkMetadata } from './checks/metadata'
import {
  AI_CONTRACT_VERSION,
  AI_PROMPT_VERSION,
  AiInputBuildError,
  buildAiInputBundle,
  loadOrCreateAiSigningKey,
  type AiSourceCandidate,
  type BuildAiInputBundleOptions,
} from './ai-input'
import {
  buildFailedAiApiResult,
  runAiApiJudgment,
  type AiApiExecutionResult,
  type RunAiApiOptions,
} from './ai-api'
import { readExcelInput } from './excel-input'
import { NetworkPolicy } from './network-policy'
import {
  createPlaywrightInspector,
  IMAGE_SCROLL_BOTTOM_STABLE_COUNT,
  IMAGE_SCROLL_MAX_COUNT,
  IMAGE_SCROLL_NO_PROGRESS_COUNT,
  IMAGE_SCROLL_STEP_VIEWPORT_RATIO,
  IMAGE_SCROLL_WAIT_MAX_MS,
  mobileEmulationSnapshot,
  PageInspectionError,
  type InspectorFactory,
  type PageInspection,
  type WebsiteInspector,
} from './playwright-inspector'
import { ArchivedProjectError, type ProjectStore, useProjectStore } from './project-store'
import { assertRunResultSize, RunEventSizeError, RunStore } from './run-store'
import type { RerunRequest } from './validation'
import { createUrlIdentity, initializeUrlIdentityKey } from './url-identity'
import { hydrateProjectAuthUrls } from './project-url-security'
import { SECURITY_ERROR_CODES, SECURITY_LIMITS, SecurityFoundationError } from '~/shared/security/security-constants'

export class RunBusyError extends Error {}
export class RunInputError extends Error {
  constructor(message: string, readonly code = 'INPUT_ERROR') { super(message) }
}
export class RunCancelConflictError extends Error {}

export type LinkProbeFactory = (settings: ProjectSettings, config: SanitizedRunConfig) => LinkProbe

export interface RunEngineDependencies {
  projectStore: ProjectStore
  runStore: RunStore
  inspectorFactory: InspectorFactory
  linkProbeFactory: LinkProbeFactory
  now: () => Date
  aiInputBuilder?: (options: BuildAiInputBundleOptions) => Promise<AiInputBundle>
  aiSigningKey?: () => Uint8Array | Promise<Uint8Array>
  aiApiRunner?: (options: RunAiApiOptions) => Promise<AiApiExecutionResult>
  openAiApiKey?: () => string | undefined
}

export class RunEngine {
  constructor(private readonly dependencies: RunEngineDependencies) {}

  async prepare(projectId: string, rerun?: RerunRequest & { sourceRunId: string }): Promise<PreparedRun> {
    const storedProject = await this.dependencies.projectStore.get(projectId)
    const project = structuredClone(storedProject)
    if (project.archivedAt) throw new ArchivedProjectError('アーカイブ中の案件では検査を開始できません')
    if (!project.excelFileName) throw new RunInputError('Excelファイルが登録されていません')
    let sourceRun: RunResult | undefined
    let config = createRunConfig(project.settings)
    const requestedAiMode = rerun?.aiMode ?? project.settings.ai.mode
    if (rerun) {
      sourceRun = await this.dependencies.runStore.get(projectId, rerun.sourceRunId)
      if (isActiveRun(sourceRun.status)) throw new RunInputError('実行中の検査は再実行できません')
      if (rerun.configSource === 'source_run') {
        if (sourceRun.configSnapshot.authMode !== project.settings.auth.mode) {
          throw new RunInputError('過去runと現在の認証モードが異なるため、過去runの条件では再実行できません')
        }
        config = {
          ...config,
          ...sourceRun.configSnapshot,
          authMode: project.settings.auth.mode,
          aiMode: requestedAiMode,
          allowedPrivateHosts: [...(sourceRun.configSnapshot.allowedPrivateHosts ?? [])],
          viewports: structuredClone(sourceRun.configSnapshot.viewports),
        }
        project.settings.pageConcurrency = config.pageConcurrency
        project.settings.navigationTimeoutMs = config.navigationTimeoutMs
        project.settings.allowedPrivateHosts = [...config.allowedPrivateHosts]
      }
      project.settings.ai.mode = requestedAiMode
      config.aiMode = requestedAiMode
    }
    if (project.settings.auth.mode !== 'none' && !await this.dependencies.projectStore.vault.exists(projectId)) {
      throw new RunInputError('現在の案件に認証情報が保存されていないため検査を開始できません')
    }
    if (rerun && project.settings.ai.mode === 'api') {
      if (!rerun.confirmPaidApi) throw new RunInputError('APIモードでは有料実行の確認が必要です')
      const apiKey = this.dependencies.openAiApiKey ? this.dependencies.openAiApiKey() : process.env.OPENAI_API_KEY
      if (!apiKey?.trim()) {
        throw new RunInputError('OPENAI_API_KEYが設定されていません')
      }
      if (!findMatchingAiPriceProfile(project.settings.ai.priceProfileId, project.settings.ai.model)) {
        throw new RunInputError('選択中のモデルに対応する料金プロファイルがありません')
      }
      if (!(project.settings.ai.costLimitUsd > 0)) throw new RunInputError('API料金上限が設定されていません')
    }
    const input = await readExcelInput(this.dependencies.projectStore.excelPath(projectId), project.excelFileName)
    if (!input.canStart) throw new RunInputError('Excel入力に致命的な問題があるため検査を開始できません')
    if (input.uniqueUrlCount > SECURITY_LIMITS.uniquePagesPerRun) {
      throw new RunInputError(`固有ページ数は${SECURITY_LIMITS.uniquePagesPerRun}件以下にしてください`, SECURITY_ERROR_CODES.pageLimitReached)
    }
    const secrets = project.settings.auth.mode === 'none'
      ? {}
      : await this.dependencies.projectStore.vault.read(projectId)
    project.settings = hydrateProjectAuthUrls(project.settings, secrets)
    if (project.settings.auth.mode !== 'none' && !secrets[project.settings.auth.mode]) {
      throw new RunInputError('現在の認証モードに対応する認証情報が保存されていません')
    }
    const runId = randomUUID()
    const urlIdentityKey = await initializeUrlIdentityKey(this.dependencies.projectStore.dataDir, process.env.APP_ENCRYPTION_KEY)
    const now = this.dependencies.now().toISOString()
    const result: RunResult = {
      schemaVersion: 1,
      runId,
      projectId,
      ...(rerun ? {
        rerunOfRunId: rerun.sourceRunId,
        rerun: {
          sourceRunId: rerun.sourceRunId,
          configSource: rerun.configSource,
          inputSource: 'current_excel' as const,
          requestedAiMode,
          requestedAt: now,
          ...(rerun.configSource === 'source_run' && project.settings.auth.mode !== 'none'
            ? { compatibilityWarnings: ['認証情報と認証手順は現在の案件設定を使用しています。'] }
            : {}),
        },
      } : {}),
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      configSnapshot: config,
      input,
      summary: emptySummary(),
      pages: [],
      links: [],
      images: [],
      googleTagDetections: [],
      ai: {
        mode: project.settings.ai.mode,
        status: project.settings.ai.mode === 'off' ? 'disabled' : 'preparing',
        contractVersion: AI_CONTRACT_VERSION,
        promptVersion: AI_PROMPT_VERSION,
        ...(project.settings.ai.mode === 'api' ? {
          model: project.settings.ai.model,
          priceProfile: findMatchingAiPriceProfile(project.settings.ai.priceProfileId, project.settings.ai.model),
        } : {}),
      },
      aiUsage: {
        enabled: project.settings.ai.mode !== 'off',
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        estimatedCostUsd: 0,
        costLimitUsd: project.settings.ai.costLimitUsd,
        stoppedByCostLimit: false,
        apiFailureCount: 0,
      },
    }
    await this.dependencies.runStore.create(projectId, runId, input, result)
    if (rerun) {
      await this.dependencies.runStore.appendEvent(projectId, runId, {
        at: now,
        type: 'run_rerun_created',
        sourceRunId: rerun.sourceRunId,
        configSource: rerun.configSource,
        inputSource: 'current_excel',
        aiMode: requestedAiMode,
      })
    }
    return { project, secrets, input, result, urlIdentityKey }
  }

  async execute(prepared: PreparedRun, signal?: AbortSignal): Promise<RunResult> {
    const { project, secrets, input, result, urlIdentityKey } = prepared
    let inspector: WebsiteInspector | undefined
    let abortInspector: (() => void) | undefined
    let inspectorClosing: Promise<void> | undefined
    const closeInspector = (): Promise<void> => {
      if (!inspectorClosing) inspectorClosing = inspector?.close() ?? Promise.resolve()
      return inspectorClosing
    }
    try {
      throwIfAborted(signal)
      await this.transition(result, 'reading_input', false, signal)
      await this.transition(result, 'authenticating', true, signal)
      inspector = await this.dependencies.inspectorFactory({ settings: project.settings, secrets, config: result.configSnapshot })
      abortInspector = () => { void closeInspector().catch(() => undefined) }
      signal?.addEventListener('abort', abortInspector, { once: true })
      throwIfAborted(signal)
      await inspector.authenticate(signal)
      await this.transition(result, 'checking', false, signal)
      const groups = groupRows(input.pageRows)
      const queue = [...groups.entries()]
      const workerCount = Math.min(project.settings.pageConcurrency, queue.length)
      const probe = inspector.linkProbe ?? this.dependencies.linkProbeFactory(project.settings, result.configSnapshot)
      const aiCandidates: AiSourceCandidate[] = []
      const workers = await Promise.allSettled(Array.from(
        { length: workerCount },
        () => this.worker(queue, input, result, inspector!, probe, aiCandidates, urlIdentityKey, signal),
      ))
      const rejected = workers.find((worker): worker is PromiseRejectedResult => worker.status === 'rejected')
      if (rejected) throw rejected.reason
      throwIfAborted(signal)
      if (project.settings.ai.mode !== 'off') {
        await this.transition(result, 'ai_checking', false, signal)
        let preparationStage: 'signing_key' | 'bundle_generation' = 'signing_key'
        let inputPrepared = false
        try {
          const signingKey = await (this.dependencies.aiSigningKey ?? (() => loadOrCreateAiSigningKey(
            this.dependencies.projectStore.projectsDir,
            process.env.APP_ENCRYPTION_KEY,
          )))()
          preparationStage = 'bundle_generation'
          const inputBundle = await (this.dependencies.aiInputBuilder ?? buildAiInputBundle)({
            projectId: project.projectId,
            runId: result.runId,
            candidates: aiCandidates,
            probe,
            signingKey,
            now: this.dependencies.now,
            signal,
          })
          assertDetailLimit(result, inputBundle.items.length)
          assertOperationalResult({ ...result, ai: { ...result.ai!, inputBundle } })
          result.ai!.inputBundle = inputBundle
          result.ai!.status = result.ai!.inputBundle.items.length === 0
            ? 'no_targets'
            : project.settings.ai.mode === 'manual' ? 'awaiting_manual' : 'api_checking'
          await this.event(result, 'ai_input_ready', { itemCount: result.ai!.inputBundle.items.length })
          inputPrepared = true
        } catch (error) {
          if (isAbortError(error) || signal?.aborted) throw new RunCanceledError()
          const diagnostic = error instanceof SecurityFoundationError
            ? { code: error.code, message: error.message }
            : aiPreparationDiagnostic(preparationStage)
          result.ai!.status = 'preparation_failed'
          result.ai!.error = {
            code: diagnostic.code,
            message: diagnostic.message,
          }
          console.error('[ai-input] preparation failed', {
            projectId: result.projectId,
            runId: result.runId,
            stage: preparationStage,
            code: diagnostic.code,
            errorType: error instanceof Error ? error.name : 'UnknownError',
            ...(error instanceof AiInputBuildError ? {
              failurePoint: error.failurePoint,
              ...error.safeDetails,
            } : {}),
          })
          await this.event(result, 'ai_input_failed', {
            code: diagnostic.code,
            stage: preparationStage,
            ...(error instanceof AiInputBuildError ? {
              failurePoint: error.failurePoint,
              ...error.safeDetails,
            } : {}),
          })
        }
        if (inputPrepared && project.settings.ai.mode === 'api' && result.ai!.inputBundle!.items.length) {
          try {
            await this.executeApiJudgment(project, result, signal)
          } catch (error) {
            if (isAbortError(error) || signal?.aborted) throw new RunCanceledError()
            if (error instanceof SecurityFoundationError) {
              result.ai!.status = 'api_failed'
              result.ai!.error = { code: error.code, message: error.message }
              result.aiUsage.apiFailureCount += 1
              await this.event(result, 'ai_api_failed', { code: error.code })
            } else {
              const failed = buildFailedAiApiResult(
                result.ai!.inputBundle!,
                project.settings.ai.model,
                project.settings.ai.costLimitUsd,
                'AI_API_UNEXPECTED_ERROR',
                'AI判定処理で予期しないエラーが発生しました。',
              )
              this.applyApiProgress(result, failed, true)
              console.error('[ai-api] execution failed', {
                projectId: result.projectId,
                runId: result.runId,
                code: 'AI_API_UNEXPECTED_ERROR',
                errorType: error instanceof Error ? error.name : 'UnknownError',
              })
              await this.event(result, 'ai_api_failed', { code: 'AI_API_UNEXPECTED_ERROR' })
            }
          }
        }
      }
      throwIfAborted(signal)
      await closeInspector()
      result.status = 'completed'
      result.finishedAt = this.dependencies.now().toISOString()
      result.updatedAt = result.finishedAt
      result.summary = summarize(result)
      await this.dependencies.runStore.saveResult(result.projectId, result.runId, result)
      await this.event(result, 'run_completed')
      return result
    } catch (error) {
      await closeInspector().catch(() => undefined)
      if (isAbortError(error) || signal?.aborted) {
        const finalizedAt = this.dependencies.now().toISOString()
        const previousStatus = isActiveRun(result.status) ? result.status as ActiveRunStatus : 'checking'
        result.status = 'canceled'
        result.finishedAt = finalizedAt
        result.updatedAt = finalizedAt
        result.termination = {
          kind: 'canceled',
          reasonCode: 'USER_REQUESTED',
          previousStatus,
          requestedAt: result.termination?.requestedAt ?? finalizedAt,
          finalizedAt,
        }
        if (result.ai?.status === 'preparing' || result.ai?.status === 'api_checking') result.ai.status = 'canceled'
        result.summary = summarize(result)
        await this.dependencies.runStore.saveResult(result.projectId, result.runId, result)
        await this.event(result, 'run_canceled', { previousStatus, reasonCode: 'USER_REQUESTED' }).catch(ignoreTerminalEventLimit)
        return result
      }
      result.status = 'failed'
      result.finishedAt = this.dependencies.now().toISOString()
      result.updatedAt = result.finishedAt
      result.fatalError = safeError(error)
      result.summary = summarize(result)
      await this.dependencies.runStore.saveResult(result.projectId, result.runId, result)
      await this.event(result, 'run_failed', { code: result.fatalError.code }).catch(ignoreTerminalEventLimit)
      return result
    } finally {
      if (abortInspector) signal?.removeEventListener('abort', abortInspector)
      await closeInspector().catch(() => undefined)
    }
  }

  private async executeApiJudgment(project: Project, result: RunResult, signal?: AbortSignal): Promise<void> {
    const inputBundle = result.ai!.inputBundle!
    const priceProfile = findMatchingAiPriceProfile(project.settings.ai.priceProfileId, project.settings.ai.model)
    const runner = this.dependencies.aiApiRunner ?? runAiApiJudgment
    const executed = priceProfile
      ? await runner({
          input: inputBundle,
          model: project.settings.ai.model,
          priceProfile,
          costLimitUsd: project.settings.ai.costLimitUsd,
          apiKey: (this.dependencies.openAiApiKey ?? (() => process.env.OPENAI_API_KEY))(),
          signal,
          onProgress: async progress => {
            throwIfAborted(signal)
            this.applyApiProgress(result, progress, false)
            await this.dependencies.runStore.saveResult(result.projectId, result.runId, result)
          },
        })
      : buildFailedAiApiResult(
          inputBundle,
          project.settings.ai.model,
          project.settings.ai.costLimitUsd,
          'AI_PRICE_PROFILE_MISSING',
          '選択したモデルの料金プロファイルが設定されていません。',
        )

    this.applyApiProgress(result, executed, true)
    await this.event(result, 'ai_api_completed', {
      itemCount: executed.output.judgments.length,
      failedCount: executed.failedCount,
      stoppedByCostLimit: executed.usage.stoppedByCostLimit,
    })
  }

  private applyApiProgress(result: RunResult, progress: AiApiExecutionResult, completed: boolean): void {
    const completedAt = this.dependencies.now().toISOString()
    const nextAi = {
      ...result.ai!,
      apiResult: { output: progress.output, completedAt, failedCount: progress.failedCount },
      status: completed
      ? progress.terminalError ? 'api_failed' : 'completed'
      : 'api_checking',
      error: progress.terminalError,
    } as NonNullable<RunResult['ai']>
    const nextUsage = { enabled: true, ...progress.usage }
    assertOperationalResult({ ...result, ai: nextAi, aiUsage: nextUsage, updatedAt: completedAt })
    result.ai = nextAi
    result.aiUsage = nextUsage
    result.updatedAt = completedAt
  }

  private async worker(
    queue: Array<[string, InputPageRow[]]>,
    input: InputSnapshot,
    result: RunResult,
    inspector: WebsiteInspector,
    probe: LinkProbe,
    aiCandidates: AiSourceCandidate[],
    urlIdentityKey: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    while (true) {
      throwIfAborted(signal)
      const next = queue.shift()
      if (!next) return
      const [normalizedUrl, rows] = next
      const urlIdentity = createUrlIdentity(normalizedUrl, urlIdentityKey)
      const startedAt = this.dependencies.now().toISOString()
      let pageResult: PageResult
      try {
        const inspection = await inspector.inspect(rows[0]!.url, signal)
        throwIfAborted(signal)
        pageResult = await this.buildSuccessfulPage(normalizedUrl, urlIdentity, rows, input, inspection, probe, startedAt, urlIdentityKey, signal)
        throwIfAborted(signal)
        const newLinks = pageResultLinks.get(pageResult)!
        const newImages = pageResultImages.get(pageResult)!
        const newTags = pageResultTags.get(pageResult)!
        assertDetailLimit(result, newLinks.length + newImages.length + newTags.length)
        assertOperationalResult({
          ...result,
          pages: [...result.pages, pageResult],
          links: [...result.links, ...newLinks],
          images: [...result.images, ...newImages],
          googleTagDetections: [...result.googleTagDetections, ...newTags],
        })
        result.links.push(...newLinks)
        result.images.push(...newImages)
        result.googleTagDetections.push(...newTags)
        aiCandidates.push(...(pageResultAiCandidates.get(pageResult) ?? []))
      } catch (error) {
        if (isAbortError(error) || signal?.aborted) throw new RunCanceledError()
        if (error instanceof SecurityFoundationError) throw error
        pageResult = buildFailedPageResult(normalizedUrl, rows, startedAt, this.dependencies.now().toISOString(), error, urlIdentity)
      } finally {
        // WeakMaps are only temporary carriers so the persisted page structure stays specification-focused.
      }
      throwIfAborted(signal)
      result.pages.push(pageResult)
      result.pages.sort((left, right) => left.sourceRows[0]! - right.sourceRows[0]!)
      result.updatedAt = this.dependencies.now().toISOString()
      result.summary = summarize(result)
      await this.dependencies.runStore.saveResult(result.projectId, result.runId, result)
      throwIfAborted(signal)
      await this.event(result, 'page_completed', { urlIdentity, verdict: pageResult.findings[0]?.verdict })
      pageResultLinks.delete(pageResult)
      pageResultImages.delete(pageResult)
      pageResultTags.delete(pageResult)
      pageResultAiCandidates.delete(pageResult)
    }
  }

  private async buildSuccessfulPage(
    normalizedUrl: string,
    urlIdentity: string,
    rows: InputPageRow[],
    input: InputSnapshot,
    inspection: PageInspection,
    probe: LinkProbe,
    startedAt: string,
    urlIdentityKey: Uint8Array,
    signal?: AbortSignal,
  ): Promise<PageResult> {
    const pageNames = rows.map(row => row.displayName)
    const sourceRows = rows.map(row => row.sourceRow)
    const duplicate = input.duplicateGroups.find(group => group.normalizedUrl === normalizedUrl)
    const pageFetch: Finding = {
      key: `${urlIdentity}|page_fetch`,
      item: 'page_fetch',
      verdict: 'ok',
      detailStatus: 'fetched',
      url: normalizedUrl,
      urlIdentity,
      pageNames,
      sourceRows,
      actual: { status: inspection.status, finalUrl: redactForResult(inspection.finalUrl) },
      message: 'ページを取得しました。',
      evidence: [`HTTP ${inspection.status}`, `試行回数: ${inspection.attempts}`],
    }
    const metadata = checkMetadata(normalizedUrl, rows, duplicate, inspection.metadata)
    metadata.forEach((finding) => {
      finding.key = `${urlIdentity}|${finding.item}`
      finding.urlIdentity = urlIdentity
    })
    const tags = checkGoogleTags({
      pageUrl: normalizedUrl,
      pageUrlIdentity: urlIdentity,
      pageNames,
      sourceRows,
      rawHtml: inspection.rawHtml,
      renderedHtml: inspection.renderedHtml,
      network: inspection.networkTags,
      expected: input.expectedGoogleTags,
    })
    tags.finding.key = `${urlIdentity}|google_tags`
    tags.finding.urlIdentity = urlIdentity
    const tagKeys = new Map(tags.detections.map(tag => [tag.key, `${urlIdentity}|${tag.id}|${tag.detectionMethod}`]))
    tags.detections.forEach((tag) => {
      tag.key = tagKeys.get(tag.key)!
      tag.relatedDetectionKeys = tag.relatedDetectionKeys.map(key => tagKeys.get(key) ?? key)
    })
    const links = await checkLinks(normalizedUrl, inspection.links, new Set(inspection.anchorTargets), probe, signal, inspection.finalUrl, urlIdentityKey)
    const images = inspection.images.flatMap(viewport => checkImages(
      normalizedUrl,
      viewport.device,
      viewport.images,
      viewport.timedOut || (viewport.scroll !== undefined && !viewport.scroll.reachedStableBottom),
      urlIdentityKey,
    ))
    const linkFinding = aggregateLinkFinding(normalizedUrl, pageNames, sourceRows, links)
    const imageFinding = aggregateImageFinding(normalizedUrl, pageNames, sourceRows, images, inspection)
    const limitDiagnostics = [
      ...(inspection.linkCandidateLimit ? [{ code: SECURITY_ERROR_CODES.candidateLimitReached, category: 'links' as const, ...inspection.linkCandidateLimit }] : []),
      ...inspection.images.flatMap(viewport => viewport.candidateLimit
        ? [{ code: SECURITY_ERROR_CODES.candidateLimitReached, category: 'images' as const, device: viewport.device, ...viewport.candidateLimit }]
        : []),
    ]
    if (inspection.linkCandidateLimit) {
      linkFinding.verdict = 'needs_review'
      linkFinding.detailStatus = 'candidate_limit_reached'
      linkFinding.message = `リンク候補が上限${inspection.linkCandidateLimit.limit}件に達したため、残りは未確認です。`
      linkFinding.evidence.push(SECURITY_ERROR_CODES.candidateLimitReached)
    }
    if (inspection.images.some(viewport => viewport.candidateLimit)) {
      imageFinding.verdict = 'needs_review'
      imageFinding.detailStatus = 'candidate_limit_reached'
      imageFinding.message = '画像候補が端末別上限に達したため、残りは未確認です。'
      imageFinding.evidence.push(SECURITY_ERROR_CODES.candidateLimitReached)
    }
    for (const finding of [linkFinding, imageFinding]) {
      finding.key = `${urlIdentity}|${finding.item}`
      finding.urlIdentity = urlIdentity
    }
    const page: PageResult = {
      normalizedUrl,
      urlIdentity,
      requestedUrl: redactForResult(inspection.requestedUrl),
      finalUrl: redactForResult(inspection.finalUrl),
      finalUrlIdentity: createUrlIdentity(inspection.finalUrl, urlIdentityKey),
      pageNames,
      sourceRows,
      startedAt,
      finishedAt: this.dependencies.now().toISOString(),
      attempts: inspection.attempts,
      httpStatus: inspection.status,
      findings: [pageFetch, ...metadata, tags.finding, linkFinding, imageFinding],
      imageViewportDiagnostics: inspection.images.map(viewport => ({
        device: viewport.device,
        ...(viewport.scroll ? { scroll: viewport.scroll } : {}),
        ...(viewport.error ? { error: viewport.error } : {}),
      })),
      ...(limitDiagnostics.length ? { limitDiagnostics } : {}),
    }
    pageResultLinks.set(page, links)
    pageResultImages.set(page, images)
    pageResultTags.set(page, tags.detections)
    pageResultAiCandidates.set(page, inspection.links.map((link, index) => ({
      linkResultKey: links[index]!.key,
      pageUrl: normalizedUrl,
      href: link.href,
      resolvedUrl: link.resolvedUrl,
      linkText: link.text,
      beforeText: link.beforeText ?? '',
      afterText: link.afterText ?? '',
      isImageLink: link.isImageLink,
    })))
    return page
  }

  private async transition(result: RunResult, status: RunResult['status'], setStarted = false, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    result.status = status
    const now = this.dependencies.now().toISOString()
    if (setStarted && !result.startedAt) result.startedAt = now
    result.updatedAt = now
    await this.dependencies.runStore.saveResult(result.projectId, result.runId, result)
    await this.event(result, 'status_changed', { status })
    throwIfAborted(signal)
  }

  runStore(): RunStore {
    return this.dependencies.runStore
  }

  private async event(result: RunResult, type: string, details: Record<string, unknown> = {}): Promise<void> {
    await this.dependencies.runStore.appendEvent(result.projectId, result.runId, {
      at: this.dependencies.now().toISOString(),
      type,
      ...details,
    })
  }
}

function assertDetailLimit(result: RunResult, additional: number): void {
  const aiItems = result.ai?.inputBundle?.items.length ?? 0
  const count = result.links.length + result.images.length + result.googleTagDetections.length + aiItems + additional
  if (count > SECURITY_LIMITS.runDetailItems) {
    throw new SecurityFoundationError(SECURITY_ERROR_CODES.detailLimitReached, `個別検査結果が上限${SECURITY_LIMITS.runDetailItems}件を超えました。`)
  }
}

function assertOperationalResult(result: RunResult): void {
  assertRunResultSize(`${JSON.stringify(result, null, 2)}\n`, 'checking')
}

function ignoreTerminalEventLimit(error: unknown): void {
  if (error instanceof RunEventSizeError) return
  throw error
}

function aiPreparationDiagnostic(stage: 'signing_key' | 'bundle_generation'): { code: string; message: string } {
  if (stage === 'signing_key') {
    return {
      code: 'AI_SIGNING_KEY_PREPARATION_FAILED',
      message: 'AI入力の署名鍵を準備できませんでした。データ保存先の署名鍵ファイルと書き込み権限を確認してください。機械検査結果は保持されています。',
    }
  }
  return {
    code: 'AI_INPUT_BUNDLE_GENERATION_FAILED',
    message: 'AI判定用入力データを生成できませんでした。機械検査結果は保持されています。',
  }
}

interface PreparedRun {
  project: Project
  secrets: ProjectSecrets
  input: InputSnapshot
  result: RunResult
  urlIdentityKey: Uint8Array
}

export class RunCoordinator {
  private active: ActiveRunHandle | null = null
  private starting = false

  constructor(private readonly engine: RunEngine) {}

  async start(projectId: string): Promise<RunResult> {
    return await this.launch(projectId)
  }

  async rerun(projectId: string, sourceRunId: string, request: RerunRequest): Promise<RunResult> {
    return await this.launch(projectId, { ...request, sourceRunId })
  }

  private async launch(projectId: string, rerun?: RerunRequest & { sourceRunId: string }): Promise<RunResult> {
    if (this.active || this.starting) throw new RunBusyError('別の検査を実行中です')
    this.starting = true
    try {
      const prepared = await this.engine.prepare(projectId, rerun)
      const controller = new AbortController()
      const handle: ActiveRunHandle = {
        projectId,
        runId: prepared.result.runId,
        controller,
        result: prepared.result,
        promise: Promise.resolve(prepared.result),
      }
      handle.promise = this.engine.execute(prepared, controller.signal).finally(() => {
        if (this.active === handle) this.active = null
      })
      this.active = handle
      return prepared.result
    } finally {
      this.starting = false
    }
  }

  isRunning(): boolean {
    return this.starting || this.active !== null
  }

  async cancel(projectId: string, runId: string): Promise<CancelRunResult> {
    const persisted = await this.engine.runStore().get(projectId, runId)
    const handle = this.active
    if (!handle || handle.projectId !== projectId || handle.runId !== runId) {
      if (persisted.status === 'canceled') {
        return { runId, status: 'canceled', cancelRequestedAt: persisted.termination?.requestedAt, idempotent: true }
      }
      if (isActiveRun(persisted.status) && persisted.termination?.kind === 'canceled' && persisted.termination.requestedAt) {
        return { runId, status: persisted.status, cancelRequestedAt: persisted.termination.requestedAt, idempotent: true }
      }
      throw new RunCancelConflictError(isActiveRun(persisted.status)
        ? 'このプロセスで実行中の検査ではないためキャンセルできません。'
        : 'この検査はすでに終了しています。')
    }
    if (handle.cancelRequestedAt) {
      return { runId, status: handle.result.status, cancelRequestedAt: handle.cancelRequestedAt, idempotent: true }
    }
    if (!isActiveRun(handle.result.status)) throw new RunCancelConflictError('この検査はすでに終了しています。')
    const requestedAt = new Date().toISOString()
    handle.cancelRequestedAt = requestedAt
    handle.result.termination = {
      kind: 'canceled',
      reasonCode: 'USER_REQUESTED',
      previousStatus: handle.result.status as ActiveRunStatus,
      requestedAt,
    }
    handle.controller.abort()
    await this.engine.runStore().updateResult(projectId, runId, (current) => {
      current.termination = { ...handle.result.termination! }
    })
    await this.engine.runStore().appendEvent(projectId, runId, {
      at: requestedAt,
      type: 'run_cancel_requested',
      previousStatus: handle.result.termination.previousStatus,
      reasonCode: 'USER_REQUESTED',
    })
    return { runId, status: handle.result.status, cancelRequestedAt: requestedAt, idempotent: false }
  }
}

interface ActiveRunHandle {
  projectId: string
  runId: string
  controller: AbortController
  result: RunResult
  promise: Promise<RunResult>
  cancelRequestedAt?: string
}

export interface CancelRunResult {
  runId: string
  status: RunResult['status']
  cancelRequestedAt?: string
  idempotent: boolean
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
    imageScrollWaitMs: IMAGE_SCROLL_WAIT_MAX_MS,
    imageScrollStepViewportRatio: IMAGE_SCROLL_STEP_VIEWPORT_RATIO,
    imageScrollMaxCount: IMAGE_SCROLL_MAX_COUNT,
    imageScrollBottomStableCount: IMAGE_SCROLL_BOTTOM_STABLE_COUNT,
    imageScrollNoProgressCount: IMAGE_SCROLL_NO_PROGRESS_COUNT,
    authMode: settings.auth.mode,
    allowedPrivateHosts: [...(settings.allowedPrivateHosts ?? [])],
    aiMode: settings.ai?.mode ?? 'off',
    viewports: {
      desktop: { width: 1366, height: 768 },
      mobile: { width: 375, height: 667 },
    },
    mobileEmulation: mobileEmulationSnapshot(),
  }
}

function defaultDependencies(): RunEngineDependencies {
  const projectStore = useProjectStore()
  return {
    projectStore,
    runStore: useRunStore(),
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
  const inspectedVerdicts = images.map(image => image.verdict).filter(verdict => verdict !== 'excluded')
  const verdict = viewportErrors.length > 0
    ? 'ng'
    : inspectedVerdicts.length > 0
      ? highestVerdict(inspectedVerdicts)
      : images.length > 0 ? 'excluded' : 'ok'
  return {
    key: `${url}|images`,
    item: 'images',
    verdict,
    detailStatus: viewportErrors.length > 0
      ? 'viewport_failed'
      : images.length === 0
        ? 'no_images'
        : verdict === 'ok' ? 'checked' : verdict === 'excluded' ? 'excluded' : 'issues_found',
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
  urlIdentity?: string,
): PageResult {
  const normalizedError = safeError(error)
  const attempts = error instanceof PageInspectionError ? error.attempts : 1
  const status = error instanceof PageInspectionError ? error.status : undefined
  const pageNames = rows.map(row => row.displayName)
  const sourceRows = rows.map(row => row.sourceRow)
  const base = { url: normalizedUrl, ...(urlIdentity ? { urlIdentity } : {}), pageNames, sourceRows, evidence: [normalizedError.code] }
  const findings: Finding[] = [{
    ...base,
    key: `${urlIdentity ?? normalizedUrl}|page_fetch`,
    item: 'page_fetch',
    verdict: 'ng',
    detailStatus: 'fetch_failed',
    actual: status ? { status } : undefined,
    message: normalizedError.message,
  }]
  for (const item of ['title', 'description', 'google_tags', 'links', 'images'] as const) {
    findings.push({
      ...base,
      key: `${urlIdentity ?? normalizedUrl}|${item}`,
      item,
      verdict: 'unchecked',
      detailStatus: 'page_unavailable',
      message: 'ページ取得不能のため未確認です。',
    })
  }
  return {
    normalizedUrl,
    ...(urlIdentity ? { urlIdentity } : {}),
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
  const code = error instanceof SecurityFoundationError ? error.code
    : error instanceof RunInputError ? error.code
    : error instanceof ArchivedProjectError ? 'PROJECT_ARCHIVED'
      : 'RUN_FAILED'
  return { code, message: code === 'RUN_FAILED' ? '検査処理でエラーが発生しました。' : (error as Error).message, retryable: false }
}

function summarize(result: RunResult): RunResult['summary'] {
  const summary = emptySummary()
  for (const finding of result.pages.flatMap(page => page.findings)) {
    if (finding.detailStatus === 'not_applicable') continue
    if (finding.verdict === 'needs_review') summary.needsReview += 1
    else if (finding.verdict === 'excluded') summary.excluded = (summary.excluded ?? 0) + 1
    else summary[finding.verdict] += 1
  }
  return summary
}

function emptySummary(): RunResult['summary'] {
  return { ng: 0, needsReview: 0, unchecked: 0, excluded: 0, ok: 0 }
}

function highestVerdict(verdicts: Verdict[]): Verdict {
  if (verdicts.includes('ng')) return 'ng'
  if (verdicts.includes('needs_review')) return 'needs_review'
  if (verdicts.includes('unchecked')) return 'unchecked'
  if (verdicts.includes('excluded')) return 'excluded'
  return 'ok'
}

function verdictCounts(verdicts: Verdict[]): Record<string, number> {
  return {
    ng: verdicts.filter(value => value === 'ng').length,
    needsReview: verdicts.filter(value => value === 'needs_review').length,
    unchecked: verdicts.filter(value => value === 'unchecked').length,
    excluded: verdicts.filter(value => value === 'excluded').length,
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
const pageResultAiCandidates = new WeakMap<PageResult, AiSourceCandidate[]>()
