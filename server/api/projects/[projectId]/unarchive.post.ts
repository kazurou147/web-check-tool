import { toApiError } from '~/server/services/api-errors'
import { useProjectStore } from '~/server/services/project-store'
import { requireProjectId } from '~/server/services/request'

export default defineEventHandler(async (event) => {
  try {
    const store = useProjectStore()
    return { project: await store.view(await store.setArchived(requireProjectId(event), false)) }
  } catch (error) {
    return toApiError(error)
  }
})
