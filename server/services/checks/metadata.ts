import type { DuplicateUrlGroup, InputPageRow } from '~/shared/types/excel-input'
import type { Finding, Verdict } from '~/shared/types/run'

export interface RenderedMetadata {
  titles: string[]
  descriptions: string[]
}

export function checkMetadata(
  normalizedUrl: string,
  rows: InputPageRow[],
  duplicateGroup: DuplicateUrlGroup | undefined,
  actual: RenderedMetadata,
): Finding[] {
  return [
    checkField('title', normalizedUrl, rows, duplicateGroup, actual.titles),
    checkField('description', normalizedUrl, rows, duplicateGroup, actual.descriptions),
  ]
}

function checkField(
  field: 'title' | 'description',
  normalizedUrl: string,
  rows: InputPageRow[],
  duplicateGroup: DuplicateUrlGroup | undefined,
  actualValues: string[],
): Finding {
  const sourceRows = rows.map(row => row.sourceRow)
  const pageNames = rows.map(row => row.displayName)
  const expectedValues = rows.map(row => field === 'title' ? row.expectedTitle : row.expectedDescription)
  const states = rows.map(row => field === 'title' ? row.titleState : row.descriptionState)
  const duplicateExpectation = field === 'title'
    ? duplicateGroup?.titleExpectation
    : duplicateGroup?.descriptionExpectation
  const base: Pick<Finding, 'key' | 'item' | 'url' | 'pageNames' | 'sourceRows' | 'actual' | 'evidence'> = {
    key: `${normalizedUrl}|${field}`,
    item: field,
    url: normalizedUrl,
    pageNames,
    sourceRows,
    actual: actualValues,
    evidence: [`描画後DOMの${field}要素数: ${actualValues.length}`],
  }

  if (actualValues.length !== 1) {
    return {
      ...base,
      verdict: 'ng',
      detailStatus: actualValues.length === 0 ? 'missing' : 'duplicate',
      expected: expectedValues,
      message: actualValues.length === 0
        ? `${field}がありません。`
        : `${field}が複数あります。`,
    }
  }

  if (states.includes('formula')) {
    return {
      ...base,
      verdict: 'needs_review',
      detailStatus: 'formula_expectation',
      expected: expectedValues,
      message: `Excelの${field}期待値に数式セルが含まれるため要確認です。`,
    }
  }

  if (duplicateExpectation?.state === 'conflict') {
    return {
      ...base,
      verdict: 'needs_review',
      detailStatus: 'conflicting_expectations',
      expected: duplicateExpectation.values,
      message: `重複URLの${field}期待値が矛盾しています。`,
    }
  }

  const nonBlank = [...new Set(expectedValues.filter((value): value is string => value !== null))]
  if (expectedValues.some(value => value === null)) {
    return {
      ...base,
      verdict: 'needs_review',
      detailStatus: 'blank_expectation',
      expected: nonBlank,
      message: `Excelの${field}期待値が空欄の行を含むため要確認です。`,
    }
  }

  const expected = nonBlank[0] ?? ''
  const verdict: Verdict = actualValues[0] === expected ? 'ok' : 'ng'
  return {
    ...base,
    verdict,
    detailStatus: verdict === 'ok' ? 'exact_match' : 'mismatch',
    expected,
    message: verdict === 'ok'
      ? `${field}は期待値と完全一致しました。`
      : `${field}が期待値と完全一致しません。`,
  }
}
