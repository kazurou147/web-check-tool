import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import ExcelJS from 'exceljs'
import { afterEach, describe, expect, it } from 'vitest'
import { REPORT_ALL_COLUMNS, REPORT_ISSUE_COLUMNS, REPORT_MAX_CELL_CHARACTERS, REPORT_SHEET_NAMES, REPORT_TRUNCATION_MARKER } from '~/shared/config/excel-report'
import type { Project } from '~/shared/types/project'
import { defaultProjectSettings } from '~/shared/types/project'
import type { RunResult } from '~/shared/types/run'
import { buildExcelReport, buildExcelReportRows, ExcelReportNotReadyError, redactReportUrl, safeExcelText, safeHttpHyperlink } from '~/server/services/excel-report'
import { generateExcelReport } from '~/server/services/excel-report-export'
import { ProjectStore } from '~/server/services/project-store'
import { RunNotFoundError, RunReportNotFoundError, RunStore } from '~/server/services/run-store'

const temporaryDirectories: string[] = []

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Phase 6 Excelレポート', () => {
  it('3シート、必須列、集計、フィルター、固定行、入力規則を生成する', async () => {
    const workbook = await loadReport(makeProject(), makeRun('api'))

    expect(workbook.worksheets.map(sheet => sheet.name)).toEqual([
      REPORT_SHEET_NAMES.summary,
      REPORT_SHEET_NAMES.issues,
      REPORT_SHEET_NAMES.all,
    ])

    const summary = workbook.getWorksheet(REPORT_SHEET_NAMES.summary)!
    expect(summary.getRow(1).values).toEqual([undefined, '区分', '項目', '値', '詳細'])
    expect(summary.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 })
    expect(findSummaryValue(summary, 'ページ項目判定', '総件数')).toBe(6)
    expect(findSummaryValue(summary, '個別リンク', '総件数')).toBe(2)
    expect(findSummaryValue(summary, '個別画像', '対象外')).toBe(1)
    expect(findSummaryValue(summary, 'AI判定', '判定完了件数')).toBe(2)
    expect(findSummaryValue(summary, 'AI使用量', 'API失敗件数')).toBe(1)
    expect(summary.getRows(1, summary.rowCount)?.some(row => row.getCell(1).value === '入力警告')).toBe(true)

    const issues = workbook.getWorksheet(REPORT_SHEET_NAMES.issues)!
    const all = workbook.getWorksheet(REPORT_SHEET_NAMES.all)!
    expect(issues.getRow(1).values).toEqual([undefined, ...REPORT_ISSUE_COLUMNS.map(column => column.header)])
    expect(all.getRow(1).values).toEqual([undefined, ...REPORT_ALL_COLUMNS.map(column => column.header)])
    expect(issues.autoFilter).toBeTruthy()
    expect(all.autoFilter).toBeTruthy()
    expect(issues.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 })
    expect(issues.getRow(2).height).toBeUndefined()
    expect(all.getRow(2).height).toBeUndefined()
    const correctionColumn = columnNumber(issues, '修正状況')
    for (let rowNumber = 2; rowNumber <= issues.rowCount; rowNumber += 1) {
      expect(issues.getCell(rowNumber, correctionColumn).value).toBe('未対応')
      expect(issues.getCell(rowNumber, correctionColumn).dataValidation).toMatchObject({ type: 'list' })
    }
  })

  it('問題一覧の抽出、全結果の判定順、集約と詳細、AIと機械検査を分離する', async () => {
    const workbook = await loadReport(makeProject(), makeRun('api'))
    const issues = workbook.getWorksheet(REPORT_SHEET_NAMES.issues)!
    const all = workbook.getWorksheet(REPORT_SHEET_NAMES.all)!
    const issueVerdicts = columnValues(issues, '判定')
    expect(issueVerdicts).not.toContain('OK')
    expect(issueVerdicts).not.toContain('対象外')
    expect(issueVerdicts).toContain('判定不可')

    const verdictRank = new Map([['NG', 0], ['要確認', 1], ['判定不可', 1], ['未確認', 2], ['対象外', 3], ['OK', 4]])
    const ranks = columnValues(all, '判定').map(value => verdictRank.get(String(value)))
    expect(ranks).toEqual([...ranks].sort((left, right) => left! - right!))
    const resultTypes = columnValues(all, '結果種別')
    expect(resultTypes).toContain('機械検査（ページ集約）')
    expect(resultTypes).toContain('機械検査（リンク詳細）')
    expect(resultTypes).toContain('機械検査（画像詳細）')
    expect(resultTypes).toContain('機械検査（Googleタグ詳細）')
    expect(resultTypes).toContain('AI判定（API）')
  })

  it('title差分、不可視文字、端末、Googleタグ、リンク、画像の詳細を出力する', async () => {
    const workbook = await loadReport(makeProject(), makeRun('api'))
    const all = workbook.getWorksheet(REPORT_SHEET_NAMES.all)!
    const titleRow = findRow(all, '安定キー', 'https://example.com/|title')
    const difference = String(titleRow.getCell(columnNumber(all, '差分')).value)
    expect(difference).toContain('期待3文字／実測5文字')
    expect(difference).toContain('最初の相違：2文字目')
    expect(difference).toContain('先頭付近に差異あり')
    expect(difference).toContain('相違文字：期待「…」／実測「.」')
    expect(difference).not.toContain('U+2026')
    const evidence = String(titleRow.getCell(columnNumber(all, '根拠')).value)
    expect(evidence).toContain('【詳細差分】')
    expect(evidence).toContain('U+2026')
    expect(evidence).toContain('U+002E')
    expect(evidence).toContain('期待差分')
    expect(evidence).toContain('実測差分')

    const imageRow = findRow(all, '安定キー', 'image-mobile')
    expect(imageRow.getCell(columnNumber(all, '端末')).value).toBe('スマートフォン')
    expect(imageRow.getCell(columnNumber(all, '実測値')).value).toContain('media query')
    expect(findRow(all, '安定キー', 'tag-1').getCell(columnNumber(all, '実測値')).value).toContain('html_direct')
    const linkRow = findRow(all, '安定キー', 'link-ng')
    expect(linkRow.getCell(columnNumber(all, '実測値')).value).toContain('HTTP')
    expect(linkRow.getCell(columnNumber(all, 'URL')).value).toMatchObject({
      text: 'https://example.com/missing',
      hyperlink: 'https://example.com/missing',
    })
  })

  it('画像URLの通常パスをExcelへ維持し、秘密クエリだけをマスクする', async () => {
    const result = makeRun('off')
    const imageUrl = 'https://cdn.example.com/wp-content/uploads/0123456789abcdef0123456789abcdef0123456789abcdef.jpeg?width=1200&X-Amz-Signature=signed-secret-value'
    result.images[0]!.imageUrl = imageUrl
    result.images[0]!.evidence = [`desktop ${imageUrl}: 画像の通信エラーを確認しました。`]
    const workbook = await loadReport(makeProject(), result)
    const all = workbook.getWorksheet(REPORT_SHEET_NAMES.all)!
    const imageRow = findRow(all, '安定キー', 'image-mobile')
    const url = String((imageRow.getCell(columnNumber(all, 'URL')).value as ExcelJS.CellHyperlinkValue).text)
    const evidence = String(imageRow.getCell(columnNumber(all, '根拠')).value)

    expect(url).toContain('/wp-content/uploads/0123456789abcdef0123456789abcdef0123456789abcdef.jpeg')
    expect(evidence).toContain('/wp-content/uploads/0123456789abcdef0123456789abcdef0123456789abcdef.jpeg')
    expect(`${url}\n${evidence}`).not.toContain('signed-secret-value')
    expect(`${url}\n${evidence}`).not.toContain('[MASKED_HIGH_ENTROPY]')
  })

  it('半角・全角スペースの差を要約し、期待値と実測値を変更しない', async () => {
    const result = makeRun('off')
    const finding = result.pages[0]!.findings.find(item => item.item === 'title')!
    finding.expected = '犬 猫'
    finding.actual = ['犬　猫']
    const workbook = await loadReport(makeProject(), result)
    const issues = workbook.getWorksheet(REPORT_SHEET_NAMES.issues)!
    const titleRow = findRow(issues, '安定キー', 'https://example.com/|title')

    expect(titleRow.getCell(columnNumber(issues, '期待値')).value).toBe('犬 猫')
    expect(titleRow.getCell(columnNumber(issues, '実測値')).value).toBe('[\n  "犬　猫"\n]')
    expect(titleRow.getCell(columnNumber(issues, '差分')).value).toContain('不可視文字等：期待「半角スペース」／実測「全角スペース」')
    const evidence = String(titleRow.getCell(columnNumber(issues, '根拠')).value)
    expect(evidence).toContain('U+0020')
    expect(evidence).toContain('U+3000')
  })

  it('安全なHTTP URLだけをリンク化し、外部文字列を数式にせずセル上限内へ収める', async () => {
    expect(safeHttpHyperlink('https://example.com/path')).toBe('https://example.com/path')
    expect(safeHttpHyperlink('javascript:alert(1)')).toBeUndefined()
    expect(safeHttpHyperlink('file:///C:/secret')).toBeUndefined()
    expect(redactReportUrl('https://user:pass@example.com/path?cid=123&token=secret&safe=yes')).toBe('https://example.com/path?cid=%5BREDACTED%5D&token=%5BREDACTED%5D&safe=yes')
    for (const value of ['=HYPERLINK("https://evil.example")', '+cmd', '-danger', '@SUM(A1:A2)']) {
      expect(safeExcelText(value)).toBe(`'${value}`)
    }
    expect(safeExcelText('SUM(A1:A2)')).toBe('SUM(A1:A2)')
    const long = safeExcelText('x'.repeat(40_000))
    expect(long.length).toBeLessThanOrEqual(REPORT_MAX_CELL_CHARACTERS)
    expect(long.endsWith(REPORT_TRUNCATION_MARKER)).toBe(true)

    const workbook = await loadReport(makeProject(), makeRun('api'))
    const all = workbook.getWorksheet(REPORT_SHEET_NAMES.all)!
    const dangerous = findRow(all, '安定キー', 'dangerous-link')
    const urlCell = dangerous.getCell(columnNumber(all, 'URL'))
    expect(urlCell.value).toBe('javascript:alert(1)')
    expect(typeof urlCell.value === 'object' && urlCell.value && 'formula' in urlCell.value).toBe(false)
    expect(urlCell.value).not.toHaveProperty('hyperlink')
    const pageFetch = findRow(all, '安定キー', 'https://example.com/|page_fetch')
    expect(pageFetch.getCell(columnNumber(all, 'ページ名')).value).toBe("'=HYPERLINK(\"https://evil.example\")")
    const title = findRow(all, '安定キー', 'https://example.com/|title')
    const problem = String(title.getCell(columnNumber(all, '問題')).value)
    expect(problem.length).toBeLessThanOrEqual(REPORT_MAX_CELL_CHARACTERS)
    expect(problem.endsWith(REPORT_TRUNCATION_MARKER)).toBe(true)
  })

  it.each(['off', 'manual', 'api'] as const)('%sモードを機械結果と独立して出力する', async (mode) => {
    const result = makeRun(mode)
    const rows = buildExcelReportRows(result)
    const aiRows = rows.filter(row => row.resultType.startsWith('AI判定'))
    expect(aiRows.length).toBe(mode === 'api' ? 2 : 0)
    expect(rows.filter(row => row.resultType.startsWith('機械検査')).length).toBeGreaterThan(0)
    expect(result.summary).toEqual({ ng: 1, needsReview: 1, unchecked: 0, excluded: 1, ok: 3 })
  })

  it('MANUAL取り込み済み結果をAPIと同じ共通列へ出力する', () => {
    const result = makeRun('api')
    const apiOutput = result.ai!.apiResult!.output
    result.ai = {
      ...result.ai!,
      mode: 'manual',
      status: 'completed',
      apiResult: undefined,
      manualResult: {
        output: { ...apiOutput, judge: { mode: 'manual' } },
        importedAt: '2026-10-23T00:00:55.000Z',
        outputHash: 'e'.repeat(64),
      },
    }
    const rows = buildExcelReportRows(result).filter(row => row.resultType === 'AI判定（MANUAL）')
    expect(rows).toHaveLength(2)
    expect(rows.map(row => row.displayVerdict)).toEqual(['判定不可', 'OK'])
    expect(rows.every(row => row.verdictClass !== 'ng')).toBe(true)
  })

  it('AI情報がない旧履歴JSONも出力でき、AI OFFを未確認へ加えない', async () => {
    const legacy = makeRun('off')
    delete legacy.ai
    delete (legacy.summary as { excluded?: number }).excluded
    delete (legacy.aiUsage as Partial<RunResult['aiUsage']>).cachedInputTokens
    delete (legacy.aiUsage as Partial<RunResult['aiUsage']>).apiFailureCount
    const workbook = await loadReport(makeProject(), legacy)
    expect(findSummaryValue(workbook.getWorksheet(REPORT_SHEET_NAMES.summary)!, 'AI判定', 'モード')).toBe('OFF')
    expect(columnValues(workbook.getWorksheet(REPORT_SHEET_NAMES.all)!, '結果種別').some(value => String(value).startsWith('AI判定'))).toBe(false)
  })

  it('実行中runを拒否する', async () => {
    const result = makeRun('off')
    result.status = 'checking'
    await expect(buildExcelReport(makeProject(), result)).rejects.toBeInstanceOf(ExcelReportNotReadyError)
  })

  it('run単位で保存・再生成し、原本Excelとresult.jsonを変更しない', async () => {
    const { projectStore, runStore, project, result, inputPath } = await persistedFixture()
    await expect(runStore.readReport(project.projectId, result.runId)).rejects.toBeInstanceOf(RunReportNotFoundError)
    const beforeInput = await readFile(inputPath)
    const resultPath = join(runStore.runDir(project.projectId, result.runId), 'result.json')
    const beforeResult = await readFile(resultPath)

    const first = await generateExcelReport(project.projectId, result.runId, { projectStore, runStore })
    expect(first.fileName).toBe(`web-check-report-${result.runId}.xlsx`)
    const firstBytes = await runStore.readReport(project.projectId, result.runId)
    const firstWorkbook = new ExcelJS.Workbook()
    await firstWorkbook.xlsx.load(firstBytes as unknown as ExcelJS.Buffer)
    expect(firstWorkbook.worksheets).toHaveLength(3)

    await generateExcelReport(project.projectId, result.runId, { projectStore, runStore })
    expect(await readFile(inputPath)).toEqual(beforeInput)
    expect(await readFile(resultPath)).toEqual(beforeResult)
  })

  it('生成失敗時に既存report.xlsxを保護し、他案件のrunを拒否する', async () => {
    const { projectStore, runStore, project, result } = await persistedFixture()
    await generateExcelReport(project.projectId, result.runId, { projectStore, runStore })
    const before = await runStore.readReport(project.projectId, result.runId)
    await expect(generateExcelReport(project.projectId, result.runId, {
      projectStore,
      runStore,
      builder: async () => { throw new Error('fixture generation failure') },
    })).rejects.toThrow('fixture generation failure')
    expect(await runStore.readReport(project.projectId, result.runId)).toEqual(before)

    const other = await projectStore.create('別案件', defaultProjectSettings())
    await expect(generateExcelReport(other.projectId, result.runId, { projectStore, runStore })).rejects.toBeInstanceOf(RunNotFoundError)
  })
})

async function loadReport(project: Project, result: RunResult): Promise<ExcelJS.Workbook> {
  const bytes = await buildExcelReport(project, result)
  const workbook = new ExcelJS.Workbook()
  await workbook.xlsx.load(bytes as unknown as ExcelJS.Buffer)
  return workbook
}

async function persistedFixture() {
  const dataDir = await mkdtemp(join(process.cwd(), '.web-check-report-'))
  temporaryDirectories.push(dataDir)
  const projectStore = new ProjectStore(dataDir)
  const project = await projectStore.create('テスト案件', defaultProjectSettings())
  const inputPath = projectStore.excelPath(project.projectId)
  await writeFile(inputPath, Buffer.from('original-excel-bytes'))
  const runStore = new RunStore(projectStore.projectsDir)
  const result = makeRun('api', project.projectId)
  await runStore.create(project.projectId, result.runId, result.input, result)
  return { projectStore, runStore, project, result, inputPath }
}

function makeProject(): Project {
  return {
    schemaVersion: 1,
    projectId: '11111111-1111-4111-8111-111111111111',
    name: 'テスト案件',
    createdAt: '2026-10-23T00:00:00.000Z',
    updatedAt: '2026-10-23T00:00:00.000Z',
    archivedAt: null,
    excelFileName: 'input.xlsx',
    settings: defaultProjectSettings(),
  }
}

function makeRun(mode: 'off' | 'manual' | 'api', projectId = makeProject().projectId): RunResult {
  const runId = randomUUID()
  const pageUrl = 'https://example.com/'
  const findings: RunResult['pages'][number]['findings'] = [
    { key: `${pageUrl}|page_fetch`, item: 'page_fetch', verdict: 'ok', detailStatus: 'fetched', url: pageUrl, pageNames: ['=HYPERLINK("https://evil.example")'], sourceRows: [2], actual: { status: 200 }, message: 'ページを取得しました。', evidence: ['HTTP 200'] },
    { key: `${pageUrl}|title`, item: 'title', verdict: 'ng', detailStatus: 'mismatch', url: pageUrl, pageNames: ['トップ'], sourceRows: [2], expected: '犬…猫', actual: ['犬...猫'], message: 'x'.repeat(40_000), evidence: ['描画後DOMのtitle要素数: 1'] },
    { key: `${pageUrl}|description`, item: 'description', verdict: 'needs_review', detailStatus: 'blank_expectation', url: pageUrl, pageNames: ['トップ'], sourceRows: [2], expected: [], actual: ['説明'], message: '期待値が空欄です。', evidence: [] },
    { key: `${pageUrl}|google_tags`, item: 'google_tags', verdict: 'ok', detailStatus: 'checked', url: pageUrl, pageNames: ['トップ'], sourceRows: [2], message: 'Googleタグを確認しました。', evidence: [] },
    { key: `${pageUrl}|links`, item: 'links', verdict: 'ok', detailStatus: 'checked', url: pageUrl, pageNames: ['トップ'], sourceRows: [2], actual: { total: 2 }, message: 'リンク2件を検査しました。', evidence: [] },
    { key: `${pageUrl}|images`, item: 'images', verdict: 'excluded', detailStatus: 'excluded', url: pageUrl, pageNames: ['トップ'], sourceRows: [2], actual: { total: 1 }, message: '画像1件を検査しました。', evidence: [] },
  ]
  const result: RunResult = {
    schemaVersion: 1,
    runId,
    projectId,
    status: 'completed',
    createdAt: '2026-10-23T00:00:00.000Z',
    startedAt: '2026-10-23T00:00:01.000Z',
    finishedAt: '2026-10-23T00:01:00.000Z',
    updatedAt: '2026-10-23T00:01:00.000Z',
    configSnapshot: { pageConcurrency: 3, navigationTimeoutMs: 30_000, retryCount: 2, maxRedirects: 5, maxResponseBytes: 5_000_000, linkTimeoutMs: 10_000, imageTimeoutMsPerDevice: 60_000, imageScrollWaitMs: 2_000, authMode: 'none', allowedPrivateHosts: [], aiMode: mode, viewports: { desktop: { width: 1366, height: 768 }, mobile: { width: 375, height: 667 } } },
    input: {
      schemaVersion: 1,
      sourceFileName: 'input.xlsx',
      sheetName: '納品前のチェック',
      tagSheetName: 'Googleタグ',
      canStart: true,
      totalDataRows: 3,
      blankRows: 1,
      hiddenExcludedRows: 0,
      validRows: 2,
      uniqueUrlCount: 1,
      pageRows: [{ sourceRow: 2, pageName: 'トップ', displayName: 'トップ', url: pageUrl, normalizedUrl: pageUrl, expectedTitle: '犬…猫', expectedDescription: null, titleState: 'value', descriptionState: 'blank' }],
      invalidRows: [{ code: 'invalid_url', severity: 'warning', sheetName: '納品前のチェック', row: 3, column: 'B', cell: 'B3', message: 'URLが不正です。' }],
      headerIssues: [], formulaIssues: [], mergeIssues: [], tagIssues: [],
      duplicateGroups: [{ normalizedUrl: pageUrl, sourceRows: [2, 4], pageNames: ['トップ', 'トップ2'], titleExpectation: { state: 'conflict', values: ['A', 'B'] }, descriptionExpectation: { state: 'unique', values: ['C'] } }],
      expectedGoogleTags: [],
    },
    summary: { ng: 1, needsReview: 1, unchecked: 0, excluded: 1, ok: 3 },
    pages: [{ normalizedUrl: pageUrl, requestedUrl: pageUrl, finalUrl: pageUrl, pageNames: ['=HYPERLINK("https://evil.example")'], sourceRows: [2], startedAt: '2026-10-23T00:00:02.000Z', finishedAt: '2026-10-23T00:00:30.000Z', attempts: 1, httpStatus: 200, findings }],
    links: [
      { key: 'link-ng', pageUrl, href: '/missing', resolvedUrl: 'https://example.com/missing', finalUrl: 'https://example.com/missing', kind: 'http', verdict: 'ng', status: 404, contentType: 'text/html', redirectCount: 0, isImageLink: false, message: 'HTTP 404のためリンク切れです。', evidence: ['HTTP 404'] },
      { key: 'dangerous-link', pageUrl, href: 'javascript:alert(1)', kind: 'non_http', verdict: 'needs_review', redirectCount: 0, isImageLink: false, message: '@要確認', evidence: ['SUM(A1:A2)'] },
    ],
    images: [{ key: 'image-mobile', pageUrl, device: 'mobile', imageUrl: 'https://example.com/image.jpg', sourceKind: 'img', location: '.sidebar img', verdict: 'excluded', message: 'レスポンシブCSSにより非表示です。', evidence: ['display:none'], exclusion: { reason: 'responsive', hiddenBy: 'aside.sidebar', cssSelector: '.sidebar', mediaCondition: '(max-width: 1023px)' } }],
    googleTagDetections: [{ key: 'tag-1', pageUrl, id: 'GT-TEST', tagType: 'google_tag', detectionMethod: 'html_direct', installationMethod: 'direct', evidence: ['head内'], verdict: 'ok', verdictReason: '期待タグを検出しました。', relatedDetectionKeys: [], location: 'head', occurrences: 1 }],
    aiUsage: { enabled: mode !== 'off', inputTokens: mode === 'api' ? 100 : 0, cachedInputTokens: 0, outputTokens: mode === 'api' ? 20 : 0, estimatedCostUsd: mode === 'api' ? 0.00002 : 0, costLimitUsd: 1, stoppedByCostLimit: false, apiFailureCount: mode === 'api' ? 1 : 0 },
    ai: { mode, status: mode === 'off' ? 'disabled' : mode === 'manual' ? 'awaiting_manual' : 'completed', contractVersion: '1.1.0', promptVersion: '1.2.0' },
  }
  if (mode === 'api') {
    const inputBundle = {
      schemaVersion: 1 as const, kind: 'web-check-ai-input' as const, contractVersion: '1.1.0', promptVersion: '1.2.0', bundleId: randomUUID(), projectId, runId, generatedAt: '2026-10-23T00:00:40.000Z', contentTreatment: 'untrusted_data' as const,
      items: [
        aiItem(1, 'ai-match', pageUrl, '案内', 'https://example.com/guide'),
        aiItem(2, 'ai-undetermined', pageUrl, '詳しくはこちら', 'https://example.com/unknown'),
      ],
      integrity: { algorithm: 'HMAC-SHA256' as const, payloadHash: 'a'.repeat(64), signature: 'b'.repeat(64) },
    }
    const output = {
      schemaVersion: 1 as const, kind: 'web-check-ai-output' as const, contractVersion: '1.1.0', promptVersion: '1.2.0', projectId, runId, inputBundleId: inputBundle.bundleId, inputPayloadHash: inputBundle.integrity.payloadHash,
      judge: { mode: 'api' as const, model: 'gpt-6-luna' },
      judgments: [
        { itemId: 'ai-match', inputHash: 'c'.repeat(64), verdict: 'match' as const, reason: 'リンク文言とtitleが対応しています。' },
        { itemId: 'ai-undetermined', inputHash: 'd'.repeat(64), verdict: 'undetermined' as const, reason: '本文がなく判断できません。', errorCode: 'INSUFFICIENT_CONTENT' },
      ],
    }
    result.ai = { ...result.ai!, model: 'gpt-6-luna', inputBundle, apiResult: { output, completedAt: '2026-10-23T00:00:50.000Z', failedCount: 1 } }
  }
  return result
}

function aiItem(sequence: number, itemId: string, pageUrl: string, linkText: string, targetUrl: string) {
  return {
    sequence, itemId, inputHash: (itemId === 'ai-match' ? 'c' : 'd').repeat(64),
    source: { pageUrl, linkText, beforeText: '前の文章', afterText: '後の文章' },
    sourceReferences: [{ linkResultKey: 'link-ng', pageUrl }],
    target: { normalizedUrl: targetUrl, finalUrl: targetUrl, title: itemId === 'ai-match' ? '案内' : undefined, headings: [], bodyExcerpt: '', fetchStatus: 'available' as const },
    masking: { ruleVersion: '1', maskedCount: 0, maskedCategories: [], notice: '自動マスキングは完全ではありません。' },
  }
}

function findSummaryValue(sheet: ExcelJS.Worksheet, section: string, item: string): ExcelJS.CellValue {
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber)
    if (row.getCell(1).value === section && row.getCell(2).value === item) return row.getCell(3).value
  }
  throw new Error(`${section}/${item} not found`)
}

function columnNumber(sheet: ExcelJS.Worksheet, header: string): number {
  for (let column = 1; column <= sheet.columnCount; column += 1) {
    if (sheet.getCell(1, column).value === header) return column
  }
  throw new Error(`Unknown header: ${header}`)
}

function columnValues(sheet: ExcelJS.Worksheet, header: string): ExcelJS.CellValue[] {
  const column = columnNumber(sheet, header)
  return Array.from({ length: Math.max(0, sheet.rowCount - 1) }, (_, index) => sheet.getCell(index + 2, column).value)
}

function findRow(sheet: ExcelJS.Worksheet, header: string, value: string): ExcelJS.Row {
  const column = columnNumber(sheet, header)
  for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
    if (sheet.getCell(rowNumber, column).value === value) return sheet.getRow(rowNumber)
  }
  throw new Error(`${header}=${value} not found`)
}
