import { ZodError } from 'zod'
import { toApiError } from '~/server/services/api-errors'
import { useProjectStore } from '~/server/services/project-store'
import { requireProjectId } from '~/server/services/request'
import { compareRunResults } from '~/server/services/run-comparison'
import { useRunStore } from '~/server/services/run-engine'
import { runComparisonQuerySchema } from '~/server/services/validation'

export default defineEventHandler(async (event) => {
  const projectId = requireProjectId(event)
  setHeader(event, 'Cache-Control', 'no-store')
  try {
    const query = runComparisonQuerySchema.parse(getQuery(event))
    await useProjectStore().get(projectId)
    const [base, target] = await Promise.all([
      useRunStore().get(projectId, query.base),
      useRunStore().get(projectId, query.target),
    ])
    return compareRunResults(base, target, query)
  } catch (error) {
    if (error instanceof ZodError) {
      throw createError({ statusCode: 400, statusMessage: error.issues[0]?.message ?? '比較条件が不正です' })
    }
    return toApiError(error)
  }
})
