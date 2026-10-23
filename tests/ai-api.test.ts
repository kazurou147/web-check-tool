import { describe, expect, it, vi } from 'vitest'
import {
  AI_API_JSON_SCHEMA,
  AI_API_MAX_OUTPUT_TOKENS,
  calculateAiCost,
  estimateInputTokens,
  runAiApiJudgment,
  type AiApiTransport,
} from '~/server/services/ai-api'
import { findAiPriceProfile } from '~/shared/config/ai-pricing'
import { buildAiQualityInstructions } from '~/shared/utils/manual-ai'
import {
  manualAiQualityCodexOutput,
  manualAiQualityExpected,
  manualAiQualityInput,
} from './fixtures/manual-ai-quality'

const profile = findAiPriceProfile('gpt-6-luna-standard-2026-10-22')!

describe('Phase 5-C API判定', () => {
  it('8件をStrict Structured Outputs互換形式で判定し3種類の結果を保存する', async () => {
    const transport = vi.fn<AiApiTransport>(async request => {
      expect(request.model).toBe('gpt-6-luna')
      expect(request.instructions).toContain('他itemの判定や理由を流用してはいけません')
      const sent = JSON.parse(request.input) as { items: typeof manualAiQualityInput.items }
      const ids = new Set(sent.items.map(item => item.itemId))
      return {
        status: 'completed',
        outputText: JSON.stringify({ judgments: manualAiQualityCodexOutput.judgments.filter(item => ids.has(item.itemId)) }),
        usage: { inputTokens: 1_000, cachedInputTokens: 200, outputTokens: 400 },
      }
    })
    const result = await runAiApiJudgment({
      input: manualAiQualityInput,
      model: 'gpt-6-luna',
      priceProfile: profile,
      costLimitUsd: 1,
      transport,
    })

    expect(transport).toHaveBeenCalledTimes(1)
    expect(AI_API_JSON_SCHEMA.additionalProperties).toBe(false)
    expect(AI_API_JSON_SCHEMA.properties.judgments.items.additionalProperties).toBe(false)
    expect(result.output.judge).toEqual({ mode: 'api', model: 'gpt-6-luna' })
    const actual = new Map(result.output.judgments.map(item => [item.itemId, item.verdict]))
    for (const expected of manualAiQualityExpected) expect(actual.get(expected.itemId)).toBe(expected.expectedVerdict)
    expect(new Set(result.output.judgments.map(item => item.verdict))).toEqual(new Set(['match', 'possible_mismatch', 'undetermined']))
    expect(result.usage).toMatchObject({ inputTokens: 1_000, cachedInputTokens: 200, outputTokens: 400, apiFailureCount: 0 })
  })

  it('実使用量から通常入力・キャッシュ入力・出力料金を計算する', () => {
    expect(calculateAiCost({ inputTokens: 100, cachedInputTokens: 20, outputTokens: 30 }, profile)).toBeCloseTo(0.0000232, 10)
  })

  it('料金上限との一致は実行し、わずかな超過見込みでは呼び出さない', async () => {
    const inputText = JSON.stringify({ contentTreatment: manualAiQualityInput.contentTreatment, items: manualAiQualityInput.items })
    const predicted = calculateAiCost({
      inputTokens: estimateInputTokens(buildAiQualityInstructions(), inputText),
      cachedInputTokens: 0,
      outputTokens: AI_API_MAX_OUTPUT_TOKENS,
    }, profile)
    const success = vi.fn<AiApiTransport>(async () => ({
      status: 'completed',
      outputText: JSON.stringify({ judgments: manualAiQualityCodexOutput.judgments }),
      usage: { inputTokens: 10, cachedInputTokens: 0, outputTokens: 10 },
    }))

    const exact = await runAiApiJudgment({ input: manualAiQualityInput, model: 'gpt-6-luna', priceProfile: profile, costLimitUsd: predicted, transport: success })
    expect(success).toHaveBeenCalledOnce()
    expect(exact.usage.stoppedByCostLimit).toBe(false)

    success.mockClear()
    const below = await runAiApiJudgment({ input: manualAiQualityInput, model: 'gpt-6-luna', priceProfile: profile, costLimitUsd: predicted + 0.0000000001, transport: success })
    expect(success).toHaveBeenCalledOnce()
    expect(below.usage.stoppedByCostLimit).toBe(false)

    const blocked = vi.fn<AiApiTransport>()
    const over = await runAiApiJudgment({ input: manualAiQualityInput, model: 'gpt-6-luna', priceProfile: profile, costLimitUsd: predicted - 0.0000000001, transport: blocked })
    expect(blocked).not.toHaveBeenCalled()
    expect(over.usage.stoppedByCostLimit).toBe(true)
    expect(over.output.judgments.every(item => item.errorCode === 'AI_COST_LIMIT_REACHED')).toBe(true)
  })

  it('一時的な5xxを最大2回だけ再試行し、失敗項目をundeterminedにする', async () => {
    const transport = vi.fn<AiApiTransport>(async () => { throw Object.assign(new Error('secret raw error'), { status: 500 }) })
    const sleep = vi.fn(async () => undefined)
    const result = await runAiApiJudgment({
      input: manualAiQualityInput,
      model: 'gpt-6-luna',
      priceProfile: profile,
      costLimitUsd: 1,
      transport,
      sleep,
    })
    expect(transport).toHaveBeenCalledTimes(3)
    expect(sleep).toHaveBeenCalledTimes(2)
    expect(result.output.judgments.every(item => item.verdict === 'undetermined' && item.errorCode === 'AI_API_SERVER')).toBe(true)
    expect(JSON.stringify(result)).not.toContain('secret raw error')
  })

  it('APIキー未設定、refusal、不完全応答、スキーマ不一致を安全な失敗にする', async () => {
    const missingKey = await runAiApiJudgment({ input: manualAiQualityInput, model: 'gpt-6-luna', priceProfile: profile, costLimitUsd: 1 })
    expect(missingKey.terminalError?.code).toBe('AI_API_KEY_MISSING')

    for (const [response, code] of [
      [{ status: 'completed', outputText: '', refusal: 'refused', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } }, 'AI_API_REFUSAL'],
      [{ status: 'incomplete', outputText: '', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } }, 'AI_API_INCOMPLETE'],
      [{ status: 'completed', outputText: '{"judgments":[]}', usage: { inputTokens: 1, cachedInputTokens: 0, outputTokens: 1 } }, 'AI_API_ITEM_MISMATCH'],
    ] as const) {
      const result = await runAiApiJudgment({
        input: manualAiQualityInput,
        model: 'gpt-6-luna',
        priceProfile: profile,
        costLimitUsd: 1,
        transport: async () => response,
      })
      expect(result.output.judgments.every(item => item.errorCode === code)).toBe(true)
    }
  })

  it.each([
    [{ status: 401 }, 'AI_API_AUTHENTICATION', 1],
    [{ status: 429, code: 'insufficient_quota' }, 'AI_API_QUOTA', 1],
    [{ status: 429 }, 'AI_API_RATE_LIMIT', 3],
    [{ status: 503 }, 'AI_API_SERVER', 3],
    [{ name: 'APIConnectionTimeoutError' }, 'AI_API_TIMEOUT', 3],
    [{ name: 'APIConnectionError' }, 'AI_API_NETWORK', 3],
  ])('API障害 %o を安全なコード %s に分類する', async (shape, code, expectedCalls) => {
    const transport = vi.fn<AiApiTransport>(async () => { throw Object.assign(new Error('秘密を含み得る原文'), shape) })
    const result = await runAiApiJudgment({
      input: manualAiQualityInput,
      model: 'gpt-6-luna',
      priceProfile: profile,
      costLimitUsd: 1,
      transport,
      sleep: async () => undefined,
    })
    expect(transport).toHaveBeenCalledTimes(expectedCalls)
    expect(result.output.judgments.every(item => item.verdict === 'undetermined' && item.errorCode === code)).toBe(true)
    expect(JSON.stringify(result)).not.toContain('秘密を含み得る原文')
  })

  it('APIキーを結果JSONへ含めない', async () => {
    const apiKey = 'sk-test-do-not-leak-this-value'
    const result = await runAiApiJudgment({
      input: manualAiQualityInput,
      model: 'gpt-6-luna',
      priceProfile: profile,
      costLimitUsd: 0.000000001,
      apiKey,
    })
    expect(JSON.stringify(result)).not.toContain(apiKey)
  })
})
