import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { afterEach, describe, expect, it } from 'vitest'
import { ProjectStore } from '~/server/services/project-store'
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
    const engine = new RunEngine({
      projectStore,
      runStore,
      inspectorFactory: async () => inspector,
      linkProbeFactory: () => ({ probe: async url => ({ requestedUrl: url, finalUrl: url, status: 200, contentType: 'text/html', redirectCount: 0 }) }),
      now: () => new Date(time += 1_000),
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

    const persisted = JSON.parse(await readFile(join(projectStore.projectsDir, project.projectId, 'runs', result.runId, 'result.json'), 'utf8'))
    expect(persisted.status).toBe('completed')
    expect(persisted.fatalError).toBeUndefined()

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
