import { loadOrCreateAiSigningKey } from '~/server/services/ai-input'
import { AI_INPUT_DOWNLOAD_MAX_BYTES, AiManualError, getVerifiedManualInput } from '~/server/services/ai-manual'
import { requireProjectId, requireRunId } from '~/server/services/request'
import { RunNotFoundError } from '~/server/services/run-store'
import { useRunStore } from '~/server/services/run-engine'

export default defineEventHandler(async (event) => {
  const projectId = requireProjectId(event)
  const runId = requireRunId(event)
  try {
    const store = useRunStore()
    const result = await store.get(projectId, runId)
    const bundle = getVerifiedManualInput(result, projectId, runId, await loadOrCreateAiSigningKey(store.projectsDir, process.env.APP_ENCRYPTION_KEY))
    const body = `${JSON.stringify(bundle, null, 2)}\n`
    if (Buffer.byteLength(body, 'utf8') > AI_INPUT_DOWNLOAD_MAX_BYTES) {
      throw new AiManualError('AI判定用JSONがダウンロード上限の10MBを超えています。', 413, 'AI_INPUT_TOO_LARGE')
    }
    setHeader(event, 'Content-Type', 'application/json; charset=utf-8')
    setHeader(event, 'Content-Disposition', `attachment; filename="web-check-ai-input-${runId}.json"`)
    setHeader(event, 'Cache-Control', 'no-store')
    return body
  } catch (error) {
    if (error instanceof RunNotFoundError) throw createError({ statusCode: 404, statusMessage: error.message })
    if (error instanceof AiManualError) throw createError({ statusCode: error.statusCode, statusMessage: error.message })
    throw error
  }
})
