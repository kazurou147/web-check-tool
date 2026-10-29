import ExcelJS, { type CellValue, type Worksheet } from 'exceljs'
import type { AiJudgment, AiLinkInput } from '~/shared/types/ai'
import {
  REPORT_CORRECTION_STATUSES,
  REPORT_ALL_COLUMNS,
  REPORT_HEADER_COLOR,
  REPORT_HEADER_TEXT_COLOR,
  REPORT_ISSUE_COLUMNS,
  REPORT_MAX_CELL_CHARACTERS,
  REPORT_SHEET_NAMES,
  REPORT_TRUNCATION_MARKER,
  REPORT_VERDICT_COLORS,
  REPORT_VERDICT_ORDER,
  type ReportDetailColumn,
  type ReportDetailColumnKey,
} from '~/shared/config/excel-report'
import type { InputIssue } from '~/shared/types/excel-input'
import type { Project } from '~/shared/types/project'
import type {
  Finding,
  GoogleTagDetection,
  ImageResult,
  LinkResult,
  PageResult,
  RunResult,
  Verdict,
} from '~/shared/types/run'
import { compareText, visibleText } from '~/shared/utils/run-display'
import { manualAiCounts } from '~/shared/utils/manual-ai'
import { maskUrlForDisplay } from '~/shared/security/url-security'
import { maskSecretText, maskSensitiveUrl } from './ai-masking'
import { secureRunForPublic } from './persistence-security'
import { SECURITY_ERROR_CODES, SECURITY_LIMITS, SecurityFoundationError } from '~/shared/security/security-constants'

export class ExcelReportNotReadyError extends Error {}
export class ExcelReportLimitError extends SecurityFoundationError {}

export interface ExcelReportRow {
  url: string
  pageName: string
  sourceRows: string
  item: string
  displayVerdict: string
  problem: string
  expected: string
  actual: string
  device: string
  reference: string
  date: Date | string
  correctionStatus: string
  notes: string
  stableKey: string
  resultType: string
  detailStatus: string
  difference: string
  evidence: string
  aiModel: string
  verdictClass: Verdict
  sortKey: string
}

type ExcelReportRowInput = Partial<ExcelReportRow> & {
  page?: PageResult
  stableKey: string
  resultType: string
  item: string
  verdictClass: Verdict
  displayVerdict: string
}

export async function buildExcelReport(project: Project, result: RunResult): Promise<Buffer> {
  assertReportableRun(result)
  const reportResult = secureRunForPublic(result)
  const estimatedRows = reportResult.pages.reduce((sum, page) => sum + page.findings.length, 0)
    + reportResult.links.length
    + reportResult.images.length
    + reportResult.googleTagDetections.length
    + (reportResult.ai?.apiResult?.output.judgments.length ?? reportResult.ai?.manualResult?.output.judgments.length ?? 0)
  assertExcelReportRowLimit(estimatedRows)
  const workbook = new ExcelJS.Workbook()
  workbook.creator = 'Webサイト納品前チェックツール'
  workbook.created = new Date(reportResult.createdAt)
  workbook.modified = new Date(reportResult.updatedAt)

  buildSummarySheet(workbook, project, reportResult)
  const allRows = buildExcelReportRows(reportResult)
  buildDetailSheet(workbook, REPORT_SHEET_NAMES.issues, REPORT_ISSUE_COLUMNS, allRows.filter(row => (
    row.verdictClass === 'ng' || row.verdictClass === 'needs_review' || row.verdictClass === 'unchecked'
  )), true)
  buildDetailSheet(workbook, REPORT_SHEET_NAMES.all, REPORT_ALL_COLUMNS, allRows, false)

  return Buffer.from(await workbook.xlsx.writeBuffer())
}

export function assertExcelReportRowLimit(rowCount: number, limit = SECURITY_LIMITS.excelReportRows): void {
  if (rowCount > limit) {
    throw new ExcelReportLimitError(SECURITY_ERROR_CODES.reportTooLarge, `Excelレポートの行数が上限${limit}件を超えています。`)
  }
}

export function assertReportableRun(result: RunResult): void {
  if (['queued', 'reading_input', 'authenticating', 'checking', 'ai_checking'].includes(result.status)) {
    throw new ExcelReportNotReadyError('検査が終了してからExcelレポートを出力してください。')
  }
}

export function buildExcelReportRows(result: RunResult): ExcelReportRow[] {
  const pageByUrl = new Map<string, PageResult>()
  for (const page of result.pages) {
    pageByUrl.set(page.urlIdentity ?? page.normalizedUrl, page)
    if (!pageByUrl.has(page.normalizedUrl)) pageByUrl.set(page.normalizedUrl, page)
  }
  const rows: ExcelReportRow[] = []

  for (const page of result.pages) {
    for (const finding of page.findings) rows.push(findingRow(page, finding))
  }
  for (const tag of result.googleTagDetections) rows.push(tagRow(pageByUrl.get(tag.pageUrlIdentity ?? tag.pageUrl), tag))
  for (const link of result.links) rows.push(linkRow(pageByUrl.get(link.pageUrlIdentity ?? link.pageUrl), link))
  for (const image of result.images) rows.push(imageRow(pageByUrl.get(image.pageUrlIdentity ?? image.pageUrl), image))
  rows.push(...aiRows(result, pageByUrl))

  return rows.sort((left, right) => (
    REPORT_VERDICT_ORDER[left.verdictClass] - REPORT_VERDICT_ORDER[right.verdictClass]
    || left.sortKey.localeCompare(right.sortKey, 'ja')
    || left.stableKey.localeCompare(right.stableKey)
  ))
}

export function safeExcelText(value: unknown): string {
  const text = toText(value)
  const protectedText = /^[\u0000-\u0020\uFEFF]*[=+\-@]/.test(text) ? `'${text}` : text
  if (protectedText.length <= REPORT_MAX_CELL_CHARACTERS) return protectedText
  const limit = REPORT_MAX_CELL_CHARACTERS - REPORT_TRUNCATION_MARKER.length
  let shortened = protectedText.slice(0, limit)
  if (/[\uD800-\uDBFF]$/.test(shortened)) shortened = shortened.slice(0, -1)
  return `${shortened}${REPORT_TRUNCATION_MARKER}`
}

export function safeHttpHyperlink(value: string): string | undefined {
  try {
    const url = new URL(redactReportUrl(value))
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined
  } catch {
    return undefined
  }
}

export function redactReportUrl(value: string): string {
  if (/^tel:/iu.test(value)) return maskSensitiveUrl(value).value
  try {
    const url = new URL(maskUrlForDisplay(value).value)
    url.username = ''
    url.password = ''
    return url.href
  } catch {
    return maskSecretText(value).value
  }
}

function buildSummarySheet(workbook: ExcelJS.Workbook, project: Project, result: RunResult): void {
  const sheet = workbook.addWorksheet(REPORT_SHEET_NAMES.summary, { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = [
    { header: '区分', key: 'section', width: 25 },
    { header: '項目', key: 'item', width: 36 },
    { header: '値', key: 'value', width: 24 },
    { header: '詳細', key: 'detail', width: 85 },
  ]
  styleHeader(sheet)

  const add = (section: string, item: string, value: CellValue, detail = '') => {
    const row = sheet.addRow({ section: safeExcelText(section), item: safeExcelText(item), value, detail: safeExcelText(detail) })
    row.alignment = { vertical: 'top', wrapText: true }
    if (value instanceof Date) row.getCell(3).numFmt = 'yyyy/mm/dd hh:mm:ss'
  }

  add('案件', '案件名', safeExcelText(project.name))
  add('案件', 'projectId', project.projectId)
  add('run', 'runId', result.runId)
  add('run', '状態', runStatusLabel(result.status))
  add('run', '作成日時', new Date(result.createdAt))
  if (result.startedAt) add('run', '開始日時', new Date(result.startedAt))
  if (result.finishedAt) add('run', '終了日時', new Date(result.finishedAt))
  add('入力Excel', 'ファイル名', safeExcelText(result.input.sourceFileName))
  add('入力Excel', '総データ行', result.input.totalDataRows)
  add('入力Excel', '有効行', result.input.validRows)
  add('入力Excel', '空白行', result.input.blankRows)
  add('入力Excel', '非表示除外行', result.input.hiddenExcludedRows)
  add('入力Excel', '不正・欠落URL', result.input.invalidRows.length)
  add('入力Excel', '重複URLグループ', result.input.duplicateGroups.length)
  add('入力Excel', '期待値矛盾グループ', result.input.duplicateGroups.filter(group => (
    group.titleExpectation.state === 'conflict' || group.descriptionExpectation.state === 'conflict'
  )).length)
  add('ページ', '固有ページ数', result.input.uniqueUrlCount)
  add('ページ', '完了ページ数', result.pages.length)

  add('ページ項目判定', '集計単位', '1ページにつき6項目', 'ページ取得、title、description、Googleタグ、リンク集約、画像集約。個別リンク・画像等とは別集計です。')
  addVerdictCounts(add, 'ページ項目判定', result.pages.flatMap(page => page.findings).map(item => item.verdict))
  addDetailSummary(add, '個別リンク', result.links.map(item => item.verdict))
  addDetailSummary(add, '個別画像', result.images.map(item => item.verdict))
  addDetailSummary(add, 'Googleタグ検出詳細', result.googleTagDetections.map(item => item.verdict))

  const aiCounts = manualAiCounts(result.ai)
  add('AI判定', 'モード', result.ai?.mode?.toUpperCase() ?? 'OFF')
  add('AI判定', '状態', aiStatusLabel(result.ai?.status ?? 'disabled'))
  add('AI判定', 'モデル', result.ai?.model ?? '—')
  add('AI判定', '元リンク数', aiCounts.sourceLinkCount)
  add('AI判定', '重複排除後件数', aiCounts.targetCount)
  add('AI判定', '判定完了件数', aiCounts.completedCount)
  add('AI判定', 'match（OK）', aiCounts.ok)
  add('AI判定', 'possible_mismatch・undetermined（要確認相当）', aiCounts.needsReview)
  add('AI判定', 'undetermined（判定不可）', aiCounts.undetermined)
  add('AI使用量', '入力トークン', result.aiUsage.inputTokens)
  add('AI使用量', 'キャッシュ入力トークン', result.aiUsage.cachedInputTokens ?? 0)
  add('AI使用量', '出力トークン', result.aiUsage.outputTokens)
  add('AI使用量', '概算料金（USD）', result.aiUsage.estimatedCostUsd, '保存済み価格プロファイルによる概算で、実際の請求額を保証しません。')
  sheet.getCell(sheet.rowCount, 3).numFmt = '$0.000000'
  add('AI使用量', '料金上限（USD）', result.aiUsage.costLimitUsd)
  sheet.getCell(sheet.rowCount, 3).numFmt = '$0.00'
  add('AI使用量', '料金上限到達', result.aiUsage.stoppedByCostLimit ? 'あり' : 'なし')
  add('AI使用量', 'API失敗件数', result.aiUsage.apiFailureCount ?? 0)

  for (const duplicate of result.input.duplicateGroups) {
    add(
      '重複URL',
      duplicate.normalizedUrl,
      `元行 ${duplicate.sourceRows.join(', ')}`,
      `title: ${duplicate.titleExpectation.state} (${duplicate.titleExpectation.values.join(' / ') || '空欄'})\ndescription: ${duplicate.descriptionExpectation.state} (${duplicate.descriptionExpectation.values.join(' / ') || '空欄'})`,
    )
  }
  for (const issue of allInputIssues(result)) addInputIssue(add, issue)

  sheet.autoFilter = { from: 'A1', to: `D${Math.max(1, sheet.rowCount)}` }
  sheet.getColumn(3).alignment = { vertical: 'top', wrapText: true }
  sheet.getColumn(4).alignment = { vertical: 'top', wrapText: true }
}

function buildDetailSheet(
  workbook: ExcelJS.Workbook,
  name: string,
  columns: readonly ReportDetailColumn[],
  rows: ExcelReportRow[],
  issuesOnly: boolean,
): void {
  const sheet = workbook.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] })
  sheet.columns = columns.map(column => ({ ...column }))
  styleHeader(sheet)

  for (const reportRow of rows) {
    const values = Object.fromEntries(columns.map(column => {
      const value = reportRow[column.key as ReportDetailColumnKey]
      return [column.key, value instanceof Date ? value : safeExcelText(value)]
    }))
    const row = sheet.addRow(values)
    row.alignment = { vertical: 'top', wrapText: true }
    const urlCell = row.getCell(columnNumber(columns, 'url'))
    const hyperlink = safeHttpHyperlink(reportRow.url)
    if (hyperlink) {
      urlCell.value = { text: safeExcelText(reportRow.url), hyperlink }
      urlCell.font = { color: { argb: 'FF0563C1' }, underline: true }
    }
    row.getCell(columnNumber(columns, 'date')).numFmt = 'yyyy/mm/dd hh:mm:ss'
    row.getCell(columnNumber(columns, 'displayVerdict')).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: REPORT_VERDICT_COLORS[reportRow.verdictClass] } }
    const correctionCell = row.getCell(columnNumber(columns, 'correctionStatus'))
    correctionCell.dataValidation = {
      type: 'list',
      allowBlank: !issuesOnly && (reportRow.verdictClass === 'ok' || reportRow.verdictClass === 'excluded'),
      formulae: [`"${REPORT_CORRECTION_STATUSES.join(',')}"`],
      showErrorMessage: true,
      errorTitle: '修正状況を選択してください',
      error: REPORT_CORRECTION_STATUSES.join('、'),
    }
  }

  sheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: Math.max(1, sheet.rowCount), column: columns.length },
  }
}

function findingRow(page: PageResult, finding: Finding): ExcelReportRow {
  const difference = findingDifference(finding)
  return baseRow({
    page,
    stableKey: finding.key,
    resultType: '機械検査（ページ集約）',
    item: findingItemLabel(finding.item),
    verdictClass: finding.verdict,
    displayVerdict: verdictLabel(finding.verdict),
    detailStatus: finding.detailStatus,
    problem: finding.message,
    expected: toText(finding.expected),
    actual: toText(finding.actual),
    difference: difference.summary,
    evidence: [finding.evidence.join('\n'), difference.details ? `【詳細差分】\n${difference.details}` : ''].filter(Boolean).join('\n'),
    date: new Date(page.finishedAt),
  })
}

function tagRow(page: PageResult | undefined, tag: GoogleTagDetection): ExcelReportRow {
  return baseRow({
    page,
    url: tag.pageUrl,
    stableKey: tag.key,
    resultType: '機械検査（Googleタグ詳細）',
    item: `Googleタグ: ${tag.id}`,
    verdictClass: tag.verdict,
    displayVerdict: verdictLabel(tag.verdict),
    detailStatus: `${tag.detectionMethod} / ${tag.installationMethod}`,
    problem: tag.verdictReason,
    actual: `ID: ${tag.id}\n種別: ${tag.tagType}\n検出方法: ${tag.detectionMethod}\n設置方法: ${tag.installationMethod}\n位置: ${tag.location ?? 'unknown'}\n検出回数: ${tag.occurrences}`,
    reference: tag.sourceTagId ?? tag.pageUrl,
    evidence: [...(tag.associationEvidence ?? []), ...tag.evidence].join('\n'),
    date: page?.finishedAt ? new Date(page.finishedAt) : '',
  })
}

function linkRow(page: PageResult | undefined, link: LinkResult): ExcelReportRow {
  return baseRow({
    page,
    url: link.resolvedUrl || link.href || link.pageUrl,
    stableKey: link.key,
    resultType: '機械検査（リンク詳細）',
    item: `リンク: ${link.kind}`,
    verdictClass: link.verdict,
    displayVerdict: verdictLabel(link.verdict),
    detailStatus: link.status ? `HTTP ${link.status}` : link.kind,
    problem: link.message,
    actual: `href: ${redactReportUrl(link.href || '（空）')}\nHTTP: ${link.status ?? '—'}\n最終URL: ${link.finalUrl ? redactReportUrl(link.finalUrl) : '—'}\nContent-Type: ${link.contentType ?? '—'}\nリダイレクト: ${link.redirectCount}回`,
    reference: link.pageUrl,
    evidence: link.evidence.join('\n'),
    date: page?.finishedAt ? new Date(page.finishedAt) : '',
  })
}

function imageRow(page: PageResult | undefined, image: ImageResult): ExcelReportRow {
  return baseRow({
    page,
    url: image.imageUrl,
    stableKey: image.key,
    resultType: '機械検査（画像詳細）',
    item: `画像: ${image.sourceKind}`,
    verdictClass: image.verdict,
    displayVerdict: verdictLabel(image.verdict),
    detailStatus: image.exclusion ? 'responsive_excluded' : image.sourceKind,
    problem: image.message,
    actual: image.exclusion
      ? `出現箇所: ${image.location}\n非表示要素: ${image.exclusion.hiddenBy}\nCSSセレクター: ${image.exclusion.cssSelector}\nmedia query: ${image.exclusion.mediaCondition}`
      : `出現箇所: ${image.location}`,
    device: image.device === 'desktop' ? 'PC' : 'スマートフォン',
    reference: image.pageUrl,
    evidence: image.evidence.join('\n'),
    date: page?.finishedAt ? new Date(page.finishedAt) : '',
  })
}

function aiRows(result: RunResult, pageByUrl: Map<string, PageResult>): ExcelReportRow[] {
  const output = result.ai?.manualResult?.output ?? result.ai?.apiResult?.output
  if (!output || !result.ai?.inputBundle) return []
  const itemById = new Map(result.ai.inputBundle.items.map(item => [item.itemId, item]))
  const date = result.ai.manualResult?.importedAt ?? result.ai.apiResult?.completedAt ?? result.finishedAt ?? result.updatedAt
  return output.judgments.flatMap((judgment) => {
    const item = itemById.get(judgment.itemId)
    return item ? [aiRow(result, item, judgment, pageByUrl, new Date(date))] : []
  })
}

function aiRow(
  result: RunResult,
  item: AiLinkInput,
  judgment: AiJudgment,
  pageByUrl: Map<string, PageResult>,
  date: Date,
): ExcelReportRow {
  const sourcePages = [...new Set(item.sourceReferences.map((reference) => {
    const link = result.links.find(candidate => candidate.key === reference.linkResultKey)
    return link?.pageUrlIdentity ?? reference.pageUrl
  }))]
    .map(key => pageByUrl.get(key))
    .filter((page): page is PageResult => Boolean(page))
  const pageNames = [...new Set(sourcePages.flatMap(page => page.pageNames))]
  const sourceRows = [...new Set(sourcePages.flatMap(page => page.sourceRows))].sort((a, b) => a - b)
  const verdictClass: Verdict = judgment.verdict === 'match' ? 'ok' : 'needs_review'
  return baseRow({
    pageName: pageNames.join(' / '),
    sourceRows: sourceRows.join(', '),
    url: item.target.finalUrl || item.target.normalizedUrl,
    stableKey: item.itemId,
    resultType: `AI判定（${result.ai?.mode?.toUpperCase() ?? 'UNKNOWN'}）`,
    item: 'AIリンク内容判定',
    verdictClass,
    displayVerdict: judgment.verdict === 'undetermined' ? '判定不可' : verdictLabel(verdictClass),
    detailStatus: judgment.errorCode ? `${judgment.verdict} / ${judgment.errorCode}` : judgment.verdict,
    problem: judgment.reason,
    expected: aiSourceText(item),
    actual: aiTargetText(item),
    reference: item.sourceReferences.map(reference => `${reference.pageUrl} / ${reference.linkResultKey}`).join('\n'),
    evidence: `itemId: ${item.itemId}\ninputHash: ${item.inputHash}`,
    aiModel: result.ai?.model ?? outputModel(result) ?? '',
    date,
  })
}

function baseRow(input: ExcelReportRowInput): ExcelReportRow {
  const page = input.page
  const pageName = input.pageName ?? page?.pageNames.join(' / ') ?? ''
  const sourceRows = input.sourceRows ?? page?.sourceRows.join(', ') ?? ''
  const url = input.url ?? page?.normalizedUrl ?? ''
  return {
    url: redactReportUrl(url),
    pageName,
    sourceRows,
    item: input.item,
    displayVerdict: input.displayVerdict,
    problem: input.problem ?? '',
    expected: input.expected ?? '',
    actual: input.actual ?? '',
    device: input.device ?? '',
    reference: redactUrlsInText(input.reference ?? ''),
    date: input.date ?? '',
    correctionStatus: ['ng', 'needs_review', 'unchecked'].includes(input.verdictClass) ? '未対応' : '',
    notes: '',
    stableKey: input.stableKey,
    resultType: input.resultType,
    detailStatus: input.detailStatus ?? '',
    difference: input.difference ?? '',
    evidence: redactUrlsInText(input.evidence ?? ''),
    aiModel: input.aiModel ?? '',
    verdictClass: input.verdictClass,
    sortKey: `${String(REPORT_VERDICT_ORDER[input.verdictClass]).padStart(2, '0')}|${url}|${input.resultType}|${input.item}|${input.stableKey}`,
  }
}

function findingDifference(finding: Finding): { summary: string; details: string } {
  if ((finding.item !== 'title' && finding.item !== 'description') || typeof finding.expected !== 'string') return { summary: '', details: '' }
  if (!Array.isArray(finding.actual) || finding.actual.length !== 1 || typeof finding.actual[0] !== 'string') return { summary: '', details: '' }
  const difference = compareText(finding.expected, finding.actual[0])
  if (difference.matches) {
    return {
      summary: `期待${difference.expectedLength}文字／実測${difference.actualLength}文字\n完全一致`,
      details: `期待差分: ${formatDiffSegments(difference.expectedSegments)}\n実測差分: ${formatDiffSegments(difference.actualSegments)}`,
    }
  }
  const position = difference.firstDifferencePosition ?? 1
  const expectedChar = difference.expectedCharacter
  const actualChar = difference.actualCharacter
  const location = differenceLocation(position, difference.expectedLength, difference.actualLength)
  const invisibleDifference = expectedChar.name !== '表示文字' || actualChar.name !== '表示文字'
  const summary = [
    `期待${difference.expectedLength}文字／実測${difference.actualLength}文字`,
    `最初の相違：${position}文字目`,
    `${location}に差異あり`,
    invisibleDifference
      ? `不可視文字等：期待「${expectedChar.name}」／実測「${actualChar.name}」`
      : `相違文字：期待「${expectedChar.display}」／実測「${actualChar.display}」`,
  ].join('\n')
  const details = [
    `期待文字: ${expectedChar.display}（${expectedChar.name} / ${expectedChar.codePoint}）`,
    `実測文字: ${actualChar.display}（${actualChar.name} / ${actualChar.codePoint}）`,
    `期待差分: ${formatDiffSegments(difference.expectedSegments)}`,
    `実測差分: ${formatDiffSegments(difference.actualSegments)}`,
  ].join('\n')
  return { summary, details }
}

function differenceLocation(position: number, expectedLength: number, actualLength: number): '先頭付近' | '途中' | '末尾付近' {
  const longerLength = Math.max(expectedLength, actualLength, 1)
  const edgeSize = Math.max(3, Math.ceil(longerLength * 0.1))
  if (position <= edgeSize) return '先頭付近'
  if (position > longerLength - edgeSize) return '末尾付近'
  return '途中'
}

function formatDiffSegments(segments: ReturnType<typeof compareText>['expectedSegments']): string {
  return segments.map(segment => segment.kind === 'equal'
    ? visibleText(segment.text)
    : `${segment.kind === 'removed' ? '[-' : '[+'}${visibleText(segment.text)}${segment.kind === 'removed' ? '-]' : '+]'}`).join('')
}

function aiSourceText(item: AiLinkInput): string {
  return `リンク文言: ${item.source.linkText || '（なし）'}\n直前: ${item.source.beforeText || '（なし）'}\n直後: ${item.source.afterText || '（なし）'}\nフラグメント: ${item.source.urlFragment ?? '—'}`
}

function aiTargetText(item: AiLinkInput): string {
  const headings = item.target.headings.map(heading => `h${heading.level}: ${heading.text}`).join('\n') || '（なし）'
  const anchor = item.target.anchor
    ? `\nアンカー: ${item.target.anchor.found ? '検出' : '未検出'} / ${item.target.anchor.targetId ?? item.target.anchor.fragment}\nアンカー見出し: ${item.target.anchor.heading?.text ?? '—'}\nアンカー周辺: ${item.target.anchor.surroundingText ?? '—'}`
    : ''
  return `取得状態: ${item.target.fetchStatus}\n最終URL: ${item.target.finalUrl ? redactReportUrl(item.target.finalUrl) : '—'}\ntitle: ${item.target.title ?? '—'}\n見出し:\n${headings}\n本文冒頭:\n${item.target.bodyExcerpt || '（なし）'}${anchor}`
}

function outputModel(result: RunResult): string | undefined {
  return result.ai?.manualResult?.output.judge.model ?? result.ai?.apiResult?.output.judge.model
}

function allInputIssues(result: RunResult): InputIssue[] {
  return [
    ...result.input.headerIssues,
    ...result.input.invalidRows,
    ...result.input.formulaIssues,
    ...result.input.mergeIssues,
    ...result.input.tagIssues,
  ]
}

function addInputIssue(
  add: (section: string, item: string, value: CellValue, detail?: string) => void,
  issue: InputIssue,
): void {
  const location = issue.cell ?? issue.range ?? (issue.row ? `${issue.row}行` : '—')
  add('入力警告', `${issue.sheetName}!${location}`, issue.severity === 'fatal' ? '致命的' : '警告', redactUrlsInText(issue.message))
}

function addDetailSummary(
  add: (section: string, item: string, value: CellValue, detail?: string) => void,
  section: string,
  verdicts: Verdict[],
): void {
  add(section, '集計単位', '個別詳細1件', 'ページ項目判定とは別集計です。')
  addVerdictCounts(add, section, verdicts)
}

function addVerdictCounts(
  add: (section: string, item: string, value: CellValue, detail?: string) => void,
  section: string,
  verdicts: Verdict[],
): void {
  add(section, '総件数', verdicts.length)
  for (const verdict of ['ng', 'needs_review', 'unchecked', 'excluded', 'ok'] as const) {
    add(section, verdictLabel(verdict), verdicts.filter(value => value === verdict).length)
  }
}

function styleHeader(sheet: Worksheet): void {
  const header = sheet.getRow(1)
  header.font = { bold: true, color: { argb: REPORT_HEADER_TEXT_COLOR } }
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: REPORT_HEADER_COLOR } }
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true }
  header.height = 28
}

function columnNumber(columns: readonly ReportDetailColumn[], key: ReportDetailColumnKey): number {
  return columns.findIndex(column => column.key === key) + 1
}

function toText(value: unknown): string {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function verdictLabel(verdict: Verdict): string {
  return ({ ng: 'NG', needs_review: '要確認', unchecked: '未確認', excluded: '対象外', ok: 'OK' } as const)[verdict]
}

function findingItemLabel(item: Finding['item']): string {
  return ({ page_fetch: 'ページ取得', title: 'title', description: 'description', google_tags: 'Googleタグ（ページ集約）', links: 'リンク（ページ集約）', images: '画像（ページ集約）' } as const)[item]
}

function runStatusLabel(status: RunResult['status']): string {
  return ({ queued: '開始待ち', reading_input: 'Excel読込中', authenticating: '認証中', checking: '検査中', ai_checking: 'AI判定中', completed: '完了', failed: '失敗', canceled: 'キャンセル済み', interrupted: '中断' } as const)[status]
}

function aiStatusLabel(status: NonNullable<RunResult['ai']>['status']): string {
  return ({
    disabled: 'AI判定なし',
    preparing: '入力準備中',
    input_ready: '手動判定待ち（旧形式）',
    awaiting_manual: '手動判定待ち',
    no_targets: '判定対象なし',
    api_checking: 'API判定中',
    api_failed: 'API判定失敗',
    completed: '判定完了',
    canceled: 'キャンセル済み',
    interrupted: '異常終了による中断',
    preparation_failed: '入力準備失敗',
  } as const)[status]
}

function redactUrlsInText(value: string): string {
  return value.replace(/https?:\/\/[^\s<>"']+/gi, match => redactReportUrl(match))
}
