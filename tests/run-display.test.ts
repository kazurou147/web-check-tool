import { describe, expect, it, vi } from 'vitest'
import type { Finding, ImageResult, RunResult, Verdict } from '~/shared/types/run'
import { compareText, copyGoogleNetworkUrl, highestFindingVerdict, imageVerdictCounts, isActiveRun, runProgress, sortFindings, summarizeGoogleEvidence, visibleText } from '~/shared/utils/run-display'

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

  it('判定をNG・要確認・未確認・対象外・OKの順に表示する', () => {
    const findings = (['ok', 'excluded', 'unchecked', 'ng', 'needs_review'] as Verdict[]).map((verdict, index) => ({
      key: String(index),
      verdict,
    })) as Finding[]

    expect(highestFindingVerdict(findings)).toBe('ng')
    expect(sortFindings(findings).map(item => item.verdict)).toEqual(['ng', 'needs_review', 'unchecked', 'excluded', 'ok'])
  })

  it('対象外を独立集計し、exclusionを持たない既存画像結果も表示できる', () => {
    const images = [
      { verdict: 'ok' },
      { verdict: 'ok' },
      { verdict: 'ng' },
      { verdict: 'needs_review' },
      { verdict: 'unchecked' },
      { verdict: 'excluded', exclusion: { reason: 'responsive', hiddenBy: 'aside', cssSelector: '.sidebar', mediaCondition: '(max-width: 600px)' } },
    ] as ImageResult[]

    expect(imageVerdictCounts(images)).toEqual({ ng: 1, needsReview: 1, unchecked: 1, excluded: 1, ok: 2 })
    expect(imageVerdictCounts(images.slice(0, 5))).toEqual({ ng: 1, needsReview: 1, unchecked: 1, excluded: 0, ok: 2 })
  })

  it('保存済みJSON形式の長いGoogle通信URLをイベント単位で要約し識別値を通常表示へ出さない', () => {
    const first = 'https://www.google-analytics.com/g/collect?tid=G-TEST123&en=page_view&cid=client-secret&sid=session-secret&dl=https%3A%2F%2Fexample.com%2F'
    const second = 'https://www.google.com/g/collect?tid=G-TEST123&en=page_view&cid=other-client&sid=other-session'
    const summary = summarizeGoogleEvidence([
      'head内のloaderコード',
      `Google関連通信: ${first}`,
      `Google関連通信: ${second}`,
      `Google関連通信: ${second}`,
    ], 'G-TEST123')

    expect(summary.notes).toEqual(['head内のloaderコード'])
    expect(summary.networkGroups).toHaveLength(1)
    expect(summary.networkGroups[0]).toMatchObject({
      hosts: ['www.google-analytics.com', 'www.google.com'],
      path: '/g/collect',
      detectedId: 'G-TEST123',
      eventName: 'page_view',
      occurrences: 3,
      urls: [first, second],
    })
    expect(JSON.stringify({ ...summary.networkGroups[0], urls: undefined })).not.toContain('client-secret')
  })

  it('通信URLのコピーでは省略前の完全URLを渡す', async () => {
    const longUrl = `https://www.google-analytics.com/g/collect?tid=G-TEST123&en=scroll&payload=${'x'.repeat(3_000)}`
    const writer = vi.fn(async () => undefined)

    await copyGoogleNetworkUrl(longUrl, writer)

    expect(writer).toHaveBeenCalledWith(longUrl)
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
