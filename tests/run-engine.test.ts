import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProjectStore } from '~/server/services/project-store'
import type { LinkProbe } from '~/server/services/checks/links'
import { PageInspectionError, withPageRetries, type PageInspection, type WebsiteInspector } from '~/server/services/playwright-inspector'
import { buildFailedPageResult, RunEngine } from '~/server/services/run-engine'
import { RunStore } from '~/server/services/run-store'
import { defaultProjectSettings } from '~/shared/types/project'
import type { InputPageRow } from '~/shared/types/excel-input'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Phase 3実行基盤', () => {
  it('一時エラーだけを最大2回再試行し、3回目で成功する', async () => {
    let attempts = 0
    const result = await withPageRetries(async (attempt) => {
      attempts += 1
      if (attempt < 3) throw new PageInspectionError('一時エラー', 'TRANSIENT', true, attempt)
      return 'ok'
    }, 2, (error, attempt) => error instanceof PageInspectionError
      ? error
      : new PageInspectionError('失敗', 'FAILED', false, attempt))

    expect(result).toBe('ok')
    expect(attempts).toBe(3)
  })

  it('恒久エラーは再試行しない', async () => {
    let attempts = 0
    await expect(withPageRetries(async (attempt) => {
      attempts += 1
      throw new PageInspectionError('404', 'HTTP_404', false, attempt, 404)
    }, 2, error => error as PageInspectionError)).rejects.toMatchObject({ code: 'HTTP_404' })
    expect(attempts).toBe(1)
  })

  it('404はページ取得だけNG、5個別項目を未確認にする', () => {
    const row: InputPageRow = {
      sourceRow: 2,
      pageName: 'Not found',
      displayName: 'Not found',
      url: 'https://example.com/missing',
      normalizedUrl: 'https://example.com/missing',
      expectedTitle: 'Title',
      expectedDescription: 'Description',
      titleState: 'value',
      descriptionState: 'value',
    }
    const page = buildFailedPageResult(
      row.normalizedUrl,
      [row],
      '2026-10-20T00:00:00.000Z',
      '2026-10-20T00:00:01.000Z',
      new PageInspectionError('ページ取得がHTTP 404でした。', 'HTTP_404', false, 1, 404),
    )

    expect(page.findings.filter(item => item.verdict === 'ng')).toHaveLength(1)
    expect(page.findings.filter(item => item.verdict === 'unchecked')).toHaveLength(5)
    expect(page.httpStatus).toBe(404)
  })

  it('重複URLを1回だけ取得し、後続ページ失敗前の途中結果を保存する', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.test-data-phase3-run-'))
    temporaryDirectories.push(directory)
    const projectStore = new ProjectStore(directory)
    const settings = defaultProjectSettings()
    settings.pageConcurrency = 1
    const project = await projectStore.create('Phase 3 fixture', settings)
    const workbook = new ExcelJS.Workbook()
    const pages = workbook.addWorksheet('納品前のチェック')
    pages.addRow(['ページ名', 'URL', 'title', 'description'])
    pages.addRow(['トップA', 'https://example.com/#a', 'Title', 'Description'])
    pages.addRow(['トップB', 'https://example.com/#b', 'Title', 'Description'])
    pages.addRow(['404', 'https://example.com/missing', 'Missing', 'Missing description'])
    workbook.addWorksheet('Googleタグ').addRow(['タグ名', '設置コード'])
    await projectStore.saveExcel(project.projectId, 'fixture.xlsx', new Uint8Array(await workbook.xlsx.writeBuffer()))

    let inspectCalls = 0
    let releaseSecond!: () => void
    let signalSecond!: () => void
    const secondStarted = new Promise<void>(resolve => { signalSecond = resolve })
    const secondRelease = new Promise<void>(resolve => { releaseSecond = resolve })
    const inspector: WebsiteInspector = {
      authenticate: async () => undefined,
      close: async () => undefined,
      inspect: async (url) => {
        inspectCalls += 1
        if (inspectCalls === 2) {
          signalSecond()
          await secondRelease
          throw new PageInspectionError('ページ取得がHTTP 404でした。', 'HTTP_404', false, 1, 404)
        }
        return successfulInspection(url)
      },
    }
    const runStore = new RunStore(projectStore.projectsDir)
    let time = Date.parse('2026-10-20T00:00:00.000Z')
    const aiInputBuilder = vi.fn(async () => { throw new Error('OFFでは呼び出してはいけません') })
    const engine = new RunEngine({
      projectStore,
      runStore,
      inspectorFactory: async () => inspector,
      linkProbeFactory: () => ({ probe: async url => ({ requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', redirectCount: 0 }) }),
      now: () => new Date(time += 1_000),
      aiInputBuilder,
    })

    const prepared = await engine.prepare(project.projectId)
    const completion = engine.execute(prepared)
    await secondStarted
    const partial = await runStore.get(project.projectId, prepared.result.runId)
    expect(partial.status).toBe('checking')
    expect(partial.pages).toHaveLength(1)
    expect(partial.pages[0].sourceRows).toEqual([2, 3])

    releaseSecond()
    const result = await completion
    expect(inspectCalls).toBe(2)
    expect(result.status).toBe('completed')
    expect(result.pages).toHaveLength(2)
    expect(result.summary.ng).toBe(1)
    expect(result.summary.unchecked).toBe(5)
    expect(result.ai).toMatchObject({ mode: 'off', status: 'disabled' })
    expect(aiInputBuilder).not.toHaveBeenCalled()

    const resultPath = join(projectStore.projectsDir, project.projectId, 'runs', result.runId, 'result.json')
    const persisted = JSON.parse(await readFile(resultPath, 'utf8'))
    expect(persisted.status).toBe('completed')
    expect(persisted.fatalError).toBeUndefined()

    delete persisted.ai
    delete persisted.configSnapshot.aiMode
    await writeFile(resultPath, `${JSON.stringify(persisted, null, 2)}\n`)
    const legacyLoaded = await runStore.get(project.projectId, result.runId)
    expect(legacyLoaded.configSnapshot.aiMode).toBe('off')
    expect(legacyLoaded.ai).toMatchObject({ mode: 'off', status: 'disabled' })

    const history = await runStore.list(project.projectId)
    expect(history).toHaveLength(1)
    expect(history[0]).toMatchObject({
      runId: result.runId,
      status: 'completed',
      totalPages: 2,
      completedPages: 2,
      summary: { ng: 1, unchecked: 5 },
    })
  })

  it('AI入力準備に失敗しても機械検査結果を維持して完了する', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.test-data-phase5a-run-'))
    temporaryDirectories.push(directory)
    const projectStore = new ProjectStore(directory)
    const settings = defaultProjectSettings()
    settings.ai.mode = 'manual'
    const project = await projectStore.create('Phase 5-A fixture', settings)
    const workbook = new ExcelJS.Workbook()
    const pages = workbook.addWorksheet('納品前のチェック')
    pages.addRow(['ページ名', 'URL', 'title', 'description'])
    pages.addRow(['トップ', 'https://example.com/', 'Title', 'Description'])
    workbook.addWorksheet('Googleタグ').addRow(['タグ名', '設置コード'])
    await projectStore.saveExcel(project.projectId, 'fixture.xlsx', new Uint8Array(await workbook.xlsx.writeBuffer()))

    const inspector: WebsiteInspector = {
      authenticate: async () => undefined,
      close: async () => undefined,
      inspect: async url => successfulInspection(url),
    }
    const runStore = new RunStore(projectStore.projectsDir)
    const aiInputBuilder = vi.fn(async () => { throw new Error('secret failure detail') })
    const engine = new RunEngine({
      projectStore,
      runStore,
      inspectorFactory: async () => inspector,
      linkProbeFactory: () => ({ probe: async url => ({ requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', redirectCount: 0 }) }),
      now: () => new Date('2026-10-21T00:00:00.000Z'),
      aiInputBuilder,
      aiSigningKey: () => new Uint8Array(32),
    })

    const prepared = await engine.prepare(project.projectId)
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const result = await engine.execute(prepared)

    expect(aiInputBuilder).toHaveBeenCalledOnce()
    expect(result.status).toBe('completed')
    expect(result.summary).toMatchObject({ ng: 0, needsReview: 0, unchecked: 0 })
    expect(result.ai).toMatchObject({
      mode: 'manual',
      status: 'preparation_failed',
      error: { code: 'AI_INPUT_BUNDLE_GENERATION_FAILED' },
    })
    expect(JSON.stringify(result)).not.toContain('secret failure detail')
    expect(JSON.stringify(errorLog.mock.calls)).toContain('bundle_generation')
    expect(JSON.stringify(errorLog.mock.calls)).not.toContain('secret failure detail')
    const events = await readFile(join(runStore.runDir(project.projectId, result.runId), 'events.jsonl'), 'utf8')
    expect(events).toContain('AI_INPUT_BUNDLE_GENERATION_FAILED')
    expect(events).toContain('"stage":"bundle_generation"')
    expect(events).not.toContain('secret failure detail')
    errorLog.mockRestore()
  })

  it('AI用リンク先取得だけが失敗した場合も機械リンク判定を変更しない', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.test-data-phase5a-target-'))
    temporaryDirectories.push(directory)
    const projectStore = new ProjectStore(directory)
    const settings = defaultProjectSettings()
    settings.ai.mode = 'manual'
    const project = await projectStore.create('Phase 5-A target fixture', settings)
    const workbook = new ExcelJS.Workbook()
    const pages = workbook.addWorksheet('納品前のチェック')
    pages.addRow(['ページ名', 'URL', 'title', 'description'])
    pages.addRow(['トップ', 'https://example.com/', 'Title', 'Description'])
    workbook.addWorksheet('Googleタグ').addRow(['タグ名', '設置コード'])
    await projectStore.saveExcel(project.projectId, 'fixture.xlsx', new Uint8Array(await workbook.xlsx.writeBuffer()))

    const inspector: WebsiteInspector = {
      authenticate: async () => undefined,
      close: async () => undefined,
      inspect: async url => ({
        ...successfulInspection(url),
        links: [{
          href: '/target',
          resolvedUrl: 'https://example.com/target',
          text: '移動先',
          beforeText: '詳しくは',
          afterText: 'をご覧ください。',
          isImageLink: false,
        }],
      }),
    }
    const probe: LinkProbe = {
      probe: async (url, includeBody) => {
        if (includeBody) throw new Error('AI target unavailable')
        return { requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', redirectCount: 0 }
      },
    }
    const engine = new RunEngine({
      projectStore,
      runStore: new RunStore(projectStore.projectsDir),
      inspectorFactory: async () => inspector,
      linkProbeFactory: () => probe,
      now: () => new Date('2026-10-21T00:00:00.000Z'),
      aiSigningKey: () => new Uint8Array(32),
    })

    const result = await engine.execute(await engine.prepare(project.projectId))

    expect(result.status).toBe('completed')
    expect(result.links[0]).toMatchObject({ verdict: 'ok', status: 200 })
    expect(result.ai).toMatchObject({ mode: 'manual', status: 'awaiting_manual' })
    expect(result.ai?.inputBundle?.items[0]?.target.fetchStatus).toBe('fetch_failed')
    expect(result.summary.ng).toBe(0)
  })
})

function successfulInspection(url: string): PageInspection {
  const html = '<html><head><title>Title</title><meta name="description" content="Description"></head><body></body></html>'
  return {
    requestedUrl: url,
    finalUrl: 'https://example.com/',
    status: 200,
    attempts: 1,
    rawHtml: html,
    renderedHtml: html,
    metadata: { titles: ['Title'], descriptions: ['Description'] },
    links: [],
    anchorTargets: [],
    networkTags: [],
    images: [
      { device: 'desktop', images: [], timedOut: false },
      { device: 'mobile', images: [], timedOut: false },
    ],
  }
}
