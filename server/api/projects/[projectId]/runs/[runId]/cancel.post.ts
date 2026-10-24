import { toApiError } from '~/server/services/api-errors'
import { RunCancelConflictError, useRunCoordinator } from '~/server/services/run-engine'
import { requireProjectId, requireRunId } from '~/server/services/request'
import { RunNotFoundError } from '~/server/services/run-store'

export default defineEventHandler(async (event) => {
  const projectId = requireProjectId(event)
  const runId = requireRunId(event)
  try {
    const canceled = await useRunCoordinator().cancel(projectId, runId)
    setResponseStatus(event, canceled.status === 'canceled' ? 200 : 202)
    return {
      ...canceled,
      message: canceled.idempotent
        ? 'キャンセル要求はすでに受け付けられています。'
        : 'キャンセル要求を受け付けました。完了済みの途中結果を保存して終了します。',
    }
  } catch (error) {
    if (error instanceof RunNotFoundError) {
      throw createError({ statusCode: 404, statusMessage: error.message })
    }
    if (error instanceof RunCancelConflictError) {
      throw createError({ statusCode: 409, statusMessage: error.message })
    }
    return toApiError(error)
  }
})
