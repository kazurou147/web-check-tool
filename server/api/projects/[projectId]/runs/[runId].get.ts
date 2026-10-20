import { toApiError } from '~/server/services/api-errors'
import { requireProjectId, requireRunId } from '~/server/services/request'
import { RunNotFoundError } from '~/server/services/run-store'
import { useRunStore } from '~/server/services/run-engine'

export default defineEventHandler(async (event) => {
  const projectId = requireProjectId(event)
  const runId = requireRunId(event)
  try {
    return { result: await useRunStore().get(projectId, runId) }
  } catch (error) {
    if (error instanceof RunNotFoundError) {
      throw createError({ statusCode: 404, statusMessage: error.message })
    }
    return toApiError(error)
  }
})
