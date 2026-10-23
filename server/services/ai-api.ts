import OpenAI from 'openai'
import { z } from 'zod'
import type {
  AiInputBundle,
  AiJudgment,
  AiOutputBundle,
  AiPriceProfile,
} from '~/shared/types/ai'
import { buildAiQualityInstructions } from '~/shared/utils/manual-ai'

export const AI_API_BATCH_SIZE = 8
export const AI_API_MAX_OUTPUT_TOKENS = 4_096
export const AI_API_TIMEOUT_MS = 30_000
export const AI_API_MAX_RETRIES = 2

const judgmentSchema = z.object({
  itemId: z.string().regex(/^ai_[0-9a-f]{64}$/),
  inputHash: z.string().regex(/^[0-9a-f]{64}$/),
  verdict: z.enum(['match', 'possible_mismatch', 'undetermined']),
  reason: z.string().min(1).refine(value => Array.from(value).length <= 500),
}).strict()

const batchOutputSchema = z.object({ judgments: z.array(judgmentSchema) }).strict()

export const AI_API_JSON_SCHEMA = {
  type: 'object',
  properties: {
    judgments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          itemId: { type: 'string', pattern: '^ai_[0-9a-f]{64}$' },
          inputHash: { type: 'string', pattern: '^[0-9a-f]{64}$' },
          verdict: { type: 'string', enum: ['match', 'possible_mismatch', 'undetermined'] },
          reason: { type: 'string', minLength: 1, maxLength: 500 },
        },
        required: ['itemId', 'inputHash', 'verdict', 'reason'],
        additionalProperties: false,
      },
    },
  },
  required: ['judgments'],
  additionalProperties: false,
} as const

export interface AiApiTransportRequest {
  model: string
  instructions: string
  input: string
  maxOutputTokens: number
}

export interface AiApiTransportResponse {
  status: 'completed' | 'incomplete' | 'failed'
  outputText: string
  refusal?: string
  usage: {
    inputTokens: number
    cachedInputTokens: number
    outputTokens: number
  }
}

export type AiApiTransport = (request: AiApiTransportRequest) => Promise<AiApiTransportResponse>

export interface AiApiExecutionUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  estimatedCostUsd: number
  costLimitUsd: number
  stoppedByCostLimit: boolean
  apiFailureCount: number
}

export interface AiApiExecutionResult {
  output: AiOutputBundle
  usage: AiApiExecutionUsage
  failedCount: number
  terminalError?: { code: string; message: string }
}

export interface RunAiApiOptions {
  input: AiInputBundle
  model: string
  priceProfile: AiPriceProfile
  costLimitUsd: number
  apiKey?: string
  transport?: AiApiTransport
  sleep?: (milliseconds: number) => Promise<void>
  onProgress?: (result: AiApiExecutionResult) => Promise<void>
}

export async function runAiApiJudgment(options: RunAiApiOptions): Promise<AiApiExecutionResult> {
  const judgments: AiJudgment[] = []
  const usage: AiApiExecutionUsage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    estimatedCostUsd: 0,
    costLimitUsd: options.costLimitUsd,
    stoppedByCostLimit: false,
    apiFailureCount: 0,
  }
  const instructions = buildAiQualityInstructions()
  const sleep = options.sleep ?? (milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)))
  let retryBudgetReserve = 0
  let terminalError: AiApiExecutionResult['terminalError']
  let transport: AiApiTransport
  try {
    transport = options.transport ?? createOpenAiTransport(requireApiKey(options.apiKey))
  } catch (error) {
    const failure = classifyAiApiError(error)
    return buildFailedAiApiResult(options.input, options.model, options.costLimitUsd, failure.code, failure.message)
  }

  for (let offset = 0; offset < options.input.items.length; offset += AI_API_BATCH_SIZE) {
    const batch = options.input.items.slice(offset, offset + AI_API_BATCH_SIZE)
    const input = JSON.stringify({ contentTreatment: options.input.contentTreatment, items: batch })
    const predictedCost = calculateAiCost({
      inputTokens: estimateInputTokens(instructions, input),
      cachedInputTokens: 0,
      outputTokens: AI_API_MAX_OUTPUT_TOKENS,
    }, options.priceProfile)

    if (usage.estimatedCostUsd + retryBudgetReserve + predictedCost > options.costLimitUsd) {
      usage.stoppedByCostLimit = true
      judgments.push(...undetermined(options.input.items.slice(offset), 'AI_COST_LIMIT_REACHED', '料金上限に達する見込みのため、API判定を実行しませんでした。'))
      break
    }

    let batchCompleted = false
    for (let attempt = 0; attempt <= AI_API_MAX_RETRIES; attempt += 1) {
      try {
        const response = await transport({ model: options.model, instructions, input, maxOutputTokens: AI_API_MAX_OUTPUT_TOKENS })
        addUsage(usage, response.usage, options.priceProfile)
        if (response.refusal) throw new AiApiFailure('AI_API_REFUSAL', 'モデルが判定を拒否しました。', false, false)
        if (response.status !== 'completed') throw new AiApiFailure('AI_API_INCOMPLETE', 'API応答が完了しませんでした。', false, false)
        const parsed = parseBatchOutput(response.outputText, batch)
        judgments.push(...parsed)
        batchCompleted = true
        break
      } catch (error) {
        const failure = classifyAiApiError(error)
        if (failure.retryable && attempt < AI_API_MAX_RETRIES) {
          retryBudgetReserve += predictedCost
          if (usage.estimatedCostUsd + retryBudgetReserve + predictedCost > options.costLimitUsd) {
            usage.stoppedByCostLimit = true
            judgments.push(...undetermined(options.input.items.slice(offset), 'AI_COST_LIMIT_REACHED', '再試行を含む概算が料金上限を超えるため、API判定を停止しました。'))
            terminalError = { code: 'AI_COST_LIMIT_REACHED', message: '料金上限に達したためAPI判定を停止しました。' }
            batchCompleted = true
            break
          }
          await sleep(attempt === 0 ? 500 : 1_500)
          continue
        }

        usage.apiFailureCount += batch.length
        judgments.push(...undetermined(batch, failure.code, failure.message))
        batchCompleted = true
        if (failure.haltAll) {
          const remaining = options.input.items.slice(offset + batch.length)
          usage.apiFailureCount += remaining.length
          judgments.push(...undetermined(remaining, failure.code, failure.message))
          terminalError = { code: failure.code, message: failure.message }
        }
        break
      }
    }

    const progress = buildResult(options, judgments, usage, terminalError)
    await options.onProgress?.(progress)
    if (!batchCompleted || terminalError || usage.stoppedByCostLimit) break
  }

  return buildResult(options, judgments, usage, terminalError)
}

export function buildFailedAiApiResult(
  input: AiInputBundle,
  model: string,
  costLimitUsd: number,
  code: string,
  message: string,
): AiApiExecutionResult {
  const judgments = undetermined(input.items, code, message)
  return {
    output: {
      schemaVersion: 1,
      kind: 'web-check-ai-output',
      contractVersion: input.contractVersion,
      promptVersion: input.promptVersion,
      projectId: input.projectId,
      runId: input.runId,
      inputBundleId: input.bundleId,
      inputPayloadHash: input.integrity.payloadHash,
      judge: { mode: 'api', model },
      judgments,
    },
    usage: {
      inputTokens: 0,
      cachedInputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: 0,
      costLimitUsd,
      stoppedByCostLimit: code === 'AI_COST_LIMIT_REACHED',
      apiFailureCount: judgments.length,
    },
    failedCount: judgments.length,
    terminalError: { code, message },
  }
}

export function createOpenAiTransport(apiKey: string): AiApiTransport {
  const client = new OpenAI({ apiKey, timeout: AI_API_TIMEOUT_MS, maxRetries: 0 })
  return async request => {
    const response = await client.responses.create({
      model: request.model,
      store: false,
      reasoning: { effort: 'low' },
      instructions: request.instructions,
      input: request.input,
      max_output_tokens: request.maxOutputTokens,
      tools: [],
      tool_choice: 'none',
      text: {
        format: {
          type: 'json_schema',
          name: 'link_content_judgments',
          strict: true,
          schema: AI_API_JSON_SCHEMA,
        },
      },
    })
    const refusal = response.output
      .flatMap(item => item.type === 'message' ? item.content : [])
      .find(content => content.type === 'refusal')
    return {
      status: response.status === 'completed' ? 'completed' : response.status === 'failed' ? 'failed' : 'incomplete',
      outputText: response.output_text,
      refusal: refusal?.type === 'refusal' ? refusal.refusal : undefined,
      usage: {
        inputTokens: response.usage?.input_tokens ?? 0,
        cachedInputTokens: response.usage?.input_tokens_details.cached_tokens ?? 0,
        outputTokens: response.usage?.output_tokens ?? 0,
      },
    }
  }
}

export function calculateAiCost(
  usage: { inputTokens: number; cachedInputTokens: number; outputTokens: number },
  profile: AiPriceProfile,
): number {
  const cached = Math.min(usage.inputTokens, Math.max(0, usage.cachedInputTokens))
  const uncached = Math.max(0, usage.inputTokens - cached)
  return (
    uncached * profile.inputUsdPerMillionTokens
    + cached * profile.cachedInputUsdPerMillionTokens
    + Math.max(0, usage.outputTokens) * profile.outputUsdPerMillionTokens
  ) / 1_000_000
}

export function estimateInputTokens(instructions: string, input: string): number {
  return Math.ceil(Buffer.byteLength(`${instructions}\n${input}`, 'utf8') / 3)
}

function requireApiKey(value: string | undefined): string {
  if (!value?.trim()) throw new AiApiFailure('AI_API_KEY_MISSING', 'OPENAI_API_KEYが設定されていません。', false, true)
  return value
}

function parseBatchOutput(text: string, batch: AiInputBundle['items']): AiJudgment[] {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new AiApiFailure('AI_API_SCHEMA_INVALID', 'API応答JSONを検証できませんでした。', false, false)
  }
  const parsed = batchOutputSchema.safeParse(value)
  if (!parsed.success) throw new AiApiFailure('AI_API_SCHEMA_INVALID', 'API応答が指定スキーマに一致しません。', false, false)
  const expected = new Map(batch.map(item => [item.itemId, item.inputHash]))
  const seen = new Set<string>()
  for (const judgment of parsed.data.judgments) {
    if (seen.has(judgment.itemId) || expected.get(judgment.itemId) !== judgment.inputHash) {
      throw new AiApiFailure('AI_API_ITEM_MISMATCH', 'API応答の識別情報に重複または不一致があります。', false, false)
    }
    seen.add(judgment.itemId)
  }
  if (seen.size !== batch.length || batch.some(item => !seen.has(item.itemId))) {
    throw new AiApiFailure('AI_API_ITEM_MISMATCH', 'API応答に不足している判定項目があります。', false, false)
  }
  return parsed.data.judgments
}

function addUsage(usage: AiApiExecutionUsage, added: AiApiTransportResponse['usage'], profile: AiPriceProfile): void {
  usage.inputTokens += added.inputTokens
  usage.cachedInputTokens += added.cachedInputTokens
  usage.outputTokens += added.outputTokens
  usage.estimatedCostUsd += calculateAiCost(added, profile)
  usage.estimatedCostUsd = Number(usage.estimatedCostUsd.toFixed(10))
}

function buildResult(
  options: RunAiApiOptions,
  judgments: AiJudgment[],
  usage: AiApiExecutionUsage,
  terminalError?: AiApiExecutionResult['terminalError'],
): AiApiExecutionResult {
  return {
    output: {
      schemaVersion: 1,
      kind: 'web-check-ai-output',
      contractVersion: options.input.contractVersion,
      promptVersion: options.input.promptVersion,
      projectId: options.input.projectId,
      runId: options.input.runId,
      inputBundleId: options.input.bundleId,
      inputPayloadHash: options.input.integrity.payloadHash,
      judge: { mode: 'api', model: options.model },
      judgments: [...judgments],
    },
    usage: { ...usage },
    failedCount: judgments.filter(item => item.errorCode).length,
    terminalError,
  }
}

function undetermined(items: AiInputBundle['items'], errorCode: string, reason: string): AiJudgment[] {
  return items.map(item => ({ itemId: item.itemId, inputHash: item.inputHash, verdict: 'undetermined', reason, errorCode }))
}

class AiApiFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: boolean,
    readonly haltAll: boolean,
  ) {
    super(message)
  }
}

function classifyAiApiError(error: unknown): AiApiFailure {
  if (error instanceof AiApiFailure) return error
  const value = error as { status?: number; code?: string; name?: string }
  const status = value.status
  if (status === 401 || status === 403) return new AiApiFailure('AI_API_AUTHENTICATION', 'OpenAI APIの認証に失敗しました。', false, true)
  if (status === 429 && value.code === 'insufficient_quota') return new AiApiFailure('AI_API_QUOTA', 'OpenAI APIの利用枠または残高が不足しています。', false, true)
  if (status === 429) return new AiApiFailure('AI_API_RATE_LIMIT', 'OpenAI APIのレート制限に達しました。', true, false)
  if (status && status >= 500) return new AiApiFailure('AI_API_SERVER', 'OpenAI APIのサーバーエラーが発生しました。', true, false)
  if (value.name === 'APIConnectionTimeoutError' || value.name === 'AbortError') return new AiApiFailure('AI_API_TIMEOUT', 'OpenAI APIが時間内に応答しませんでした。', true, false)
  if (value.name === 'APIConnectionError' || value.name === 'TypeError') return new AiApiFailure('AI_API_NETWORK', 'OpenAI APIへの通信に失敗しました。', true, false)
  return new AiApiFailure('AI_API_REQUEST_FAILED', 'OpenAI API判定に失敗しました。', false, false)
}
