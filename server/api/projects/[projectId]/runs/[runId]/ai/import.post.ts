import { extname } from 'node:path'
import { loadOrCreateAiSigningKey } from '~/server/services/ai-input'
import {
  AI_OUTPUT_UPLOAD_MAX_BYTES,
  AiManualError,
  importManualAiResult,
  parseAiOutputJson,
} from '~/server/services/ai-manual'
import { requireProjectId, requireRunId } from '~/server/services/request'
import { RunNotFoundError } from '~/server/services/run-store'
import { useRunStore } from '~/server/services/run-engine'
import { secureRunForPublic } from '~/server/services/persistence-security'
import { SECURITY_LIMITS, SecurityFoundationError } from '~/shared/security/security-constants'
import { readLimitedMultipartFormData } from '~/server/services/request-body-limits'

const ACCEPTED_TYPES = new Set(['application/json', 'text/json', 'application/octet-stream'])

export default defineEventHandler(async (event) => {
  const projectId = requireProjectId(event)
  const runId = requireRunId(event)
  let parts
  try {
    parts = await readLimitedMultipartFormData(event, SECURITY_LIMITS.aiResultUploadBytes)
  } catch (error) {
    if (error instanceof SecurityFoundationError) throw createError({ statusCode: 413, statusMessage: error.message, data: { code: error.code } })
    throw error
  }
  const files = parts?.filter(part => part.name === 'file' && part.filename) ?? []
  if (files.length !== 1 || !files[0]?.filename) {
    throw createError({ statusCode: 400, statusMessage: 'AI判定結果JSONを1ファイル選択してください。' })
  }
  const file = files[0]
  const fileName = file.filename!
  if (extname(fileName).toLowerCase() !== '.json') {
    throw createError({ statusCode: 400, statusMessage: '.jsonファイルだけ取り込めます。' })
  }
  if (file.type && !ACCEPTED_TYPES.has(file.type)) {
    throw createError({ statusCode: 400, statusMessage: 'JSONファイルのMIMEタイプが不正です。' })
  }
  if (file.data.byteLength === 0 || file.data.byteLength > AI_OUTPUT_UPLOAD_MAX_BYTES) {
    throw createError({ statusCode: file.data.byteLength > AI_OUTPUT_UPLOAD_MAX_BYTES ? 413 : 400, statusMessage: 'AI判定結果JSONは5MB以下にしてください。' })
  }

  try {
    const output = parseAiOutputJson(file.data.toString('utf8'))
    const store = useRunStore()
    const imported = await importManualAiResult({
      store,
      projectId,
      runId,
      output,
      signingKey: await loadOrCreateAiSigningKey(store.projectsDir, process.env.APP_ENCRYPTION_KEY),
    })
    return {
      result: secureRunForPublic(imported.result),
      idempotent: imported.idempotent,
      message: imported.idempotent
        ? '同じAI判定結果はすでに取り込み済みです。保存内容は変更していません。'
        : 'AI判定結果を取り込みました。',
    }
  } catch (error) {
    if (error instanceof RunNotFoundError) throw createError({ statusCode: 404, statusMessage: error.message })
    if (error instanceof AiManualError) throw createError({ statusCode: error.statusCode, statusMessage: error.message })
    throw error
  }
})
