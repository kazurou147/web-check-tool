import { createHash, randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { attachRunSummaries } from '~/server/services/project-run-summary'
import { compareRunResults } from '~/server/services/run-comparison'
import { MAX_RUN_RESULT_BYTES, RunCorruptError, RunStore, RunTooLargeError } from '~/server/services/run-store'
import type { AiRunData } from '~/shared/types/ai'
import type { ProjectView } from '~/shared/types/project'
import { defaultProjectSettings } from '~/shared/types/project'
import type { Finding, LinkResult, RunResult, RunStatus, Verdict } from '~/shared/types/run'
import { runComparisonQuerySchema } from '~/server/services/validation'

const temporaryDirectories: string[] = []
afterEach(async () => Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))))

describe('Phase 4-C 履歴比較', () => {
  it('NG解消・発生・継続とNGから各状態への変化を定義どおり分類する', () => {
    const base = makeRun('completed', [
      finding('title', 'ng'), finding('description', 'ok'), finding('page_fetch', 'ng'),
      finding('google_tags', 'ng'), finding('links', 'ng'), finding('images', 'ng'),
    ])
    const target = makeRun('completed', [
      finding('title', 'ok'), finding('description', 'ng'), finding('page_fetch', 'ng'),
      finding('google_tags', 'needs_review'), finding('links', 'unchecked'), finding('images', 'excluded'),
    ])
    const compared = compareRunResults(base, target, query(base, target))

    expect(compared.summary.aggregate).toMatchObject({ ngResolved: 1, ngIntroduced: 1, ngContinued: 1 })
    expect(compared.summary.verdictTransitions).toMatchObject({ 'ng->ok': 1, 'ok->ng': 1, 'ng->needs_review': 1, 'ng->unchecked': 1, 'ng->excluded': 1 })
    expect(compared.changes.find(change => change.item === 'links')?.issueOutcome).toBe('became_unchecked')
    expect(compared.changes.find(change => change.item === 'images')?.issueOutcome).toBe('became_excluded')
  })

  it('同一URLの行順・ページ名変更はメタデータ変更とし、URL変更は追加・削除にする', () => {
    const base = makeRun('completed', [finding('title', 'ok', 'old title')], 'https://example.com/old', ['旧名'], [2])
    const target = makeRun('completed', [finding('title', 'ok', 'new title')], 'https://example.com/old', ['新名'], [8])
    const metadata = compareRunResults(base, target, query(base, target))
    expect(metadata.changes[0]).toMatchObject({ presence: 'matched', changeKinds: expect.arrayContaining(['expected', 'metadata']) })

    target.pages[0]!.normalizedUrl = 'https://example.com/new'
    target.pages[0]!.findings[0]!.url = 'https://example.com/new'
    target.pages[0]!.findings[0]!.key = 'https://example.com/new|title'
    const changedUrl = compareRunResults(base, target, query(base, target))
    expect(changedUrl.summary.aggregate).toMatchObject({ added: 1, removed: 1, ngResolved: 0, ngIntroduced: 0 })
  })

  it('DOM順変更をインデックスだけで比較せず、重複の一意対応不能は不確実にする', () => {
    const base = makeRun('completed', [])
    const target = makeRun('completed', [])
    base.links = [link(0, '/same', 'ok', '正常'), link(1, '/same', 'ng', '失敗')]
    target.links = [link(9, '/same', 'ng', '失敗'), link(8, '/same', 'ok', '正常')]
    const reordered = compareRunResults(base, target, query(base, target))
    expect(reordered.summary.detail).toMatchObject({ ngContinued: 1, added: 0, removed: 0, uncertain: 0 })

    target.links = [link(9, '/same', 'ng', '失敗'), link(8, '/same', 'needs_review', '要確認')]
    const ambiguous = compareRunResults(base, target, query(base, target))
    expect(ambiguous.summary.detail.uncertain).toBe(1)
    expect(ambiguous.changes.some(change => change.confidence === 'uncertain' && change.issueOutcome === 'indeterminate')).toBe(true)
  })

  it('途中終了runの片側欠落を解消・削除と断定しない', () => {
    const base = makeRun('completed', [finding('title', 'ng')])
    const target = makeRun('canceled', [])
    const compared = compareRunResults(base, target, query(base, target))
    expect(compared.reliability).toBe('partial')
    expect(compared.summary.aggregate).toMatchObject({ removed: 0, ngResolved: 0, unobserved: 1, uncertain: 1 })
    expect(compared.changes[0]).toMatchObject({ presence: 'unobserved', issueOutcome: 'indeterminate' })
  })

  it('AI判定とAI条件差を機械集約と分離し、元データを変更しない', () => {
    const base = makeRun('completed', [finding('title', 'ok')])
    const target = structuredClone(base)
    target.runId = randomUUID()
    target.ai = aiData('manual', 'match', '理由A', 'model-a')
    base.ai = aiData('manual', 'possible_mismatch', '理由B', 'model-b')
    const beforeHash = hashJson(base)
    const compared = compareRunResults(base, target, query(base, target))
    expect(compared.summary.aggregate.changed).toBe(0)
    expect(compared.summary.ai).toMatchObject({ ngIntroduced: 0, changed: 1 })
    expect(compared.conditionDifferences.map(item => item.key)).toContain('aiModel')
    expect(hashJson(base)).toBe(beforeHash)
  })

  it('画像のDOM順変更を吸収し、カテゴリ・ページ・項目フィルターとページングを適用する', () => {
    const base = makeRun('completed', [finding('title', 'ng')])
    const target = structuredClone(base)
    target.runId = randomUUID()
    base.images = [image(0, '/a.png', 'ok'), image(1, '/a.png', 'ng')]
    target.images = [image(7, '/a.png', 'ng'), image(8, '/a.png', 'ok')]
    const filtered = compareRunResults(base, target, { ...query(base, target), category: 'detail', pageUrl: 'example.com', item: '画像', pageSize: 1 })
    expect(filtered.summary.detail).toMatchObject({ ngContinued: 1, added: 0, removed: 0 })
    expect(filtered.pagination).toMatchObject({ page: 1, pageSize: 1, total: 2, totalPages: 2 })
    expect(filtered.changes[0]?.entityType).toBe('image')
  })

  it('比較クエリで不正IDと同一runを拒否する', () => {
    const id = randomUUID()
    expect(() => runComparisonQuerySchema.parse({ base: 'invalid', target: randomUUID() })).toThrow()
    expect(() => runComparisonQuerySchema.parse({ base: id, target: id })).toThrow('同じ検査結果')
  })

  it('比較レスポンスからURL認証情報・秘密クエリ・秘密ヘッダーを除去する', () => {
    const base = makeRun('completed', [finding('title', 'ng', 'https://user:pass@example.com/?token=secret')], 'https://user:pass@example.com/page?key=secret')
    base.pages[0]!.findings[0]!.message = 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456'
    const target = structuredClone(base)
    target.runId = randomUUID()
    target.pages[0]!.findings[0]!.message = 'safe'
    const serialized = JSON.stringify(compareRunResults(base, target, query(base, target)))
    expect(serialized).not.toContain('user:pass')
    expect(serialized).not.toContain('token=secret')
    expect(serialized).not.toContain('key=secret')
    expect(serialized).not.toContain('Bearer abcdef')
  })

  it('Excel入力警告と重複URL期待値の変化を入力カテゴリだけで比較する', () => {
    const base = makeRun('completed', [])
    const target = structuredClone(base)
    target.runId = randomUUID()
    base.input.invalidRows = [{ code: 'invalid_url', severity: 'warning', sheetName: '納品前のチェック', row: 4, column: 'B', message: 'URLが不正です。' }]
    base.input.duplicateGroups = [{
      normalizedUrl: 'https://example.com/page', sourceRows: [2, 3], pageNames: ['A', 'B'],
      titleExpectation: { state: 'conflict', values: ['A', 'B'] }, descriptionExpectation: { state: 'unique', values: ['D'] },
    }]
    target.input.duplicateGroups = [{
      normalizedUrl: 'https://example.com/page', sourceRows: [8, 9], pageNames: ['新A', '新B'],
      titleExpectation: { state: 'unique', values: ['A'] }, descriptionExpectation: { state: 'unique', values: ['D'] },
    }]
    const compared = compareRunResults(base, target, query(base, target))
    expect(compared.summary.input).toMatchObject({ changed: 2, removed: 1 })
    expect(compared.changes.find(change => change.entityType === 'duplicate_url')).toMatchObject({ presence: 'matched', changeKinds: expect.arrayContaining(['verdict', 'actual', 'metadata']) })
  })
})

describe('Phase 4-C 安全な履歴一覧と案件サマリー', () => {
  it('破損・過大履歴を隔離して正常履歴を返し、直接読込は安全な例外にする', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.test-data-phase4c-'))
    temporaryDirectories.push(directory)
    const projectId = randomUUID()
    const store = new RunStore(join(directory, 'projects'))
    const normal = makeRun('completed', [finding('title', 'ok')])
    normal.projectId = projectId
    await mkdir(join(directory, 'projects', projectId, 'runs'), { recursive: true })
    await store.create(projectId, normal.runId, normal.input, normal)

    const corruptId = randomUUID()
    const corruptDir = store.runDir(projectId, corruptId)
    await mkdir(corruptDir, { recursive: true })
    await writeFile(join(corruptDir, 'result.json'), '{broken')
    const oversizedId = randomUUID()
    const oversizedDir = store.runDir(projectId, oversizedId)
    await mkdir(oversizedDir, { recursive: true })
    await writeFile(join(oversizedDir, 'result.json'), '{}')
    await truncate(join(oversizedDir, 'result.json'), MAX_RUN_RESULT_BYTES + 1)

    const history = await store.listDetailed(projectId)
    expect(history.runs).toHaveLength(1)
    expect(history.health).toEqual({ corruptedCount: 1, oversizedCount: 1 })
    await expect(store.get(projectId, corruptId)).rejects.toBeInstanceOf(RunCorruptError)
    await expect(store.get(projectId, oversizedId)).rejects.toBeInstanceOf(RunTooLargeError)

    const active = makeRun('checking', [finding('title', 'ok')])
    active.projectId = projectId
    await store.create(projectId, active.runId, active.input, active)
    const recovery = await store.recoverInterruptedRuns(new Date('2026-10-25T03:00:00.000Z'))
    expect(recovery).toMatchObject({
      recovered: [{ projectId, runId: active.runId, previousStatus: 'checking' }],
      skippedInvalid: 2,
    })
    expect((await store.get(projectId, active.runId)).status).toBe('interrupted')
  })

  it('多数案件を元順序のまま処理し、最新runと直近completedを分ける', async () => {
    const projects = Array.from({ length: 24 }, (_, index): ProjectView => ({
      schemaVersion: 1, projectId: randomUUID(), name: `案件${index}`, createdAt: '2026-01-01T00:00:00Z', updatedAt: `2026-01-${String(index + 1).padStart(2, '0')}T00:00:00Z`, archivedAt: null, excelFileName: '', settings: defaultProjectSettings(), credentialsConfigured: false,
    }))
    const active = summary('checking', '2026-10-25T02:00:00Z')
    const completed = summary('completed', '2026-10-25T01:00:00Z')
    const store = {
      listDetailed: async () => ({ runs: [active, completed], health: { corruptedCount: 1, oversizedCount: 0 } }),
    } as unknown as RunStore
    const enriched = await attachRunSummaries(projects, store)
    expect(enriched.map(project => project.name)).toEqual(projects.map(project => project.name))
    expect(enriched[0]).toMatchObject({ latestRun: { status: 'checking' }, latestCompletedRun: { status: 'completed' }, historyHealth: { corruptedCount: 1 } })
  })

  it('新しい省略可能フィールドがない旧履歴を補完して読み込む', async () => {
    const directory = await mkdtemp(join(process.cwd(), '.test-data-phase4c-legacy-'))
    temporaryDirectories.push(directory)
    const projectId = randomUUID()
    const store = new RunStore(join(directory, 'projects'))
    const legacy = makeRun('completed', [finding('title', 'ok')]) as RunResult & { ai?: undefined }
    legacy.projectId = projectId
    delete legacy.ai
    delete (legacy.configSnapshot as Partial<RunResult['configSnapshot']>).aiMode
    delete legacy.summary.excluded
    await mkdir(join(directory, 'projects', projectId, 'runs'), { recursive: true })
    await store.create(projectId, legacy.runId, legacy.input, legacy)
    const loaded = await store.get(projectId, legacy.runId)
    expect(loaded.ai).toMatchObject({ mode: 'off', status: 'disabled' })
    expect(loaded.summary.excluded).toBe(0)
  })
})

function makeRun(status: RunStatus, findings: Finding[], url = 'https://example.com/page', pageNames = ['ページ'], sourceRows = [2]): RunResult {
  const runId = randomUUID()
  for (const value of findings) {
    value.url = url
    value.key = `${url}|${value.item}`
    value.pageNames = pageNames
    value.sourceRows = sourceRows
  }
  return {
    schemaVersion: 1, runId, projectId: randomUUID(), status,
    createdAt: '2026-10-25T00:00:00.000Z', updatedAt: '2026-10-25T00:01:00.000Z', finishedAt: status === 'completed' ? '2026-10-25T00:01:00.000Z' : undefined,
    configSnapshot: { pageConcurrency: 3, navigationTimeoutMs: 30_000, retryCount: 2, maxRedirects: 5, maxResponseBytes: 10_000_000, linkTimeoutMs: 10_000, imageTimeoutMsPerDevice: 60_000, imageScrollWaitMs: 1_000, authMode: 'none', allowedPrivateHosts: [], aiMode: 'off', viewports: { desktop: { width: 1366, height: 768 }, mobile: { width: 375, height: 667 } } },
    input: { schemaVersion: 1, sourceFileName: 'input.xlsx', sheetName: '納品前のチェック', tagSheetName: 'Googleタグ', canStart: true, totalDataRows: 1, blankRows: 0, hiddenExcludedRows: 0, validRows: 1, uniqueUrlCount: 1, pageRows: [], invalidRows: [], headerIssues: [], formulaIssues: [], mergeIssues: [], tagIssues: [], duplicateGroups: [], expectedGoogleTags: [] },
    summary: { ng: 0, needsReview: 0, unchecked: 0, excluded: 0, ok: 0 },
    pages: [{ normalizedUrl: url, requestedUrl: url, pageNames, sourceRows, startedAt: '2026-10-25T00:00:00Z', finishedAt: '2026-10-25T00:00:01Z', attempts: 1, findings }],
    links: [], images: [], googleTagDetections: [], aiUsage: { enabled: false, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, estimatedCostUsd: 0, costLimitUsd: 1, stoppedByCostLimit: false, apiFailureCount: 0 },
  }
}

function finding(item: Finding['item'], verdict: Verdict, expected = 'expected'): Finding {
  return { key: '', item, verdict, detailStatus: verdict, url: '', pageNames: [], sourceRows: [], expected, actual: ['actual'], message: `${item}-${verdict}`, evidence: [] }
}

function link(index: number, href: string, verdict: Verdict, message: string): LinkResult {
  return { key: `https://example.com/page|link|${index}|${href}`, pageUrl: 'https://example.com/page', href, resolvedUrl: `https://example.com${href}`, finalUrl: `https://example.com${href}`, kind: 'http', verdict, status: verdict === 'ng' ? 404 : 200, redirectCount: 0, isImageLink: false, message, evidence: [] }
}

function image(index: number, imageUrl: string, verdict: Verdict): RunResult['images'][number] {
  return { key: `https://example.com/page|image|mobile|${index}|${imageUrl}`, pageUrl: 'https://example.com/page', device: 'mobile', imageUrl: `https://example.com${imageUrl}`, sourceKind: 'img', location: `.item:nth-child(${index + 1})`, verdict, message: verdict === 'ng' ? '失敗' : '正常', evidence: [] }
}

function aiData(mode: 'manual' | 'api', verdict: 'match' | 'possible_mismatch', reason: string, model: string): AiRunData {
  const output = { schemaVersion: 1 as const, kind: 'web-check-ai-output' as const, contractVersion: '1', promptVersion: '1', projectId: 'p', runId: 'r', inputBundleId: 'b', inputPayloadHash: 'h', judge: { mode, model }, judgments: [{ itemId: 'item', inputHash: 'hash', verdict, reason }] }
  return { mode, status: 'completed', contractVersion: '1', promptVersion: '1', model, ...(mode === 'manual' ? { manualResult: { output, importedAt: '2026-10-25T00:00:00Z', outputHash: 'o' } } : { apiResult: { output, completedAt: '2026-10-25T00:00:00Z', failedCount: 0 } }) }
}

function query(base: RunResult, target: RunResult) {
  target.projectId = base.projectId
  return { base: base.runId, target: target.runId, page: 1, pageSize: 100 } as const
}

function summary(status: RunStatus, createdAt: string) {
  return { runId: randomUUID(), status, createdAt, updatedAt: createdAt, totalPages: 3, completedPages: status === 'completed' ? 3 : 1, summary: { ng: 1, needsReview: 0, unchecked: 0, excluded: 0, ok: 5 } }
}

function hashJson(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
