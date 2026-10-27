import { toApiError } from '~/server/services/api-errors'
import { RunBusyError, RunInputError, useRunCoordinator } from '~/server/services/run-engine'
import { requireProjectId } from '~/server/services/request'
import { requireApplicationRuntime, RuntimeUnavailableError } from '~/server/services/app-runtime'

export default defineEventHandler(async (event) => {
  const projectId = requireProjectId(event)
  try {
    await requireApplicationRuntime()
    const result = await useRunCoordinator().start(projectId)
    setResponseStatus(event, 202)
    return { runId: result.runId, status: result.status }
  } catch (error) {
    if (error instanceof RunBusyError || error instanceof RunInputError) {
      throw createError({ statusCode: 409, statusMessage: error.message, ...(error instanceof RunInputError ? { data: { code: error.code } } : {}) })
    }
    if (error instanceof RuntimeUnavailableError) {
      throw createError({ statusCode: 503, statusMessage: error.message })
    }
    return toApiError(error)
  }
})
