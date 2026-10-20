import { describe, expect, it } from 'vitest'
import type { Finding, RunResult, Verdict } from '~/shared/types/run'
import { compareText, highestFindingVerdict, isActiveRun, runProgress, sortFindings, visibleText } from '~/shared/utils/run-display'

describe('Phase 4 検査結果表示', () => {
  it('実行中状態だけをポーリング対象として扱う', () => {
    expect(isActiveRun('queued')).toBe(true)
    expect(isActiveRun('checking')).toBe(true)
    expect(isActiveRun('completed')).toBe(false)
    expect(isActiveRun('failed')).toBe(false)
  })

  it('保存済みページ数から進捗率を計算する', () => {
    const result = {
      input: { uniqueUrlCount: 3 },
      pages: [{}, {}],
    } as RunResult

    expect(runProgress(result)).toEqual({ completed: 2, total: 3, percent: 67 })
  })

  it('判定をNG・要確認・未確認・OKの順に表示する', () => {
    const findings = (['ok', 'unchecked', 'ng', 'needs_review'] as Verdict[]).map((verdict, index) => ({
      key: String(index),
      verdict,
    })) as Finding[]

    expect(highestFindingVerdict(findings)).toBe('ng')
    expect(sortFindings(findings).map(item => item.verdict)).toEqual(['ng', 'needs_review', 'unchecked', 'ok'])
  })

  it('省略記号とピリオド3文字をコードポイント込みで区別する', () => {
    const difference = compareText('…', '...')

    expect(difference).toMatchObject({
      matches: false,
      expectedLength: 1,
      actualLength: 3,
      firstDifferencePosition: 1,
      expectedCharacter: { display: '…', codePoint: 'U+2026' },
      actualCharacter: { display: '.', codePoint: 'U+002E' },
    })
  })

  it('半角スペース・全角スペースなどの不可視文字を可視化する', () => {
    const difference = compareText('犬 猫', '犬　猫')

    expect(difference.firstDifferencePosition).toBe(2)
    expect(difference.expectedCharacter).toMatchObject({ display: '␠', name: '半角スペース', codePoint: 'U+0020' })
    expect(difference.actualCharacter).toMatchObject({ display: '□', name: '全角スペース', codePoint: 'U+3000' })
    expect(visibleText(' \t\n　')).toBe('␠⇥↵\n□')
  })

  it('文字の追加・削除後に共通部分へ再同期する', () => {
    const addition = compareText('abc', 'abXc')
    const deletion = compareText('abXc', 'abc')

    expect(addition.actualSegments).toEqual([
      { kind: 'equal', text: 'ab' },
      { kind: 'added', text: 'X' },
      { kind: 'equal', text: 'c' },
    ])
    expect(deletion.expectedSegments).toEqual([
      { kind: 'equal', text: 'ab' },
      { kind: 'removed', text: 'X' },
      { kind: 'equal', text: 'c' },
    ])
  })

  it.each([
    ['先頭', 'abc', 'xbc', 1],
    ['途中', 'abc', 'axc', 2],
    ['末尾', 'abc', 'abd', 3],
  ])('%sの不一致位置を1文字目始まりで返す', (_label, expected, actual, position) => {
    expect(compareText(expected, actual).firstDifferencePosition).toBe(position)
  })

  it('日本語と絵文字をコードポイント単位で比較する', () => {
    const difference = compareText('犬🐶猫', '犬🐱猫')

    expect(difference).toMatchObject({ expectedLength: 3, actualLength: 3, firstDifferencePosition: 2 })
    expect(difference.expectedCharacter.codePoint).toBe('U+1F436')
    expect(difference.actualCharacter.codePoint).toBe('U+1F431')
    expect(difference.actualSegments.at(-1)).toEqual({ kind: 'equal', text: '猫' })
  })

  it('完全一致では差分位置を返さない', () => {
    const difference = compareText('同じ文字列🐶', '同じ文字列🐶')

    expect(difference.matches).toBe(true)
    expect(difference.firstDifferencePosition).toBeNull()
    expect(difference.expectedSegments).toEqual([{ kind: 'equal', text: '同じ文字列🐶' }])
  })
})
