import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectStore } from '~/server/services/project-store'
import { buildResultJsonExport, RESULT_JSON_EXPORT_MAX_BYTES, ResultExportTooLargeError } from '~/server/services/result-json-export'
import { RunCoordinator, RunEngine, RunInputError } from '~/server/services/run-engine'
import { RunStore } from '~/server/services/run-store'
import type { PageInspection, WebsiteInspector } from '~/server/services/playwright-inspector'
import { defaultProjectSettings } from '~/shared/types/project'
import { rerunRequestSchema } from '~/server/services/validation'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Phase 4-B 全URL再実行', () => {
  it('現在Excelを再読込し、元runを変更せず、新runへ再実行関係と選択設定を保存する', async () => {
    const fixture = await createFixture('rerun', ['https://example.com/old'])
    const source = await fixture.engine.prepare(fixture.projectId)
    source.result.status = 'completed'
    source.result.finishedAt = new Date().toISOString()
    await fixture.runStore.saveResult(fixture.projectId, source.result.runId, source.result)
    const sourcePath = join(fixture.runStore.runDir(fixture.projectId, source.result.runId), 'result.json')
    const sourceHash = hash(await readFile(sourcePath))

    const project = await fixture.projectStore.get(fixture.projectId)
    project.settings.pageConcurrency = 1
    project.settings.navigationTimeoutMs = 45_000
    await fixture.projectStore.update(fixture.projectId, { settings: project.settings })
    await saveWorkbook(fixture.projectStore, fixture.projectId, ['https://example.com/new-a', 'https://example.com/new-b'])
    const currentExcelHash = hash(await readFile(fixture.projectStore.excelPath(fixture.projectId)))

    const current = await fixture.engine.prepare(fixture.projectId, {
      sourceRunId: source.result.runId,
      configSource: 'current_project',
      aiMode: 'off',
      confirmPaidApi: false,
    })
    expect(current.result.runId).not.toBe(source.result.runId)
    expect(current.result.rerunOfRunId).toBe(source.result.runId)
    expect(current.result.rerun).toMatchObject({ configSource: 'current_project', inputSource: 'current_excel', requestedAiMode: 'off' })
    expect(current.result.input.pageRows.map(row => row.normalizedUrl)).toEqual(['https://example.com/new-a', 'https://example.com/new-b'])
    expect(current.result.configSnapshot).toMatchObject({ pageConcurrency: 1, navigationTimeoutMs: 45_000, aiMode: 'off' })

    const historical = await fixture.engine.prepare(fixture.projectId, {
      sourceRunId: source.result.runId,
      configSource: 'source_run',
      aiMode: 'manual',
      confirmPaidApi: false,
    })
    expect(historical.result.configSnapshot).toMatchObject({ pageConcurrency: 3, navigationTimeoutMs: 30_000, aiMode: 'manual' })
    expect(historical.project.settings).toMatchObject({ pageConcurrency: 3, navigationTimeoutMs: 30_000, ai: { mode: 'manual' } })
    expect(hash(await readFile(sourcePath))).toBe(sourceHash)
    expect(hash(await readFile(fixture.projectStore.excelPath(fixture.projectId)))).toBe(currentExcelHash)
  })

  it('実行中run・認証モード不一致・未確認API実行を拒否する', async () => {
    const fixture = await createFixture('reject', ['https://example.com/'])
    const source = await fixture.engine.prepare(fixture.projectId)
    await expect(fixture.engine.prepare(fixture.projectId, {
      sourceRunId: source.result.runId, configSource: 'current_project', aiMode: 'off', confirmPaidApi: false,
    })).rejects.toThrow('実行中の検査')

    source.result.status = 'failed'
    source.result.configSnapshot.authMode = 'basic'
    await fixture.runStore.saveResult(fixture.projectId, source.result.runId, source.result)
    await expect(fixture.engine.prepare(fixture.projectId, {
      sourceRunId: source.result.runId, configSource: 'source_run', aiMode: 'off', confirmPaidApi: false,
    })).rejects.toThrow('認証モードが異なる')
    await expect(fixture.engine.prepare(fixture.projectId, {
      sourceRunId: source.result.runId, configSource: 'current_project', aiMode: 'api', confirmPaidApi: false,
    })).rejects.toBeInstanceOf(RunInputError)

    const apiEngine = createEngine(fixture.projectStore, fixture.runStore, async () => simpleInspector(), vi.fn(), () => 'sk-test-not-persisted')
    const apiPrepared = await apiEngine.prepare(fixture.projectId, {
      sourceRunId: source.result.runId, configSource: 'current_project', aiMode: 'api', confirmPaidApi: true,
    })
    expect(apiPrepared.result.ai).toMatchObject({ mode: 'api', status: 'preparing' })
    expect(JSON.stringify(apiPrepared.result)).not.toContain('sk-test-not-persisted')
  })

  it('再実行入力はcurrent_projectとOFFを既定にし、未知プロパティと未確認APIを拒否する', () => {
    expect(rerunRequestSchema.parse({})).toEqual({ configSource: 'current_project', aiMode: 'off', confirmPaidApi: false })
    expect(() => rerunRequestSchema.parse({ configSource: 'current_project', aiMode: 'off', confirmPaidApi: false, unknown: true })).toThrow()
    expect(() => rerunRequestSchema.parse({ configSource: 'current_project', aiMode: 'api', confirmPaidApi: false })).toThrow()
  })

  it('再実行も既存Coordinatorの二重実行防止とキャンセルを利用し、OFFではAI処理を呼ばない', async () => {
    const fixture = await createFixture('coordinator', ['https://example.com/'])
    const source = await fixture.engine.prepare(fixture.projectId)
    source.result.status = 'canceled'
    await fixture.runStore.saveResult(fixture.projectId, source.result.runId, source.result)
    let started!: () => void
    const startedPromise = new Promise<void>(resolve => { started = resolve })
    const inspector: WebsiteInspector = {
      authenticate: async () => undefined,
      close: async () => undefined,
      inspect: async (_url, signal): Promise<PageInspection> => {
        started()
        return await new Promise<PageInspection>((_resolve, reject) => signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })), { once: true }))
      },
    }
    const aiInputBuilder = vi.fn()
    const engine = createEngine(fixture.projectStore, fixture.runStore, async () => inspector, aiInputBuilder)
    const coordinator = new RunCoordinator(engine)
    const rerun = await coordinator.rerun(fixture.projectId, source.result.runId, { configSource: 'current_project', aiMode: 'off', confirmPaidApi: false })
    await startedPromise
    await expect(coordinator.rerun(fixture.projectId, source.result.runId, { configSource: 'current_project', aiMode: 'off', confirmPaidApi: false })).rejects.toThrow('別の検査')
    await coordinator.cancel(fixture.projectId, rerun.runId)
    await waitFor(async () => (await fixture.runStore.get(fixture.projectId, rerun.runId)).status === 'canceled')
    expect(aiInputBuilder).not.toHaveBeenCalled()
  })
})

describe('Phase 4-B JSON結果エクスポート', () => {
  it('allowlist形式で秘密だけをマスクし、連絡先と元resultを維持する', async () => {
    const fixture = await createFixture('json', ['https://user:pass@example.com/?token=secret&view=1'])
    const prepared = await fixture.engine.prepare(fixture.projectId)
    const imageUrl = 'https://cdn.example.com/wp-content/uploads/0123456789abcdef0123456789abcdef0123456789abcdef.svg?width=1200&X-Amz-Signature=signed-secret-value'
    prepared.result.status = 'interrupted'
    prepared.result.images.push({
      key: 'image-json', pageUrl: 'https://example.com/', device: 'desktop', imageUrl,
      sourceKind: 'img', location: 'img.hero', verdict: 'ng', message: '画像の通信エラーを確認しました。',
      evidence: [`desktop ${imageUrl}: 画像の通信エラーを確認しました。`],
    })
    prepared.result.fatalError = {
      code: 'SAFE',
      message: 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456\nJWT eyJabcdefghijk.abcdefghijk.abcdefghijk / sk-abcdefghijklmnop123456\n連絡先 contact@example.com / 03-1234-5678',
      retryable: false,
    }
    await fixture.runStore.saveResult(fixture.projectId, prepared.result.runId, prepared.result)
    const path = join(fixture.runStore.runDir(fixture.projectId, prepared.result.runId), 'result.json')
    const before = hash(await readFile(path))
    const exported = JSON.parse((await buildResultJsonExport(fixture.runStore, fixture.projectId, prepared.result.runId, new Date('2026-10-25T00:00:00Z'))).toString('utf8'))

    expect(exported).toMatchObject({ schemaVersion: 1, kind: 'web-check-result-export', snapshot: { active: false } })
    expect(exported.masking.maskedCount).toBeGreaterThan(0)
    expect(exported.result.input.pageRows[0].url).not.toContain('user:pass')
    expect(exported.result.input.pageRows[0].url).toContain('token=%5BMASKED%5D')
    expect(exported.result.fatalError.message).not.toContain('Bearer abcdef')
    expect(exported.result.fatalError.message).not.toContain('eyJabcdefghijk')
    expect(exported.result.fatalError.message).not.toContain('sk-abcdefghijklmnop')
    expect(exported.result.fatalError.message).toContain('contact@example.com')
    expect(exported.result.fatalError.message).toContain('03-1234-5678')
    expect(exported.result.images[0].imageUrl).toContain('/wp-content/uploads/0123456789abcdef0123456789abcdef0123456789abcdef.svg')
    expect(exported.result.images[0].evidence[0]).toContain('/wp-content/uploads/0123456789abcdef0123456789abcdef0123456789abcdef.svg')
    expect(JSON.stringify(exported.result.images[0])).not.toContain('signed-secret-value')
    expect(exported.result.images[0].imageUrl).not.toContain('[MASKED_HIGH_ENTROPY]')
    expect(exported.result.images[0].evidence[0]).not.toContain('[MASKED_HIGH_ENTROPY]')
    expect(hash(await readFile(path))).toBe(before)
  })

  it('実行中・旧履歴をスナップショットとして出力し、入出力50MiB超過を拒否する', async () => {
    const fixture = await createFixture('legacy', ['https://example.com/'])
    const prepared = await fixture.engine.prepare(fixture.projectId)
    const path = join(fixture.runStore.runDir(fixture.projectId, prepared.result.runId), 'result.json')
    const legacy = JSON.parse(await readFile(path, 'utf8'))
    delete legacy.ai
    delete legacy.configSnapshot.aiMode
    await fixture.runStore.saveResult(fixture.projectId, prepared.result.runId, legacy)
    const exported = JSON.parse((await buildResultJsonExport(fixture.runStore, fixture.projectId, prepared.result.runId)).toString('utf8'))
    expect(exported.snapshot.active).toBe(true)
    expect(exported.result.ai).toMatchObject({ mode: 'off', status: 'disabled' })

    const oversized = {
      resultFileSize: vi.fn(async () => RESULT_JSON_EXPORT_MAX_BYTES + 1),
      get: vi.fn(),
    } as unknown as RunStore
    await expect(buildResultJsonExport(oversized, fixture.projectId, prepared.result.runId)).rejects.toBeInstanceOf(ResultExportTooLargeError)
    expect(oversized.get).not.toHaveBeenCalled()

    const storedSize = await fixture.runStore.resultFileSize(fixture.projectId, prepared.result.runId)
    await expect(buildResultJsonExport(fixture.runStore, fixture.projectId, prepared.result.runId, new Date(), storedSize + 1))
      .rejects.toBeInstanceOf(ResultExportTooLargeError)
  })
})

async function createFixture(name: string, urls: string[]) {
  const directory = await mkdtemp(join(process.cwd(), `.test-data-phase4b-${name}-`))
  temporaryDirectories.push(directory)
  const projectStore = new ProjectStore(directory)
  const project = await projectStore.create(name, defaultProjectSettings())
  await saveWorkbook(projectStore, project.projectId, urls)
  const runStore = new RunStore(projectStore.projectsDir)
  return { projectId: project.projectId, projectStore, runStore, engine: createEngine(projectStore, runStore) }
}

function createEngine(
  projectStore: ProjectStore,
  runStore: RunStore,
  inspectorFactory = async () => simpleInspector(),
  aiInputBuilder = vi.fn(),
  openAiApiKey: () => string | undefined = () => undefined,
) {
  return new RunEngine({
    projectStore,
    runStore,
    inspectorFactory,
    linkProbeFactory: () => ({ probe: async url => ({ requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', redirectCount: 0 }) }),
    now: () => new Date(),
    aiInputBuilder,
    openAiApiKey,
  })
}

async function saveWorkbook(projectStore: ProjectStore, projectId: string, urls: string[]) {
  const workbook = new ExcelJS.Workbook()
  const pages = workbook.addWorksheet('納品前のチェック')
  pages.addRow(['ページ名', 'URL', 'title', 'description'])
  urls.forEach((url, index) => pages.addRow([`ページ${index + 1}`, url, 'Title', 'Description']))
  workbook.addWorksheet('Googleタグ').addRow(['タグ名', '設置コード'])
  await projectStore.saveExcel(projectId, 'fixture.xlsx', new Uint8Array(await workbook.xlsx.writeBuffer()))
}

function simpleInspector(): WebsiteInspector {
  return { authenticate: async () => undefined, inspect: async () => { throw new Error('not used') }, close: async () => undefined }
}

function hash(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex')
}

async function waitFor(predicate: () => boolean | Promise<boolean>): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out')
}
