import { createHash } from 'node:crypto'
import type { AiJudgment, AiLinkInput } from '~/shared/types/ai'
import type { InputIssue } from '~/shared/types/excel-input'
import type {
  ComparisonCategory,
  ComparisonChange,
  ComparisonConfidence,
  ComparisonCounts,
  ComparisonIssueOutcome,
  ComparisonPresence,
  ComparisonRunDescriptor,
  ComparisonValueSnapshot,
  ConditionDifference,
  RunComparisonQuery,
  RunComparisonResponse,
} from '~/shared/types/run-comparison'
import type { RunResult, Verdict } from '~/shared/types/run'
import { maskSecretText, maskSensitiveUrl } from './ai-masking'

interface ComparableRecord {
  semanticKey: string
  fingerprint: string
  category: ComparisonCategory
  entityType: string
  item: string
  pageUrl: string
  pageNames: string[]
  sourceRows: number[]
  device?: string
  snapshot: ComparisonValueSnapshot
}

const categories: ComparisonCategory[] = ['aggregate', 'detail', 'ai', 'input']

export function compareRunResults(base: RunResult, target: RunResult, query: RunComparisonQuery): RunComparisonResponse {
  if (base.projectId !== target.projectId) throw new Error('異なる案件の検査結果は比較できません')
  if (base.runId === target.runId) throw new Error('同じ検査結果同士は比較できません')

  const partial = base.status !== 'completed' || target.status !== 'completed'
  const baseRecords = buildComparableRecords(base)
  const targetRecords = buildComparableRecords(target)
  const changes = matchRecords(baseRecords, targetRecords, partial)
  const conditionDifferences = compareConditions(base, target)
  const summary = buildSummary(changes)
  const filtered = changes.filter(change => (
    (!query.category || change.category === query.category)
    && (!query.pageUrl || [change.pageUrl, ...change.pageNames].some(value => value.toLocaleLowerCase('ja').includes(query.pageUrl!.toLocaleLowerCase('ja'))))
    && (!query.item || change.item.toLocaleLowerCase('ja').includes(query.item.toLocaleLowerCase('ja')))
  ))
  const totalPages = Math.max(1, Math.ceil(filtered.length / query.pageSize))
  const page = Math.min(query.page, totalPages)
  const offset = (page - 1) * query.pageSize

  return {
    schemaVersion: 1,
    projectId: base.projectId,
    reliability: partial ? 'partial' : 'complete',
    base: descriptor(base),
    target: descriptor(target),
    warnings: [
      ...(partial ? ['completed以外のrunを含むため、保存済み範囲だけを比較しています。片側だけにない項目は解消・削除と断定していません。'] : []),
      ...(conditionDifferences.length ? ['検査条件が異なるため、判定差に条件変更の影響が含まれる可能性があります。'] : []),
    ],
    conditionDifferences,
    summary,
    changes: filtered.slice(offset, offset + query.pageSize),
    pagination: { page, pageSize: query.pageSize, total: filtered.length, totalPages },
  }
}

function buildComparableRecords(run: RunResult): ComparableRecord[] {
  const records: ComparableRecord[] = []
  for (const page of run.pages ?? []) {
    for (const finding of page.findings ?? []) {
      records.push(record({
        semanticKey: `aggregate|${page.urlIdentity ?? canonicalUrl(page.normalizedUrl)}|${finding.item}`,
        category: 'aggregate',
        entityType: 'page_finding',
        item: finding.item,
        pageUrl: safeUrl(page.normalizedUrl),
        pageNames: finding.pageNames ?? page.pageNames,
        sourceRows: finding.sourceRows ?? page.sourceRows,
        stableKey: finding.key,
        verdict: finding.verdict,
        detailStatus: finding.detailStatus,
        message: finding.message,
        expected: finding.expected,
        actual: finding.actual,
      }))
    }
  }

  for (const link of run.links ?? []) {
    const target = link.targetUrlIdentity ?? canonicalUrl(link.resolvedUrl || link.href)
    records.push(record({
      semanticKey: `detail|link|${link.pageUrlIdentity ?? canonicalUrl(link.pageUrl)}|${link.kind}|${target}`,
      category: 'detail', entityType: 'link', item: 'リンク', pageUrl: safeUrl(link.pageUrl),
      pageNames: pageNamesFor(run, link.pageUrl, link.pageUrlIdentity), sourceRows: sourceRowsFor(run, link.pageUrl, link.pageUrlIdentity),
      stableKey: link.key, verdict: link.verdict, detailStatus: link.kind, message: link.message,
      expected: link.href,
      actual: { resolvedUrl: link.resolvedUrl, finalUrl: link.finalUrl, status: link.status, contentType: link.contentType, redirectCount: link.redirectCount },
    }))
  }

  for (const image of run.images ?? []) {
    records.push(record({
      semanticKey: `detail|image|${image.pageUrlIdentity ?? canonicalUrl(image.pageUrl)}|${image.device}|${image.sourceKind}|${image.imageUrlIdentity ?? canonicalUrl(image.imageUrl)}`,
      category: 'detail', entityType: 'image', item: '画像', pageUrl: safeUrl(image.pageUrl),
      pageNames: pageNamesFor(run, image.pageUrl, image.pageUrlIdentity), sourceRows: sourceRowsFor(run, image.pageUrl, image.pageUrlIdentity), device: image.device,
      stableKey: image.key, verdict: image.verdict, detailStatus: image.sourceKind, message: image.message,
      actual: { imageUrl: image.imageUrl, location: image.location, exclusion: image.exclusion },
      fingerprintValue: { verdict: image.verdict, detailStatus: image.sourceKind, message: image.message, imageUrl: image.imageUrl, exclusion: image.exclusion },
    }))
  }

  for (const tag of run.googleTagDetections ?? []) {
    records.push(record({
      semanticKey: `detail|tag|${tag.pageUrlIdentity ?? canonicalUrl(tag.pageUrl)}|${tag.id}|${tag.tagType}|${tag.detectionMethod}`,
      category: 'detail', entityType: 'google_tag', item: 'Googleタグ', pageUrl: safeUrl(tag.pageUrl),
      pageNames: pageNamesFor(run, tag.pageUrl, tag.pageUrlIdentity), sourceRows: sourceRowsFor(run, tag.pageUrl, tag.pageUrlIdentity),
      stableKey: tag.key, verdict: tag.verdict, detailStatus: tag.installationMethod, message: tag.verdictReason,
      expected: { id: tag.id, tagType: tag.tagType },
      actual: { detectionMethod: tag.detectionMethod, installationMethod: tag.installationMethod, sourceTagId: tag.sourceTagId, location: tag.location, occurrences: tag.occurrences },
    }))
  }

  const aiOutput = run.ai?.manualResult?.output ?? run.ai?.apiResult?.output
  const items = new Map(run.ai?.inputBundle?.items.map(item => [item.itemId, item]) ?? [])
  for (const judgment of aiOutput?.judgments ?? []) records.push(aiRecord(judgment, items.get(judgment.itemId)))

  for (const issue of uniqueIssues(run)) records.push(inputIssueRecord(issue))
  for (const duplicate of run.input.duplicateGroups ?? []) {
    const hasConflict = duplicate.titleExpectation.state === 'conflict' || duplicate.descriptionExpectation.state === 'conflict'
    records.push(record({
      semanticKey: `input|duplicate|${duplicate.urlIdentity ?? canonicalUrl(duplicate.normalizedUrl)}`,
      category: 'input', entityType: 'duplicate_url', item: '重複URL', pageUrl: safeUrl(duplicate.normalizedUrl),
      pageNames: duplicate.pageNames, sourceRows: duplicate.sourceRows,
      stableKey: `duplicate|${duplicate.normalizedUrl}`,
      verdict: hasConflict ? 'needs_review' : 'ok', detailStatus: hasConflict ? 'expectation_conflict' : 'duplicate',
      message: hasConflict ? '重複URLの期待値に矛盾があります。' : '同一URLが複数行に登録されています。',
      actual: { titleExpectation: duplicate.titleExpectation, descriptionExpectation: duplicate.descriptionExpectation },
    }))
  }
  return records
}

function record(input: Omit<ComparableRecord, 'fingerprint' | 'snapshot'> & ComparisonValueSnapshot & { fingerprintValue?: unknown }): ComparableRecord {
  const snapshot: ComparisonValueSnapshot = {
    stableKey: hashKey(input.stableKey),
    verdict: input.verdict,
    detailStatus: input.detailStatus,
    message: safeText(input.message),
    expected: safeValue(input.expected),
    actual: safeValue(input.actual),
    pageNames: input.pageNames.map(safeText),
    sourceRows: [...input.sourceRows],
  }
  return {
    semanticKey: input.semanticKey,
    fingerprint: stableStringify(input.fingerprintValue ?? {
      verdict: snapshot.verdict,
      detailStatus: snapshot.detailStatus,
      message: snapshot.message,
      expected: snapshot.expected,
      actual: snapshot.actual,
    }),
    category: input.category,
    entityType: input.entityType,
    item: input.item,
    pageUrl: safeUrl(input.pageUrl),
    pageNames: input.pageNames.map(safeText),
    sourceRows: [...input.sourceRows],
    device: input.device,
    snapshot,
  }
}

function aiRecord(judgment: AiJudgment, item: AiLinkInput | undefined): ComparableRecord {
  const verdict: Verdict = judgment.verdict === 'match' ? 'ok' : 'needs_review'
  return record({
    semanticKey: `ai|${judgment.itemId}|${judgment.inputHash}`,
    category: 'ai', entityType: 'ai_link', item: 'AIリンク内容判定',
    pageUrl: safeUrl(item?.source.pageUrl ?? ''),
    pageNames: [], sourceRows: [], stableKey: judgment.itemId, verdict,
    detailStatus: judgment.verdict, message: judgment.reason,
    expected: item ? { linkText: item.source.linkText, beforeText: item.source.beforeText, afterText: item.source.afterText } : undefined,
    actual: item ? { targetUrl: item.target.finalUrl ?? item.target.normalizedUrl, title: item.target.title, headings: item.target.headings, anchor: item.target.anchor } : undefined,
  })
}

function inputIssueRecord(issue: InputIssue): ComparableRecord {
  const location = issue.cell ?? issue.range ?? `${issue.row ?? ''}:${issue.column ?? ''}`
  return record({
    semanticKey: `input|issue|${issue.code}|${issue.sheetName}|${location}`,
    category: 'input', entityType: 'input_issue', item: issue.code, pageUrl: '', pageNames: [],
    sourceRows: issue.row ? [issue.row] : [], stableKey: `${issue.code}|${issue.sheetName}|${location}`,
    verdict: issue.severity === 'fatal' ? 'ng' : 'needs_review', detailStatus: issue.severity, message: issue.message,
    actual: { sheetName: issue.sheetName, cell: issue.cell, range: issue.range, column: issue.column },
  })
}

function uniqueIssues(run: RunResult): InputIssue[] {
  const all = [run.input.invalidRows ?? [], run.input.headerIssues ?? [], run.input.formulaIssues ?? [], run.input.mergeIssues ?? [], run.input.tagIssues ?? []].flat()
  const seen = new Set<string>()
  return all.filter(issue => {
    const key = stableStringify(issue)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function matchRecords(baseRecords: ComparableRecord[], targetRecords: ComparableRecord[], partial: boolean): ComparisonChange[] {
  const baseGroups = groupBySemanticKey(baseRecords)
  const targetGroups = groupBySemanticKey(targetRecords)
  const keys = [...new Set([...baseGroups.keys(), ...targetGroups.keys()])].sort()
  const changes: ComparisonChange[] = []
  for (const key of keys) {
    const before = [...(baseGroups.get(key) ?? [])]
    const after = [...(targetGroups.get(key) ?? [])]
    if (before.length === 1 && after.length === 1) {
      addMatched(changes, before[0]!, after[0]!, 'exact')
      continue
    }

    for (let leftIndex = before.length - 1; leftIndex >= 0; leftIndex -= 1) {
      const rightIndex = after.findIndex(candidate => candidate.fingerprint === before[leftIndex]!.fingerprint)
      if (rightIndex < 0) continue
      addMatched(changes, before[leftIndex]!, after[rightIndex]!, 'semantic')
      before.splice(leftIndex, 1)
      after.splice(rightIndex, 1)
    }
    while (before.length && after.length) addMatched(changes, before.shift()!, after.shift()!, 'uncertain')
    for (const value of before) changes.push(oneSided(value, 'before', partial))
    for (const value of after) changes.push(oneSided(value, 'after', partial))
  }
  return changes
    .filter(change => change.issueOutcome === 'ng_continued' || change.changeKinds.length > 0)
    .sort((left, right) => [left.category, left.pageUrl, left.item, left.key].join('|').localeCompare([right.category, right.pageUrl, right.item, right.key].join('|'), 'ja'))
}

function addMatched(changes: ComparisonChange[], before: ComparableRecord, after: ComparableRecord, confidence: ComparisonConfidence): void {
  const changeKinds: ComparisonChange['changeKinds'] = []
  if (before.snapshot.verdict !== after.snapshot.verdict) changeKinds.push('verdict')
  if (!same(before.snapshot.expected, after.snapshot.expected)) changeKinds.push('expected')
  if (!same(before.snapshot.actual, after.snapshot.actual)) changeKinds.push('actual')
  if (before.snapshot.message !== after.snapshot.message) changeKinds.push('reason')
  if (before.snapshot.detailStatus !== after.snapshot.detailStatus) changeKinds.push('detail_status')
  if (!same(sorted(before.snapshot.pageNames), sorted(after.snapshot.pageNames)) || !same(sortedNumbers(before.snapshot.sourceRows), sortedNumbers(after.snapshot.sourceRows))) changeKinds.push('metadata')
  changes.push({
    key: hashKey(`${before.semanticKey}|${before.snapshot.stableKey}|${after.snapshot.stableKey}`),
    category: before.category,
    entityType: before.entityType,
    item: before.item,
    pageUrl: after.pageUrl || before.pageUrl,
    pageNames: after.pageNames.length ? after.pageNames : before.pageNames,
    sourceRows: after.sourceRows.length ? after.sourceRows : before.sourceRows,
    device: after.device ?? before.device,
    presence: 'matched', confidence,
    issueOutcome: outcome(before.snapshot.verdict, after.snapshot.verdict, confidence),
    changeKinds,
    before: before.snapshot,
    after: after.snapshot,
  })
}

function oneSided(value: ComparableRecord, side: 'before' | 'after', partial: boolean): ComparisonChange {
  const presence: ComparisonPresence = partial ? 'unobserved' : side === 'before' ? 'removed' : 'added'
  return {
    key: hashKey(`${value.semanticKey}|${side}|${value.snapshot.stableKey}`),
    category: value.category, entityType: value.entityType, item: value.item, pageUrl: value.pageUrl,
    pageNames: value.pageNames, sourceRows: value.sourceRows, device: value.device,
    presence, confidence: partial ? 'uncertain' : 'semantic', issueOutcome: partial ? 'indeterminate' : 'none',
    changeKinds: ['presence'],
    ...(side === 'before' ? { before: value.snapshot } : { after: value.snapshot }),
  }
}

function outcome(before: Verdict, after: Verdict, confidence: ComparisonConfidence): ComparisonIssueOutcome {
  if (confidence === 'uncertain') return 'indeterminate'
  if (before === 'ng' && after === 'ok') return 'ng_resolved'
  if (before !== 'ng' && after === 'ng') return 'ng_introduced'
  if (before === 'ng' && after === 'ng') return 'ng_continued'
  if (before === 'ng' && after === 'unchecked') return 'became_unchecked'
  if (before === 'ng' && after === 'excluded') return 'became_excluded'
  if (before !== after) return 'verdict_changed'
  return 'none'
}

function buildSummary(changes: ComparisonChange[]): RunComparisonResponse['summary'] {
  const result = Object.fromEntries(categories.map(category => [category, emptyCounts()])) as Record<ComparisonCategory, ComparisonCounts>
  const verdictTransitions: Record<string, number> = {}
  for (const change of changes) {
    const counts = result[change.category]
    counts.changed += 1
    if (change.issueOutcome === 'ng_resolved') counts.ngResolved += 1
    if (change.issueOutcome === 'ng_introduced') counts.ngIntroduced += 1
    if (change.issueOutcome === 'ng_continued') counts.ngContinued += 1
    if (change.presence === 'added') counts.added += 1
    if (change.presence === 'removed') counts.removed += 1
    if (change.presence === 'unobserved') counts.unobserved += 1
    if (change.confidence === 'uncertain') counts.uncertain += 1
    if (change.before && change.after && change.before.verdict !== change.after.verdict) {
      const key = `${change.before.verdict}->${change.after.verdict}`
      verdictTransitions[key] = (verdictTransitions[key] ?? 0) + 1
    }
  }
  return { ...result, verdictTransitions }
}

function emptyCounts(): ComparisonCounts {
  return { changed: 0, ngResolved: 0, ngIntroduced: 0, ngContinued: 0, added: 0, removed: 0, unobserved: 0, uncertain: 0 }
}

function compareConditions(base: RunResult, target: RunResult): ConditionDifference[] {
  const entries: Array<[string, string, unknown, unknown]> = [
    ['pageConcurrency', 'ページ並列数', base.configSnapshot.pageConcurrency, target.configSnapshot.pageConcurrency],
    ['navigationTimeoutMs', 'ページ遷移タイムアウト', base.configSnapshot.navigationTimeoutMs, target.configSnapshot.navigationTimeoutMs],
    ['retryCount', '再試行回数', base.configSnapshot.retryCount, target.configSnapshot.retryCount],
    ['maxRedirects', '最大リダイレクト回数', base.configSnapshot.maxRedirects, target.configSnapshot.maxRedirects],
    ['maxResponseBytes', '最大応答サイズ', base.configSnapshot.maxResponseBytes, target.configSnapshot.maxResponseBytes],
    ['linkTimeoutMs', 'リンク検査タイムアウト', base.configSnapshot.linkTimeoutMs, target.configSnapshot.linkTimeoutMs],
    ['imageTimeoutMsPerDevice', '画像検査の端末別時間上限', base.configSnapshot.imageTimeoutMsPerDevice, target.configSnapshot.imageTimeoutMsPerDevice],
    ['imageScrollWaitMs', '画像スクロール待機', base.configSnapshot.imageScrollWaitMs, target.configSnapshot.imageScrollWaitMs],
    ['imageScrollStepViewportRatio', '画像スクロール単位', base.configSnapshot.imageScrollStepViewportRatio, target.configSnapshot.imageScrollStepViewportRatio],
    ['imageScrollMaxCount', '画像最大スクロール回数', base.configSnapshot.imageScrollMaxCount, target.configSnapshot.imageScrollMaxCount],
    ['authMode', '認証モード', base.configSnapshot.authMode, target.configSnapshot.authMode],
    ['allowedPrivateHostsCount', '許可プライベートホスト数', base.configSnapshot.allowedPrivateHosts?.length ?? 0, target.configSnapshot.allowedPrivateHosts?.length ?? 0],
    ['aiMode', 'AIモード', base.configSnapshot.aiMode, target.configSnapshot.aiMode],
    ['aiModel', 'AIモデル', base.ai?.model, target.ai?.model],
    ['aiContractVersion', 'AI契約版', base.ai?.contractVersion, target.ai?.contractVersion],
    ['aiPromptVersion', 'AIプロンプト版', base.ai?.promptVersion, target.ai?.promptVersion],
    ['aiPriceProfile', 'AI価格プロファイル', base.ai?.priceProfile, target.ai?.priceProfile],
    ['aiCostLimit', 'AI料金上限', base.aiUsage.costLimitUsd, target.aiUsage.costLimitUsd],
    ['desktopViewport', 'PC viewport', base.configSnapshot.viewports?.desktop, target.configSnapshot.viewports?.desktop],
    ['mobileViewport', 'mobile viewport', base.configSnapshot.viewports?.mobile, target.configSnapshot.viewports?.mobile],
    ['mobileEmulation', 'モバイルエミュレーション', base.configSnapshot.mobileEmulation, target.configSnapshot.mobileEmulation],
  ]
  return entries.filter(([, , before, after]) => !same(before, after)).map(([key, label, before, after]) => ({
    key, label, before: displayValue(before), after: displayValue(after),
  }))
}

function descriptor(run: RunResult): ComparisonRunDescriptor {
  return {
    runId: run.runId, rerunOfRunId: run.rerunOfRunId, status: run.status,
    createdAt: run.createdAt, startedAt: run.startedAt, finishedAt: run.finishedAt, updatedAt: run.updatedAt,
    totalPages: run.input.uniqueUrlCount ?? 0, completedPages: run.pages?.length ?? 0,
  }
}

function pageNamesFor(run: RunResult, pageUrl: string, identity?: string): string[] {
  return findPage(run, pageUrl, identity)?.pageNames ?? []
}

function sourceRowsFor(run: RunResult, pageUrl: string, identity?: string): number[] {
  return findPage(run, pageUrl, identity)?.sourceRows ?? []
}

function findPage(run: RunResult, pageUrl: string, identity?: string) {
  return (run.pages ?? []).find(page => identity && page.urlIdentity ? page.urlIdentity === identity : page.normalizedUrl === pageUrl)
}

function groupBySemanticKey(records: ComparableRecord[]): Map<string, ComparableRecord[]> {
  const result = new Map<string, ComparableRecord[]>()
  for (const record of records) result.set(record.semanticKey, [...(result.get(record.semanticKey) ?? []), record])
  return result
}

function canonicalUrl(value: string): string {
  return safeUrl(value).replace(/\/$/, '')
}

function safeUrl(value: string): string {
  return value ? maskSensitiveUrl(value).value.slice(0, 4_096) : ''
}

function safeText(value: string): string {
  return maskSecretText(value).value.slice(0, 32_767)
}

function safeValue(value: unknown, key = ''): unknown {
  if (typeof value === 'string') return /(?:url|href)$/i.test(key) || /^https?:\/\//i.test(value) ? safeUrl(value) : safeText(value)
  if (Array.isArray(value)) return value.map(item => safeValue(item, key))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([childKey, child]) => [childKey, safeValue(child, childKey)]))
  return value
}

function hashKey(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 24)
}

function same(left: unknown, right: unknown): boolean {
  return stableStringify(left) === stableStringify(right)
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value))
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue)
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, sortValue(item)]))
  }
  return value
}

function sorted(values: string[]): string[] {
  return [...values].sort((a, b) => a.localeCompare(b, 'ja'))
}

function sortedNumbers(values: number[]): number[] {
  return [...values].sort((a, b) => a - b)
}

function displayValue(value: unknown): string {
  if (value === undefined) return '旧履歴では未記録'
  if (typeof value === 'string') return safeText(value)
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return stableStringify(safeValue(value))
}
