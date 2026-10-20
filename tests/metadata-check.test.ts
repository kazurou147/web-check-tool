import { describe, expect, it } from 'vitest'
import { checkMetadata } from '~/server/services/checks/metadata'
import type { DuplicateUrlGroup, InputPageRow } from '~/shared/types/excel-input'

const baseRow: InputPageRow = {
  sourceRow: 2,
  pageName: 'トップ',
  displayName: 'トップ',
  url: 'https://example.com/',
  normalizedUrl: 'https://example.com/',
  expectedTitle: 'Exact Title',
  expectedDescription: 'Exact description',
  titleState: 'value',
  descriptionState: 'value',
}

describe('title・description検査', () => {
  it('文字列を正規化せず完全一致で判定する', () => {
    const exact = checkMetadata(baseRow.normalizedUrl, [baseRow], undefined, {
      titles: ['Exact Title'], descriptions: ['Exact description'],
    })
    const whitespace = checkMetadata(baseRow.normalizedUrl, [baseRow], undefined, {
      titles: ['Exact Title '], descriptions: ['exact description'],
    })

    expect(exact.map(item => item.verdict)).toEqual(['ok', 'ok'])
    expect(whitespace.map(item => item.verdict)).toEqual(['ng', 'ng'])
  })

  it('欠落と複数をNG、期待空欄を要確認にする', () => {
    const row = { ...baseRow, expectedTitle: null, titleState: 'blank' as const }
    const blank = checkMetadata(row.normalizedUrl, [row], undefined, {
      titles: ['Actual'], descriptions: ['Exact description'],
    })
    const structure = checkMetadata(row.normalizedUrl, [row], undefined, {
      titles: [], descriptions: ['a', 'b'],
    })

    expect(blank[0]).toMatchObject({ verdict: 'needs_review', detailStatus: 'blank_expectation', actual: ['Actual'] })
    expect(structure.map(item => item.verdict)).toEqual(['ng', 'ng'])
  })

  it('重複URLの片項目矛盾だけを要確認にする', () => {
    const second = { ...baseRow, sourceRow: 3, expectedTitle: 'Other Title' }
    const group: DuplicateUrlGroup = {
      normalizedUrl: baseRow.normalizedUrl,
      sourceRows: [2, 3],
      pageNames: ['トップ', 'トップ2'],
      titleExpectation: { state: 'conflict', values: ['Exact Title', 'Other Title'] },
      descriptionExpectation: { state: 'unique', values: ['Exact description'] },
    }
    const findings = checkMetadata(baseRow.normalizedUrl, [baseRow, second], group, {
      titles: ['Exact Title'], descriptions: ['Exact description'],
    })

    expect(findings[0]).toMatchObject({ verdict: 'needs_review', detailStatus: 'conflicting_expectations' })
    expect(findings[1]).toMatchObject({ verdict: 'ok', detailStatus: 'exact_match' })
  })
})
