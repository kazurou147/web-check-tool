import { describe, expect, it, vi } from 'vitest'
import { runAiApiJudgment, type AiApiTransport } from '~/server/services/ai-api'
import { findAiPriceProfile } from '~/shared/config/ai-pricing'
import { liveSiteAiQualityExpected, liveSiteAiQualityInput } from './fixtures/live-site-ai-quality'

const profile = findAiPriceProfile('gpt-6-luna-standard-2026-10-22')!

describe('実サイト複製AI品質fixture', () => {
  it('実データ10件、不一致3件、情報不足2件で構成される', () => {
    expect(liveSiteAiQualityInput.items).toHaveLength(15)
    expect(countOrigins()).toEqual({
      copied_live_data: 10,
      modified_mismatch: 3,
      modified_insufficient: 2,
    })
    expect(countVerdicts()).toEqual({ match: 10, possible_mismatch: 3, undetermined: 2 })
    expect(liveSiteAiQualityInput.items.slice(0, 10).every(item => item.source.pageUrl.startsWith('https://inu-jinsei.jp/'))).toBe(true)
    const anchorItem = liveSiteAiQualityInput.items.find(item => item.source.isSamePageAnchor)
    expect(anchorItem).toMatchObject({
      source: { linkText: 'お問い合わせ', urlFragment: 'お問い合わせ', isSamePageAnchor: true },
      target: {
        anchor: {
          fragment: 'お問い合わせ',
          found: true,
          targetId: 'お問い合わせ',
          heading: { level: 2, text: 'お問い合わせ' },
        },
      },
    })
  })

  it('正解ラベルをAPI入力へ含めず、2バッチの3判定を共通形式で処理する', async () => {
    const expected = new Map(liveSiteAiQualityExpected.map(item => [item.itemId, item]))
    const transport = vi.fn<AiApiTransport>(async request => {
      const payload = JSON.parse(request.input) as { items: typeof liveSiteAiQualityInput.items }
      expect(request.input).not.toContain('expectedVerdict')
      expect(request.input).not.toContain('requiredReasonTerms')
      if (payload.items.some(item => item.source.isSamePageAnchor)) {
        expect(request.input).toContain('"urlFragment":"お問い合わせ"')
        expect(request.input).toContain('"anchor":{"fragment":"お問い合わせ","found":true')
      }
      return {
        status: 'completed',
        outputText: JSON.stringify({
          judgments: payload.items.map(item => {
            const expectation = expected.get(item.itemId)!
            return {
              itemId: item.itemId,
              inputHash: item.inputHash,
              verdict: expectation.expectedVerdict,
              reason: `${expectation.requiredReasonTerms.join(' と ')}を入力データで比較したモック判定です。`,
            }
          }),
        }),
        usage: { inputTokens: 1_000, cachedInputTokens: 0, outputTokens: 300 },
      }
    })

    const result = await runAiApiJudgment({
      input: liveSiteAiQualityInput,
      model: 'gpt-6-luna',
      priceProfile: profile,
      costLimitUsd: 0.10,
      transport,
    })

    expect(transport).toHaveBeenCalledTimes(2)
    expect(result.failedCount).toBe(0)
    expect(result.output.judgments).toHaveLength(15)
    for (const judgment of result.output.judgments) {
      expect(judgment.verdict).toBe(expected.get(judgment.itemId)?.expectedVerdict)
    }
  })

  it('不一致ケースは双方の主題、情報不足ケースは不足状態を保持する', () => {
    const mismatchItems = liveSiteAiQualityExpected.filter(item => item.origin === 'modified_mismatch')
    const insufficientItems = liveSiteAiQualityExpected.filter(item => item.origin === 'modified_insufficient')
    expect(mismatchItems.every(item => item.expectedVerdict === 'possible_mismatch' && item.requiredReasonTerms.length >= 2)).toBe(true)
    expect(insufficientItems.every(item => item.expectedVerdict === 'undetermined')).toBe(true)
    expect(liveSiteAiQualityInput.items.at(-2)?.target.fetchStatus).toBe('fetch_failed')
    expect(liveSiteAiQualityInput.items.at(-1)?.target).toMatchObject({ title: 'ページ', headings: [], bodyExcerpt: '' })
  })
})

function countOrigins(): Record<string, number> {
  return liveSiteAiQualityExpected.reduce<Record<string, number>>((counts, item) => {
    counts[item.origin] = (counts[item.origin] ?? 0) + 1
    return counts
  }, {})
}

function countVerdicts(): Record<string, number> {
  return liveSiteAiQualityExpected.reduce<Record<string, number>>((counts, item) => {
    counts[item.expectedVerdict] = (counts[item.expectedVerdict] ?? 0) + 1
    return counts
  }, {})
}
