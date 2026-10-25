import { toApiError } from '~/server/services/api-errors'
import { ProjectNotFoundError, useProjectStore } from '~/server/services/project-store'
import { buildResultJsonExport, ResultExportTooLargeError, resultJsonDownloadName } from '~/server/services/result-json-export'
import { requireProjectId, requireRunId } from '~/server/services/request'
import { useRunStore } from '~/server/services/run-engine'
import { RunNotFoundError } from '~/server/services/run-store'

export default defineEventHandler(async (event) => {
  const projectId = requireProjectId(event)
  const runId = requireRunId(event)
  try {
    await useProjectStore().get(projectId)
    const bytes = await buildResultJsonExport(useRunStore(), projectId, runId)
    setHeader(event, 'Content-Type', 'application/json; charset=utf-8')
    setHeader(event, 'Content-Disposition', `attachment; filename="${resultJsonDownloadName(runId)}"`)
    setHeader(event, 'Content-Length', bytes.byteLength)
    setHeader(event, 'Cache-Control', 'no-store')
    setHeader(event, 'X-Content-Type-Options', 'nosniff')
    return bytes
  } catch (error) {
    if (error instanceof ProjectNotFoundError || error instanceof RunNotFoundError) {
      throw createError({ statusCode: 404, statusMessage: '指定された案件の検査結果が見つかりません' })
    }
    if (error instanceof ResultExportTooLargeError) {
      throw createError({ statusCode: 413, statusMessage: error.message })
    }
    return toApiError(error)
  }
})
