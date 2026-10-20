import { toApiError } from '~/server/services/api-errors'
import { useProjectStore } from '~/server/services/project-store'
import { requireProjectId } from '~/server/services/request'
import { useRunStore } from '~/server/services/run-engine'

export default defineEventHandler(async (event) => {
  const projectId = requireProjectId(event)
  try {
    await useProjectStore().get(projectId)
    return { runs: await useRunStore().list(projectId) }
  } catch (error) {
    return toApiError(error)
  }
})
