import { toApiError } from '~/server/services/api-errors'
import { useProjectStore } from '~/server/services/project-store'
import { requireProjectId } from '~/server/services/request'
import { useRunStore } from '~/server/services/run-engine'

export default defineEventHandler(async (event) => {
  const projectId = requireProjectId(event)
  try {
    await useProjectStore().get(projectId)
    const history = await useRunStore().listDetailed(projectId)
    return { runs: history.runs, historyHealth: history.health }
  } catch (error) {
    return toApiError(error)
  }
})
