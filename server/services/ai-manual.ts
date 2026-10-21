import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { AiInputBundle, AiOutputBundle } from '~/shared/types/ai'
import type { RunResult } from '~/shared/types/run'
import { loadOrCreateAiSigningKey, stableStringify, verifyAiInputBundle } from './ai-input'
import type { RunStore } from './run-store'

export const AI_INPUT_DOWNLOAD_MAX_BYTES = 10 * 1024 * 1024
export const AI_OUTPUT_UPLOAD_MAX_BYTES = 5 * 1024 * 1024
export const AI_REASON_MAX_LENGTH = 500

const reasonSchema = z.string().min(1).refine(
  value => Array.from(value).length <= AI_REASON_MAX_LENGTH,
  { message: `判定理由は${AI_REASON_MAX_LENGTH}文字以内で指定してください` },
)

export const aiOutputBundleSchema = z.object({
  schemaVersion: z.literal(1),
  kind: z.literal('web-check-ai-output'),
  contractVersion: z.string().min(1).max(100),
  promptVersion: z.string().min(1).max(100),
  projectId: z.uuid(),
  runId: z.uuid(),
  inputBundleId: z.uuid(),
  inputPayloadHash: z.string().regex(/^[0-9a-f]{64}$/),
  judge: z.object({
    mode: z.literal('manual'),
  }).strict(),
  judgments: z.array(z.object({
    itemId: z.string().regex(/^ai_[0-9a-f]{64}$/),
    inputHash: z.string().regex(/^[0-9a-f]{64}$/),
    verdict: z.enum(['match', 'possible_mismatch', 'undetermined']),
    reason: reasonSchema,
  }).strict()).max(100_000),
}).strict()

export class AiManualError extends Error {
  constructor(message: string, readonly statusCode = 400, readonly code = 'AI_MANUAL_INVALID') {
    super(message)
  }
}

export function parseAiOutputJson(text: string): AiOutputBundle {
  const byteLength = Buffer.byteLength(text, 'utf8')
  if (byteLength === 0) throw new AiManualError('空のJSONファイルは取り込めません。')
  if (byteLength > AI_OUTPUT_UPLOAD_MAX_BYTES) {
    throw new AiManualError('AI判定結果JSONは5MB以下にしてください。', 413, 'AI_OUTPUT_TOO_LARGE')
  }
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    throw new AiManualError('JSON形式が不正です。Codexの出力をJSONファイルとして保存してください。')
  }
  const parsed = aiOutputBundleSchema.safeParse(value)
  if (!parsed.success) {
    throw new AiManualError('AI判定結果JSONが指定の形式に従っていません。', 400, 'AI_OUTPUT_SCHEMA_INVALID')
  }
  return parsed.data
}

export function getVerifiedManualInput(
  result: RunResult,
  projectId: string,
  runId: string,
  signingKey: Uint8Array,
): AiInputBundle {
  if (result.projectId !== projectId || result.runId !== runId) {
    throw new AiManualError('別の案件または検査結果のデータです。', 400, 'AI_RUN_MISMATCH')
  }
  if (result.ai?.mode !== 'manual' || !result.ai.inputBundle) {
    throw new AiManualError('この検査には手動AI判定用データがありません。', 409, 'AI_INPUT_UNAVAILABLE')
  }
  let bundle: AiInputBundle
  try {
    bundle = verifyAiInputBundle(result.ai.inputBundle, signingKey)
  } catch {
    throw new AiManualError('保存済みAI入力データの署名またはハッシュを確認できません。', 409, 'AI_INPUT_INTEGRITY_FAILED')
  }
  if (bundle.projectId !== projectId || bundle.runId !== runId) {
    throw new AiManualError('保存済みAI入力データが対象の案件・検査と一致しません。', 409, 'AI_INPUT_OWNERSHIP_MISMATCH')
  }
  return bundle
}

export function validateAiOutputAgainstInput(output: AiOutputBundle, input: AiInputBundle): void {
  if (output.projectId !== input.projectId || output.runId !== input.runId) {
    throw new AiManualError('別の案件または検査結果のJSONは取り込めません。', 400, 'AI_OUTPUT_RUN_MISMATCH')
  }
  if (output.inputBundleId !== input.bundleId) {
    throw new AiManualError('AI入力バンドルIDが一致しません。', 400, 'AI_OUTPUT_BUNDLE_MISMATCH')
  }
  if (output.contractVersion !== input.contractVersion || output.promptVersion !== input.promptVersion) {
    throw new AiManualError('判定契約または指示文のバージョンが一致しません。', 400, 'AI_OUTPUT_VERSION_MISMATCH')
  }
  if (output.inputPayloadHash !== input.integrity.payloadHash) {
    throw new AiManualError('AI入力ペイロードのハッシュが一致しません。', 400, 'AI_OUTPUT_PAYLOAD_MISMATCH')
  }

  const expected = new Map(input.items.map(item => [item.itemId, item.inputHash]))
  const seen = new Set<string>()
  for (const judgment of output.judgments) {
    if (seen.has(judgment.itemId)) {
      throw new AiManualError(`重複したitemIdがあります: ${judgment.itemId}`, 400, 'AI_OUTPUT_DUPLICATE_ITEM')
    }
    seen.add(judgment.itemId)
    const expectedHash = expected.get(judgment.itemId)
    if (!expectedHash) {
      throw new AiManualError(`入力に存在しないitemIdがあります: ${judgment.itemId}`, 400, 'AI_OUTPUT_UNKNOWN_ITEM')
    }
    if (judgment.inputHash !== expectedHash) {
      throw new AiManualError(`inputHashが一致しません: ${judgment.itemId}`, 400, 'AI_OUTPUT_ITEM_HASH_MISMATCH')
    }
  }
  const missing = input.items.filter(item => !seen.has(item.itemId))
  if (missing.length) {
    throw new AiManualError(`判定結果が不足しています（${missing.length}件）。`, 400, 'AI_OUTPUT_MISSING_ITEM')
  }
}

export async function importManualAiResult(options: {
  store: RunStore
  projectId: string
  runId: string
  output: AiOutputBundle
  signingKey?: Uint8Array
  now?: () => Date
}): Promise<{ result: RunResult; idempotent: boolean }> {
  const signingKey = options.signingKey ?? await loadOrCreateAiSigningKey(options.store.projectsDir, process.env.APP_ENCRYPTION_KEY)
  const outputHash = sha256(stableStringify(options.output))
  const importedAt = (options.now ?? (() => new Date()))().toISOString()
  const updated = await options.store.updateResult(options.projectId, options.runId, (result) => {
    const input = getVerifiedManualInput(result, options.projectId, options.runId, signingKey)
    validateAiOutputAgainstInput(options.output, input)
    if (result.ai?.manualResult) {
      if (result.ai.manualResult.outputHash === outputHash) return true
      throw new AiManualError('異なるAI判定結果は、取り込み済みの結果へ上書きできません。', 409, 'AI_OUTPUT_OVERWRITE_FORBIDDEN')
    }
    result.ai!.manualResult = { output: options.output, importedAt, outputHash }
    result.ai!.status = 'completed'
    result.updatedAt = importedAt
    return false
  })
  await options.store.appendEvent(options.projectId, options.runId, {
    at: importedAt,
    type: updated.value ? 'ai_manual_import_repeated' : 'ai_manual_imported',
    outputHash,
    itemCount: options.output.judgments.length,
  })
  return { result: updated.result, idempotent: updated.value }
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}
