import { describe, expect, it } from 'vitest'
import { aiInputBundleSchema } from '~/server/services/ai-input'
import { aiOutputBundleSchema, validateAiOutputAgainstInput } from '~/server/services/ai-manual'
import type { AiRunData } from '~/shared/types/ai'
import { buildCodexManualInstructions, manualAiQualityWarnings } from '~/shared/utils/manual-ai'
import {
  manualAiQualityCodexOutput,
  manualAiQualityExpected,
  manualAiQualityInput,
} from './fixtures/manual-ai-quality'

describe('MANUAL判定品質', () => {
  it('8件の小規模データを正常・不一致・情報不足・SNS・ナビゲーション別に個別判定する', () => {
    expect(aiInputBundleSchema.safeParse(manualAiQualityInput).success).toBe(true)
    expect(aiOutputBundleSchema.safeParse(manualAiQualityCodexOutput).success).toBe(true)
    expect(() => validateAiOutputAgainstInput(manualAiQualityCodexOutput, manualAiQualityInput)).not.toThrow()

    const actual = new Map(manualAiQualityCodexOutput.judgments.map(item => [item.itemId, item]))
    for (const expectation of manualAiQualityExpected) {
      const judgment = actual.get(expectation.itemId)
      expect(judgment, expectation.caseName).toBeDefined()
      expect(judgment!.verdict, expectation.caseName).toBe(expectation.expectedVerdict)
      for (const term of expectation.requiredReasonTerms) {
        expect(judgment!.reason, `${expectation.caseName}: ${term}`).toContain(term)
      }
    }

    expect(new Set(manualAiQualityCodexOutput.judgments.map(item => item.reason)).size).toBe(manualAiQualityExpected.length)
  })

  it('存在しない見出し・本文を判定根拠として挙げない', () => {
    const byItem = new Map(manualAiQualityCodexOutput.judgments.map(item => [item.itemId, item.reason]))
    for (const item of manualAiQualityInput.items) {
      const reason = byItem.get(item.itemId) ?? ''
      if (item.target.headings.length === 0) expect(reason).not.toMatch(/h[1-3]|見出し/)
      if (!item.target.bodyExcerpt) expect(reason).not.toContain('本文')
    }
  })

  it('Codex指示文で個別比較、保守判定、一律入力禁止、10件単位確認を要求する', () => {
    const instructions = buildCodexManualInstructions(manualAiQualityInput)
    for (const required of [
      'source.linkText、source.beforeText、source.afterText',
      'source.urlFragment',
      'target.anchor.headingとtarget.anchor.surroundingTextを優先',
      'フラグメント名だけから推測でmatchにせずundetermined',
      '他itemの判定や理由を流用してはいけません',
      'target.headingsが空なら見出しを根拠に挙げてはいけません',
      '存在しない情報を補完・想像しないでください',
      '明らかに別の主題・目的',
      '一律に埋めることは禁止',
      '全itemを個別に比較した結果としてすべて同じverdictになること自体は認めます',
      '最大10件ずつ確認',
      '入力にある全itemsを1回ずつ、sequence順に',
    ]) expect(instructions).toContain(required)

    expect(instructions).toContain(`"inputBundleId": "${manualAiQualityInput.bundleId}"`)
    expect(instructions).toContain(`"inputPayloadHash": "${manualAiQualityInput.integrity.payloadHash}"`)
  })

  it('大量入力と完全同一理由を非破壊の品質警告として検出する', () => {
    const largeInput = {
      ...manualAiQualityInput,
      items: [
        ...manualAiQualityInput.items,
        ...manualAiQualityInput.items.slice(0, 3).map((item, index) => ({ ...item, sequence: index + 8 })),
      ],
    }
    const ai: AiRunData = {
      mode: 'manual',
      status: 'completed',
      contractVersion: largeInput.contractVersion,
      promptVersion: largeInput.promptVersion,
      inputBundle: largeInput,
      manualResult: {
        importedAt: '2026-10-21T12:30:00.000Z',
        outputHash: 'a'.repeat(64),
        output: {
          ...manualAiQualityCodexOutput,
          judgments: manualAiQualityCodexOutput.judgments.map(judgment => ({
            ...judgment,
            verdict: 'match',
            reason: 'リンク元とリンク先の内容が一致しています。',
          })),
        },
      },
    }

    expect(manualAiQualityWarnings(ai).map(item => item.code)).toEqual(['large_batch', 'uniform_reason'])
    expect(manualAiQualityWarnings({ ...ai, manualResult: undefined }).map(item => item.code)).toEqual(['large_batch'])

    const individuallyReasonedAllMatch: AiRunData = {
      ...ai,
      inputBundle: manualAiQualityInput,
      manualResult: {
        ...ai.manualResult!,
        output: {
          ...manualAiQualityCodexOutput,
          judgments: manualAiQualityCodexOutput.judgments.map((judgment, index) => ({
            ...judgment,
            verdict: 'match',
            reason: `個別確認${index + 1}: item固有の入力情報に基づく理由です。`,
          })),
        },
      },
    }
    expect(manualAiQualityWarnings(individuallyReasonedAllMatch)).toEqual([])
  })
})
