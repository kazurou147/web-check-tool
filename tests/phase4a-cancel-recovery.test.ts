import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunCanceledError } from '~/server/services/abort'
import { buildAiInputBundle } from '~/server/services/ai-input'
import { runAiApiJudgment, type AiApiTransport, type AiApiTransportResponse } from '~/server/services/ai-api'
import { checkLinks } from '~/server/services/checks/links'
import { InstanceLease, InstanceLeaseError } from '~/server/services/instance-lease'
import { ProjectStore } from '~/server/services/project-store'
import { type PageInspection, type WebsiteInspector } from '~/server/services/playwright-inspector'
import { RunCancelConflictError, RunCoordinator, RunEngine } from '~/server/services/run-engine'
import { RunStore } from '~/server/services/run-store'
import { findAiPriceProfile } from '~/shared/config/ai-pricing'
import type { AiInputBundle } from '~/shared/types/ai'
import { defaultProjectSettings } from '~/shared/types/project'
import type { ActiveRunStatus, RunResult } from '~/shared/types/run'
import { canCancelRun } from '~/shared/utils/run-display'
import { manualAiQualityInput } from './fixtures/manual-ai-quality'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Phase 4-A 検査キャンセル', () => {
  it('全ワーカー停止後にcanceledを確定し、完了済みページだけを保持して次のrunを開始できる', async () => {
    const fixture = await createFixture('cancel', 3)
    fixture.settings.pageConcurrency = 2
    await fixture.projectStore.update(fixture.project.projectId, { settings: fixture.settings })
    let factoryCalls = 0
    let blockedStarted!: () => void
    const blockedStartedPromise = new Promise<void>(resolve => { blockedStarted = resolve })
    let blockedCount = 0
    let abortedWorkers = 0
    const close = vi.fn(async () => undefined)
    const inspectorFactory = vi.fn(async (): Promise<WebsiteInspector> => {
      factoryCalls += 1
      return {
        authenticate: async signal => signal?.throwIfAborted(),
        close,
        inspect: async (url, signal) => {
          if (factoryCalls === 1 && !url.endsWith('page-1')) {
            blockedCount += 1
            if (blockedCount === 2) blockedStarted()
            await new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => {
              abortedWorkers += 1
              reject(new RunCanceledError())
            }, { once: true }))
          }
          return successfulInspection(url)
        },
      }
    })
    const engine = createEngine(fixture.projectStore, fixture.runStore, inspectorFactory)
    const coordinator = new RunCoordinator(engine)

    const started = await coordinator.start(fixture.project.projectId)
    await blockedStartedPromise
    await waitFor(async () => (await fixture.runStore.get(fixture.project.projectId, started.runId)).pages.length === 1)
    const accepted = await coordinator.cancel(fixture.project.projectId, started.runId)
    expect(accepted).toMatchObject({ runId: started.runId, idempotent: false })
    const duplicate = await coordinator.cancel(fixture.project.projectId, started.runId)
    expect(duplicate.idempotent).toBe(true)

    const canceled = await waitForStatus(fixture.runStore, fixture.project.projectId, started.runId, 'canceled')
    expect(canceled.pages).toHaveLength(1)
    expect(abortedWorkers).toBe(2)
    expect(canceled.summary.ng).toBe(0)
    expect(canceled.termination).toMatchObject({ kind: 'canceled', reasonCode: 'USER_REQUESTED', previousStatus: 'checking' })
    expect(canceled.finishedAt).toBeTruthy()
    expect(close).toHaveBeenCalled()
    await waitFor(() => !coordinator.isRunning())

    const next = await coordinator.start(fixture.project.projectId)
    const completed = await waitForStatus(fixture.runStore, fixture.project.projectId, next.runId, 'completed')
    expect(completed.pages).toHaveLength(3)
    await expect(coordinator.cancel(fixture.project.projectId, next.runId)).rejects.toBeInstanceOf(RunCancelConflictError)
  })

  it('AI API処理中のキャンセルをundeterminedやAPI失敗へ変換しない', async () => {
    const fixture = await createFixture('ai-cancel', 1)
    fixture.settings.ai.mode = 'api'
    await fixture.projectStore.update(fixture.project.projectId, { settings: fixture.settings })
    let apiStarted!: () => void
    const apiStartedPromise = new Promise<void>(resolve => { apiStarted = resolve })
    const aiApiRunner = vi.fn(async (options: Parameters<NonNullable<ConstructorParameters<typeof RunEngine>[0]['aiApiRunner']>>[0]) => {
      const first = options.input.items[0]!
      await options.onProgress?.({
        output: {
          schemaVersion: 1,
          kind: 'web-check-ai-output',
          contractVersion: options.input.contractVersion,
          promptVersion: options.input.promptVersion,
          projectId: options.input.projectId,
          runId: options.input.runId,
          inputBundleId: options.input.bundleId,
          inputPayloadHash: options.input.integrity.payloadHash,
          judge: { mode: 'api', model: options.model },
          judgments: [{ itemId: first.itemId, inputHash: first.inputHash, verdict: 'match', reason: '完了済みバッチです。' }],
        },
        usage: {
          inputTokens: 120,
          cachedInputTokens: 20,
          outputTokens: 30,
          estimatedCostUsd: 0.0001,
          costLimitUsd: options.costLimitUsd,
          stoppedByCostLimit: false,
          apiFailureCount: 0,
        },
        failedCount: 0,
      })
      apiStarted()
      await new Promise<never>((_resolve, reject) => options.signal?.addEventListener('abort', () => reject(new RunCanceledError()), { once: true }))
    })
    const bundleBuilder = vi.fn(async ({ projectId, runId }: { projectId: string; runId: string }) => ({
      ...manualAiQualityInput,
      projectId,
      runId,
    }) as AiInputBundle)
    const engine = createEngine(fixture.projectStore, fixture.runStore, async () => simpleInspector(), {
      aiInputBuilder: bundleBuilder,
      aiSigningKey: () => new Uint8Array(32),
      aiApiRunner: aiApiRunner as never,
      openAiApiKey: () => 'not-persisted',
    })
    const coordinator = new RunCoordinator(engine)
    const started = await coordinator.start(fixture.project.projectId)
    await apiStartedPromise
    await coordinator.cancel(fixture.project.projectId, started.runId)
    const canceled = await waitForStatus(fixture.runStore, fixture.project.projectId, started.runId, 'canceled')

    expect(canceled.pages).toHaveLength(1)
    expect(canceled.ai?.status).toBe('canceled')
    expect(canceled.ai?.apiResult?.output.judgments).toHaveLength(1)
    expect(canceled.aiUsage).toMatchObject({ inputTokens: 120, outputTokens: 30, estimatedCostUsd: 0.0001 })
    expect(canceled.aiUsage.apiFailureCount).toBe(0)
  })

  it('API transport中と再試行待機中のAbortErrorを判定不可へ変換しない', async () => {
    const controller = new AbortController()
    const transport = vi.fn<AiApiTransport>(async request => {
      return await new Promise<AiApiTransportResponse>((_resolve, reject) => request.signal?.addEventListener('abort', () => reject(new RunCanceledError()), { once: true }))
    })
    const pending = runAiApiJudgment({
      input: manualAiQualityInput,
      model: 'gpt-6-luna',
      priceProfile: findAiPriceProfile('gpt-6-luna-standard-2026-10-22')!,
      costLimitUsd: 1,
      transport,
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toBeInstanceOf(RunCanceledError)
    expect(transport).toHaveBeenCalledOnce()

    const retryController = new AbortController()
    const retryTransport = vi.fn<AiApiTransport>(async () => { throw Object.assign(new Error('temporary'), { status: 503 }) })
    const retryPending = runAiApiJudgment({
      input: manualAiQualityInput,
      model: 'gpt-6-luna',
      priceProfile: findAiPriceProfile('gpt-6-luna-standard-2026-10-22')!,
      costLimitUsd: 1,
      transport: retryTransport,
      signal: retryController.signal,
    })
    await waitFor(() => retryTransport.mock.calls.length === 1)
    retryController.abort()
    await expect(retryPending).rejects.toBeInstanceOf(RunCanceledError)
    expect(retryTransport).toHaveBeenCalledOnce()
  })

  it('認証・リンク・AI入力準備のAbortErrorを検査失敗へ変換しない', async () => {
    const fixture = await createFixture('auth-cancel', 1)
    let authenticationStarted!: () => void
    const authenticationStartedPromise = new Promise<void>(resolve => { authenticationStarted = resolve })
    const inspect = vi.fn()
    const engine = createEngine(fixture.projectStore, fixture.runStore, async () => ({
      authenticate: async signal => {
        authenticationStarted()
        await new Promise<never>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new RunCanceledError()), { once: true }))
      },
      inspect,
      close: async () => undefined,
    }))
    const coordinator = new RunCoordinator(engine)
    const started = await coordinator.start(fixture.project.projectId)
    await authenticationStartedPromise
    await coordinator.cancel(fixture.project.projectId, started.runId)
    const canceled = await waitForStatus(fixture.runStore, fixture.project.projectId, started.runId, 'canceled')
    expect(canceled.pages).toHaveLength(0)
    expect(canceled.termination?.previousStatus).toBe('authenticating')
    expect(inspect).not.toHaveBeenCalled()

    const controller = new AbortController()
    controller.abort()
    await expect(checkLinks('https://example.com/', [{
      href: '/target', resolvedUrl: 'https://example.com/target', text: 'target', isImageLink: false,
    }], new Set(), { probe: async () => { throw new Error('not reached') } }, controller.signal)).rejects.toBeInstanceOf(RunCanceledError)
    await expect(buildAiInputBundle({
      projectId: fixture.project.projectId,
      runId: started.runId,
      candidates: [{
        linkResultKey: 'link-1', pageUrl: 'https://example.com/', href: '/target', resolvedUrl: 'https://example.com/target',
        linkText: 'target', beforeText: '', afterText: '', isImageLink: false,
      }],
      probe: { probe: async () => { throw new Error('not reached') } },
      signingKey: new Uint8Array(32),
      signal: controller.signal,
    })).rejects.toBeInstanceOf(RunCanceledError)
  })

  it('UI用の可否判定は実行中かつ未送信の場合だけ許可する', () => {
    expect(canCancelRun('checking', false)).toBe(true)
    expect(canCancelRun('ai_checking', true)).toBe(false)
    expect(canCancelRun('completed', false)).toBe(false)
    expect(canCancelRun('canceled', false)).toBe(false)
  })
})

describe('Phase 4-A 起動時復旧', () => {
  it('全実行中状態だけをinterruptedへ補正し、途中結果・AI使用量を保持して冪等に動作する', async () => {
    const fixture = await createFixture('recovery', 1)
    const engine = createEngine(fixture.projectStore, fixture.runStore, async () => simpleInspector())
    const activeStatuses: ActiveRunStatus[] = ['queued', 'reading_input', 'authenticating', 'checking', 'ai_checking']
    const runIds: string[] = []
    for (const status of activeStatuses) {
      const prepared = await engine.prepare(fixture.project.projectId)
      prepared.result.status = status
      prepared.result.aiUsage.inputTokens = 321
      prepared.result.aiUsage.estimatedCostUsd = 0.00123
      if (status === 'ai_checking') {
        prepared.result.ai!.status = 'api_checking'
        prepared.result.pages.push({
          normalizedUrl: 'https://example.com/page-1',
          requestedUrl: 'https://example.com/page-1',
          finalUrl: 'https://example.com/page-1',
          pageNames: ['ページ1'],
          sourceRows: [2],
          startedAt: '2026-10-24T00:00:00.000Z',
          finishedAt: '2026-10-24T00:00:01.000Z',
          attempts: 1,
          httpStatus: 200,
          findings: [],
        })
        prepared.result.ai!.inputBundle = { ...manualAiQualityInput, projectId: fixture.project.projectId, runId: prepared.result.runId }
        prepared.result.ai!.apiResult = {
          completedAt: '2026-10-24T00:00:02.000Z',
          failedCount: 0,
          output: {
            schemaVersion: 1,
            kind: 'web-check-ai-output',
            contractVersion: manualAiQualityInput.contractVersion,
            promptVersion: manualAiQualityInput.promptVersion,
            projectId: fixture.project.projectId,
            runId: prepared.result.runId,
            inputBundleId: manualAiQualityInput.bundleId,
            inputPayloadHash: manualAiQualityInput.integrity.payloadHash,
            judge: { mode: 'api', model: 'gpt-6-luna' },
            judgments: [],
          },
        }
      }
      await fixture.runStore.saveResult(fixture.project.projectId, prepared.result.runId, prepared.result)
      runIds.push(prepared.result.runId)
    }
    const terminal = await engine.prepare(fixture.project.projectId)
    terminal.result.status = 'completed'
    terminal.result.finishedAt = '2026-10-24T00:00:00.000Z'
    await fixture.runStore.saveResult(fixture.project.projectId, terminal.result.runId, terminal.result)

    const report = await fixture.runStore.recoverInterruptedRuns(new Date('2026-10-24T01:00:00.000Z'))
    expect(report.recovered).toHaveLength(5)
    for (const [index, runId] of runIds.entries()) {
      const recovered = await fixture.runStore.get(fixture.project.projectId, runId)
      expect(recovered.status).toBe('interrupted')
      expect(recovered.termination).toMatchObject({ previousStatus: activeStatuses[index], reasonCode: 'PROCESS_RESTART' })
      expect(recovered.aiUsage).toMatchObject({ inputTokens: 321, estimatedCostUsd: 0.00123 })
      if (activeStatuses[index] === 'ai_checking') {
        expect(recovered.ai?.status).toBe('interrupted')
        expect(recovered.pages).toHaveLength(1)
        expect(recovered.ai?.inputBundle?.items).toHaveLength(manualAiQualityInput.items.length)
        expect(recovered.ai?.apiResult?.completedAt).toBe('2026-10-24T00:00:02.000Z')
      }
      const events = await readFile(join(fixture.runStore.runDir(fixture.project.projectId, runId), 'events.jsonl'), 'utf8')
      expect(events).toContain('run_interrupted')
      expect(events).not.toContain('OPENAI_API_KEY')
    }
    expect((await fixture.runStore.get(fixture.project.projectId, terminal.result.runId)).status).toBe('completed')
    expect((await fixture.runStore.recoverInterruptedRuns()).recovered).toHaveLength(0)
  })

  it('旧履歴はterminationなしで読み込める', async () => {
    const fixture = await createFixture('legacy', 1)
    const engine = createEngine(fixture.projectStore, fixture.runStore, async () => simpleInspector())
    const prepared = await engine.prepare(fixture.project.projectId)
    const path = join(fixture.runStore.runDir(fixture.project.projectId, prepared.result.runId), 'result.json')
    const legacy = JSON.parse(await readFile(path, 'utf8'))
    delete legacy.termination
    await writeFile(path, `${JSON.stringify(legacy, null, 2)}\n`)
    expect((await fixture.runStore.get(fixture.project.projectId, prepared.result.runId)).termination).toBeUndefined()
  })
})

describe('Phase 4-A 単一インスタンス制御', () => {
  it('生存中所有者のロックを奪わず、所有者だけが解放できる', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.test-data-phase4a-lease-'))
    temporaryDirectories.push(directory)
    const lease = await InstanceLease.acquire(directory)
    await expect(InstanceLease.acquire(directory)).rejects.toMatchObject({ code: 'INSTANCE_ALREADY_RUNNING' })

    const ownerPath = join(directory, '.instance-lock', 'owner.json')
    const owner = JSON.parse(await readFile(ownerPath, 'utf8'))
    owner.instanceId = 'different-owner'
    await writeFile(ownerPath, JSON.stringify(owner))
    await lease.release()
    await expect(readFile(ownerPath, 'utf8')).resolves.toContain('different-owner')
  })

  it('所有者情報を確認できないロックは安全側で停止する', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.test-data-phase4a-uncertain-'))
    temporaryDirectories.push(directory)
    await mkdir(join(directory, '.instance-lock'))
    await writeFile(join(directory, '.instance-lock', 'owner.json'), '{}')
    await expect(InstanceLease.acquire(directory)).rejects.toBeInstanceOf(InstanceLeaseError)
  })

  it('所有者の停止を確認できたロックだけを競合なく回収する', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.test-data-phase4a-stale-'))
    temporaryDirectories.push(directory)
    const lockDir = join(directory, '.instance-lock')
    await mkdir(lockDir)
    await writeFile(join(lockDir, 'owner.json'), JSON.stringify({
      pid: 424242,
      instanceId: 'stopped-owner',
      startedAt: '2026-10-20T00:00:00.000Z',
      heartbeatAt: '2026-10-20T00:00:00.000Z',
    }))
    const liveness = (pid: number) => pid === 424242 ? false : true
    const attempts = await Promise.allSettled([
      InstanceLease.acquire(directory, () => new Date('2026-10-24T00:00:00.000Z'), liveness),
      InstanceLease.acquire(directory, () => new Date('2026-10-24T00:00:00.000Z'), liveness),
    ])
    const acquired = attempts.filter((item): item is PromiseFulfilledResult<InstanceLease> => item.status === 'fulfilled')
    expect(acquired).toHaveLength(1)
    expect(attempts.filter(item => item.status === 'rejected')).toHaveLength(1)
    await acquired[0]!.value.release()
  })
})

async function createFixture(name: string, pageCount: number) {
  const directory = await mkdtemp(join(process.cwd(), `.test-data-phase4a-${name}-`))
  temporaryDirectories.push(directory)
  const projectStore = new ProjectStore(directory)
  const settings = defaultProjectSettings()
  const project = await projectStore.create(name, settings)
  const workbook = new ExcelJS.Workbook()
  const pages = workbook.addWorksheet('納品前のチェック')
  pages.addRow(['ページ名', 'URL', 'title', 'description'])
  for (let index = 0; index < pageCount; index += 1) {
    pages.addRow([`ページ${index + 1}`, `https://example.com/page-${index + 1}`, 'Title', 'Description'])
  }
  workbook.addWorksheet('Googleタグ').addRow(['タグ名', '設置コード'])
  await projectStore.saveExcel(project.projectId, 'fixture.xlsx', new Uint8Array(await workbook.xlsx.writeBuffer()))
  return { directory, projectStore, runStore: new RunStore(projectStore.projectsDir), project, settings }
}

function createEngine(
  projectStore: ProjectStore,
  runStore: RunStore,
  inspectorFactory: () => Promise<WebsiteInspector>,
  overrides: Partial<ConstructorParameters<typeof RunEngine>[0]> = {},
): RunEngine {
  return new RunEngine({
    projectStore,
    runStore,
    inspectorFactory,
    linkProbeFactory: () => ({ probe: async url => ({ requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', redirectCount: 0 }) }),
    now: () => new Date(),
    ...overrides,
  })
}

function simpleInspector(): WebsiteInspector {
  return { authenticate: async () => undefined, close: async () => undefined, inspect: async url => successfulInspection(url) }
}

function successfulInspection(url: string): PageInspection {
  const html = '<html><head><title>Title</title><meta name="description" content="Description"></head><body></body></html>'
  return {
    requestedUrl: url,
    finalUrl: url,
    status: 200,
    attempts: 1,
    rawHtml: html,
    renderedHtml: html,
    metadata: { titles: ['Title'], descriptions: ['Description'] },
    links: [],
    anchorTargets: [],
    networkTags: [],
    images: [{ device: 'desktop', images: [], timedOut: false }, { device: 'mobile', images: [], timedOut: false }],
  }
}

async function waitForStatus(store: RunStore, projectId: string, runId: string, status: RunResult['status']): Promise<RunResult> {
  let latest = await store.get(projectId, runId)
  for (let attempt = 0; attempt < 100 && latest.status !== status; attempt += 1) {
    await new Promise(resolve => setTimeout(resolve, 10))
    latest = await store.get(projectId, runId)
  }
  expect(latest.status).toBe(status)
  return latest
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  expect(await predicate()).toBe(true)
}
