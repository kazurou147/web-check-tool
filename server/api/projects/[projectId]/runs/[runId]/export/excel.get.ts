import { toApiError } from '~/server/services/api-errors'
import { reportDownloadName } from '~/server/services/excel-report-export'
import { ProjectNotFoundError, useProjectStore } from '~/server/services/project-store'
import { requireProjectId, requireRunId } from '~/server/services/request'
import { RunNotFoundError, RunReportNotFoundError } from '~/server/services/run-store'
import { useRunStore } from '~/server/services/run-engine'

export default defineEventHandler(async (event) => {
  const projectId = requireProjectId(event)
  const runId = requireRunId(event)
  try {
    await useProjectStore().get(projectId)
    const bytes = await useRunStore().readReport(projectId, runId)
    setHeader(event, 'Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    setHeader(event, 'Content-Disposition', `attachment; filename="${reportDownloadName(runId)}"`)
    setHeader(event, 'Content-Length', bytes.byteLength)
    setHeader(event, 'Cache-Control', 'no-store')
    return bytes
  } catch (error) {
    if (error instanceof ProjectNotFoundError || error instanceof RunNotFoundError) {
      throw createError({ statusCode: 404, statusMessage: '指定された案件の検査結果が見つかりません' })
    }
    if (error instanceof RunReportNotFoundError) {
      throw createError({ statusCode: 404, statusMessage: error.message })
    }
    return toApiError(error)
  }
})
