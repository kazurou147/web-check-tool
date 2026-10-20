import { toApiError } from '~/server/services/api-errors'
import { RunBusyError, RunInputError, useRunCoordinator } from '~/server/services/run-engine'
import { requireProjectId } from '~/server/services/request'

export default defineEventHandler(async (event) => {
  const projectId = requireProjectId(event)
  try {
    const result = await useRunCoordinator().start(projectId)
    setResponseStatus(event, 202)
    return { runId: result.runId, status: result.status }
  } catch (error) {
    if (error instanceof RunBusyError || error instanceof RunInputError) {
      throw createError({ statusCode: 409, statusMessage: error.message })
    }
    return toApiError(error)
  }
})
