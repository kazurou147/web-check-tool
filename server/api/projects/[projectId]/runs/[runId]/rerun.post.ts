import { requireApplicationRuntime, RuntimeUnavailableError } from '~/server/services/app-runtime'
import { toApiError } from '~/server/services/api-errors'
import { RunBusyError, RunInputError, useRunCoordinator } from '~/server/services/run-engine'
import { readValidatedBody, requireProjectId, requireRunId } from '~/server/services/request'
import { RunNotFoundError } from '~/server/services/run-store'
import { rerunRequestSchema } from '~/server/services/validation'

export default defineEventHandler(async (event) => {
  const projectId = requireProjectId(event)
  const runId = requireRunId(event)
  try {
    const request = await readValidatedBody(event, rerunRequestSchema)
    await requireApplicationRuntime()
    const result = await useRunCoordinator().rerun(projectId, runId, request)
    setResponseStatus(event, 202)
    return { runId: result.runId, status: result.status, rerunOfRunId: runId }
  } catch (error) {
    if (error instanceof RunBusyError || error instanceof RunInputError) {
      throw createError({ statusCode: 409, statusMessage: error.message })
    }
    if (error instanceof RunNotFoundError) {
      throw createError({ statusCode: 404, statusMessage: '指定された案件の検査結果が見つかりません' })
    }
    if (error instanceof RuntimeUnavailableError) {
      throw createError({ statusCode: 503, statusMessage: error.message })
    }
    return toApiError(error)
  }
})
